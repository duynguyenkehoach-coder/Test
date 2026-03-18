/**
 * 📤 Outreach API Routes
 * 
 * Endpoints for AI-powered lead outreach:
 * - Generate personalized DMs, comments, follow-ups
 * - Log outreach history
 * - Batch generate for multiple leads
 * 
 * @module routes/outreach.routes
 */
const express = require('express');
const router = express.Router();
const database = require('../core/data_store/database');
const { generateDM, generateComment, generateFollowUp, batchGenerate } = require('../ai/outreachGenerator');

// ─── POST /api/leads/:id/generate-outreach ───────────────────────────────────
// Generate AI outreach message for a specific lead
router.post('/api/leads/:id/generate-outreach', async (req, res) => {
    try {
        const lead = database.getLeadById.get(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

        const { staffName = 'Trang', tone = 'friendly', type = 'dm' } = req.body;

        let result;
        if (type === 'comment') {
            result = await generateComment(lead, { staffName });
        } else {
            result = await generateDM(lead, { staffName, tone });
        }

        // Save draft to outreach_log
        try {
            database.db.prepare(`
                INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status)
                VALUES (?, ?, ?, ?, 1, 'draft')
            `).run(lead.id, staffName, type === 'comment' ? 'comment' : 'messenger', result.message);
        } catch (e) {
            console.error(`[OutreachAPI] ⚠️ Log save failed: ${e.message}`);
        }

        res.json({ ok: true, data: result });
    } catch (e) {
        console.error(`[OutreachAPI] ❌ Generate error: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── POST /api/leads/:id/generate-followup ───────────────────────────────────
// Generate follow-up message for a lead already contacted
router.post('/api/leads/:id/generate-followup', async (req, res) => {
    try {
        const lead = database.getLeadById.get(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

        const { staffName = 'Trang', previousMessage = '' } = req.body;
        const result = await generateFollowUp(lead, previousMessage, { staffName });

        // Save to outreach_log
        try {
            database.db.prepare(`
                INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status)
                VALUES (?, ?, 'messenger', ?, 1, 'draft')
            `).run(lead.id, staffName, result.message);
        } catch (e) { /* silent */ }

        res.json({ ok: true, data: result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── POST /api/leads/:id/log-outreach ────────────────────────────────────────
// Manually log that an outreach message was sent
router.post('/api/leads/:id/log-outreach', (req, res) => {
    try {
        const { staffName, channel = 'messenger', message, status = 'sent' } = req.body;
        if (!staffName || !message) {
            return res.status(400).json({ ok: false, error: 'staffName and message required' });
        }

        database.db.prepare(`
            INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status, sent_at)
            VALUES (?, ?, ?, ?, 0, ?, datetime('now'))
        `).run(req.params.id, staffName, channel, message, status);

        // Update lead pipeline stage
        database.db.prepare(`
            UPDATE leads SET pipeline_stage = 'contacted', status = 'contacted',
            contacted_at = COALESCE(contacted_at, datetime('now')), updated_at = datetime('now')
            WHERE id = ?
        `).run(req.params.id);
        database.invalidateStatsCache();

        res.json({ ok: true, message: 'Outreach logged' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── GET /api/leads/:id/outreach-history ─────────────────────────────────────
// Get all outreach history for a lead
router.get('/api/leads/:id/outreach-history', (req, res) => {
    try {
        const history = database.db.prepare(`
            SELECT * FROM outreach_log WHERE lead_id = ? ORDER BY created_at DESC
        `).all(req.params.id);
        res.json({ ok: true, data: history, count: history.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── POST /api/outreach/batch-generate ───────────────────────────────────────
// Generate outreach messages for multiple leads
router.post('/api/outreach/batch-generate', async (req, res) => {
    try {
        const { leadIds = [], staffName = 'Trang', tone = 'friendly' } = req.body;
        if (!leadIds.length) {
            return res.status(400).json({ ok: false, error: 'leadIds array required' });
        }

        const MAX_BATCH = 20;
        const ids = leadIds.slice(0, MAX_BATCH);
        const leads = ids.map(id => database.getLeadById.get(id)).filter(Boolean);

        // Run in background — return immediately
        res.json({ ok: true, message: `Generating ${leads.length} messages in background`, count: leads.length });

        const results = await batchGenerate(leads, { staffName, tone });

        // Save all to outreach_log
        for (const r of results) {
            if (r.message) {
                try {
                    database.db.prepare(`
                        INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status)
                        VALUES (?, ?, 'messenger', ?, 1, 'draft')
                    `).run(r.leadId, staffName, r.message);
                } catch { /* ignore */ }
            }
        }

        console.log(`[OutreachAPI] ✅ Batch complete: ${results.filter(r => r.message).length}/${leads.length} succeeded`);
    } catch (e) {
        console.error(`[OutreachAPI] ❌ Batch error: ${e.message}`);
    }
});

// ─── GET /api/outreach/stats ─────────────────────────────────────────────────
// Outreach performance stats
router.get('/api/outreach/stats', (req, res) => {
    try {
        const total = database.db.prepare('SELECT COUNT(*) as c FROM outreach_log').get();
        const byStatus = database.db.prepare(`
            SELECT status, COUNT(*) as count FROM outreach_log GROUP BY status
        `).all();
        const byStaff = database.db.prepare(`
            SELECT staff_name, COUNT(*) as count FROM outreach_log GROUP BY staff_name ORDER BY count DESC
        `).all();
        const recent = database.db.prepare(`
            SELECT ol.*, l.author_name, l.score, l.category
            FROM outreach_log ol LEFT JOIN leads l ON ol.lead_id = l.id
            ORDER BY ol.created_at DESC LIMIT 10
        `).all();

        res.json({
            ok: true,
            total: total.c,
            byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
            byStaff: Object.fromEntries(byStaff.map(r => [r.staff_name, r.count])),
            recent,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── PATCH /api/leads/:id/pipeline ───────────────────────────────────────────
// Update lead pipeline stage
router.patch('/api/leads/:id/pipeline', (req, res) => {
    try {
        const { stage } = req.body;
        const valid = ['new', 'contacted', 'interested', 'negotiating', 'won', 'lost'];
        if (!valid.includes(stage)) {
            return res.status(400).json({ ok: false, error: `Invalid stage. Must be: ${valid.join(', ')}` });
        }

        database.db.prepare(`
            UPDATE leads SET pipeline_stage = ?, updated_at = datetime('now') WHERE id = ?
        `).run(stage, req.params.id);
        database.invalidateStatsCache();

        res.json({ ok: true, stage });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
