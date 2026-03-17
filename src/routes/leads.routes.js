/**
 * Leads Routes — CRUD, export, feedback, close deal
 */
const router = require('express').Router();
const database = require('../core/data_store/database');
const logger = require('../logger');
const memoryStore = require('../ai/agents/memoryStore');

// ── Helper ───────────────────────────────────────────────────────────────────
function csvEscape(text) {
    if (!text) return '';
    const escaped = String(text).replace(/"/g, '""');
    if (escaped.includes(',') || escaped.includes('\n') || escaped.includes('"')) {
        return `"${escaped}"`;
    }
    return escaped;
}

// ── GET /api/leads — List leads with filters ─────────────────────────────────
router.get('/api/leads', (req, res) => {
    try {
        const filters = {
            platform: req.query.platform || null,
            category: req.query.category || null,
            status: req.query.status || null,
            language: req.query.language || null,
            exclude_ignored: req.query.exclude_ignored === 'true',
            minScore: req.query.minScore ? parseInt(req.query.minScore) : null,
            search: req.query.search || null,
            dateFrom: req.query.dateFrom || null,
            dateTo: req.query.dateTo || null,
            limit: req.query.limit ? parseInt(req.query.limit) : 100,
            offset: req.query.offset ? parseInt(req.query.offset) : 0,
        };
        const leads = database.getLeads(filters);
        res.json({ success: true, data: leads, count: leads.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/leads/export — CSV export ───────────────────────────────────────
router.get('/api/leads/export', (req, res) => {
    try {
        const leads = database.db.prepare(`
            SELECT id, platform, author_name, author_url, post_url, content,
                   score, category, urgency, summary, suggested_response, status, created_at, post_created_at
            FROM leads ORDER BY created_at DESC
        `).all();

        const headers = ['ID', 'Platform', 'Author', 'Author URL', 'Post URL', 'Content', 'Score', 'Category', 'Urgency', 'Summary', 'Suggested Response', 'Status', 'Scraped At', 'Post Created At'];
        const csvRows = [headers.join(',')];

        for (const lead of leads) {
            csvRows.push([
                lead.id, lead.platform, csvEscape(lead.author_name),
                lead.author_url || '', lead.post_url || '', csvEscape(lead.content),
                lead.score, lead.category, lead.urgency,
                csvEscape(lead.summary), csvEscape(lead.suggested_response),
                lead.status, lead.created_at, lead.post_created_at || lead.created_at
            ].join(','));
        }

        const filename = `thg_leads_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + csvRows.join('\n'));
    } catch (err) {
        logger.error('Server', 'CSV export failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/leads/:id — Get single lead ─────────────────────────────────────
router.get('/api/leads/:id', (req, res) => {
    try {
        const lead = database.getLeadById.get(parseInt(req.params.id));
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        res.json({ success: true, data: lead });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── PATCH /api/leads/:id — Update lead + Claim & Lock ────────────────────────
router.patch('/api/leads/:id', (req, res) => {
    try {
        const { id } = req.params;
        const ALLOWED = ['assigned_to', 'claimed_by', 'claimed_at', 'status', 'notes', 'suggested_response', 'category', 'language'];
        const updates = Object.fromEntries(
            Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
        );
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ ok: false, error: 'No valid fields' });
        }

        // ═══ MULTI-SALES CLAIM LOGIC ═══
        let claimAction = null;
        let actionStaff = req.body.action_staff;

        if (updates.claimed_by !== undefined) {
            const current = database.db.prepare('SELECT claimed_by FROM leads WHERE id = ?').get(id);
            const oldStaffArr = (current?.claimed_by || '').split(',').map(s => s.trim()).filter(Boolean);

            if (updates.claimed_by === '') {
                // Unclaim by action_staff or clear all
                if (actionStaff && oldStaffArr.includes(actionStaff)) {
                    const newArr = oldStaffArr.filter(s => s !== actionStaff);
                    updates.claimed_by = newArr.join(', ');
                    if (newArr.length === 0) updates.claimed_at = null;
                    claimAction = 'UNCLAIM';
                } else {
                    updates.claimed_by = '';
                    updates.claimed_at = null;
                    claimAction = 'UNCLAIM';
                    actionStaff = actionStaff || oldStaffArr[0] || 'unknown';
                }
            } else {
                // Claim — append staff to list
                const newStaff = updates.claimed_by.split(',').map(s => s.trim()).filter(Boolean);
                const merged = [...new Set([...oldStaffArr, ...newStaff])];
                updates.claimed_by = merged.join(', ');
                if (!updates.claimed_at) updates.claimed_at = new Date().toISOString();
                claimAction = 'CLAIM';
                actionStaff = actionStaff || newStaff[0] || 'unknown';
            }
        }

        const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
        database.db.prepare(`UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
            .run({ ...updates, id });
        const lead = database.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

        // Auto-train Agent when status changes
        if (lead && lead.content && updates.status) {
            if (updates.status === 'ignored') {
                memoryStore.saveFeedbackByContent(lead.content, {
                    type: 'wrong', correct_role: 'irrelevant',
                    note: 'Sale marked as ignore', platform: lead.platform,
                });
            } else if (updates.status === 'contacted' || updates.status === 'converted') {
                memoryStore.saveFeedbackByContent(lead.content, {
                    type: 'correct', correct_role: 'buyer',
                    note: `Sale changed status to ${updates.status}`, platform: lead.platform,
                });
            }
        }

        // Log claim action
        if (claimAction && actionStaff) {
            try {
                database.db.prepare(
                    `INSERT INTO staff_activity_log (lead_id, staff_name, action_type, note) VALUES (?, ?, ?, ?)`
                ).run(id, actionStaff, claimAction, `${claimAction === 'CLAIM' ? 'Tham gia tiếp nhận' : 'Nhả'} lead #${id}`);
            } catch (e) { /* ignore logging errors */ }
        }

        if (updates.status === 'contacted' && lead?.claimed_by) {
            const primaryStaff = lead.claimed_by.split(',')[0].trim();
            if (primaryStaff) {
                try {
                    database.db.prepare(
                        `INSERT INTO staff_activity_log (lead_id, staff_name, action_type, note) VALUES (?, ?, 'CONTACT', ?)`
                    ).run(id, primaryStaff, `Contacted lead #${id}`);
                } catch (e) { /* ignore */ }
            }
        }

        res.json({ ok: true, ...lead });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── DELETE /api/leads/:id — Delete single lead ───────────────────────────────
router.delete('/api/leads/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        database.db.prepare('DELETE FROM leads WHERE id = ?').run(id);
        res.json({ success: true, message: `Lead #${id} deleted` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── DELETE /api/leads — Delete all leads ─────────────────────────────────────
router.delete('/api/leads', (req, res) => {
    try {
        if (req.query.confirm !== 'true') {
            return res.status(400).json({ success: false, error: 'Add ?confirm=true to confirm deletion' });
        }
        database.db.prepare('DELETE FROM leads').run();
        database.invalidateStatsCache();
        res.json({ success: true, message: 'All leads deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/leads/:id/feedback — Human feedback ───────────────────────────
router.post('/api/leads/:id/feedback', (req, res) => {
    try {
        const leadId = parseInt(req.params.id);
        const { type, correct_role, correct_score, note } = req.body;

        if (!type || !['correct', 'wrong', 'upgrade', 'downgrade', 'text_feedback'].includes(type)) {
            return res.status(400).json({ error: 'Invalid feedback type' });
        }

        const lead = database.db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        const feedbackPayload = {
            type,
            correct_role: correct_role || null,
            correct_score: correct_score || null,
            note: note || '',
            platform: lead?.platform || 'unknown',
        };

        let success = false;
        if (lead && lead.content) {
            success = memoryStore.saveFeedbackByContent(lead.content, feedbackPayload);
        } else {
            success = memoryStore.saveFeedback(leadId, feedbackPayload);
            logger.warn('Agent', `Lead #${leadId} not found — feedback saved by ID (may not match memory)`);
        }

        if (success) {
            res.json({ ok: true, message: `Feedback '${type}' saved for lead #${leadId}` });
        } else {
            res.status(500).json({ error: 'Failed to save feedback' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/leads/:id/close — Close deal ──────────────────────────────────
router.post('/api/leads/:id/close', (req, res) => {
    try {
        const { id } = req.params;
        const { winner_staff, deal_value, note } = req.body;

        if (!winner_staff) return res.status(400).json({ ok: false, error: 'winner_staff required' });

        database.db.prepare(`
            UPDATE leads SET status = 'converted', winner_staff = ?, deal_value = ?,
            notes = COALESCE(notes,'') || '\n🏆 ' || ?, closed_at = datetime('now')
            WHERE id = ?
        `).run(winner_staff, deal_value || 0, note || `Closed by ${winner_staff}`, id);

        const lead = database.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

        // Train AI
        if (lead && lead.content) {
            memoryStore.saveFeedbackByContent(lead.content, {
                type: 'correct', correct_role: 'buyer',
                note: `Deal closed by ${winner_staff} — $${deal_value || 0}`, platform: lead.platform,
            });
        }

        // ═══ AWARD LEADERBOARD POINTS ═══
        try {
            database.awardPoints(winner_staff, 'CLOSE_DEAL', 100, {
                dealValue: deal_value || 0,
                leadId: parseInt(id, 10),
                note: note || `Deal closed — $${deal_value || 0}`,
            });
        } catch (e) {
            logger.warn('Sales', `Points award failed for ${winner_staff}: ${e.message}`);
        }

        logger.info('Sales', `🏆 ${winner_staff} closed deal #${id} — $${deal_value || 0}`);
        res.json({ ok: true, message: `🏆 ${winner_staff} chốt đơn thành công!`, lead });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
