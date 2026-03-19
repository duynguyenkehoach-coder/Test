/**
 * 🎯 Strategy API Routes — 3 Marketing Strategies
 * 
 * 1. Expert Reply — AI comment on lead's post
 * 2. Audience Export — CSV for Facebook Ads retargeting
 * 3. Hot Lead Alert — Telegram notification + AI message
 * 
 * @module routes/strategy.routes
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const database = require('../core/data_store/database');

// Lazy-load to avoid circular deps
function getExpertReplier() { return require('../ai/agents/strategies/expertReplier'); }
function getAudienceExporter() { return require('../ai/agents/strategies/audienceExporter'); }
function getHotLeadAlert() { return require('../ai/agents/strategies/hotLeadAlert'); }

// ═══════════════════════════════════════════════════════════════════════════════
// 🏆 STRATEGY 1: Expert Reply
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/strategy/expert-reply/:leadId — Generate AI comment for a lead
router.post('/expert-reply/:leadId', async (req, res) => {
    try {
        const lead = database.getLeadById.get(req.params.leadId);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

        const { staffName = 'Đức Anh' } = req.body;
        const { replyToPost } = getExpertReplier();

        // Draft only (no auto-posting) — sales reviews before sending
        const result = await replyToPost(lead, { staffName });
        res.json({ ok: true, data: result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/strategy/expert-reply-batch — Batch generate for hot leads
router.post('/expert-reply-batch', async (req, res) => {
    try {
        const { staffName = 'Đức Anh', minScore = 70, limit = 5 } = req.body;
        const leads = database.db.prepare(`
            SELECT * FROM leads WHERE score >= ? AND role = 'buyer' AND post_url IS NOT NULL
            AND status NOT IN ('ignored', 'converted') ORDER BY score DESC LIMIT ?
        `).all(minScore, limit);

        res.json({ ok: true, message: `Processing ${leads.length} leads in background`, count: leads.length });

        // Background processing
        const { batchReply } = getExpertReplier();
        batchReply(leads, { staffName }).catch(e =>
            console.error(`[StrategyAPI] ❌ Batch reply error: ${e.message}`)
        );
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🎯 STRATEGY 2: Facebook Custom Audience Export
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/strategy/audience-export — Export leads as CSV
router.post('/audience-export', (req, res) => {
    try {
        const { minScore = 80, language = 'all', category = null, format = 'full' } = req.body;
        const { exportAudience } = getAudienceExporter();

        const result = exportAudience({ minScore, language, category, format });

        if (!result.filePath) {
            return res.json({ ok: true, message: 'No leads found matching criteria', count: 0 });
        }

        res.json({
            ok: true,
            fileName: result.fileName,
            count: result.count,
            downloadUrl: `/api/strategy/audience-download/${result.fileName}`,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/strategy/audience-download/:filename — Download exported CSV
router.get('/audience-download/:filename', (req, res) => {
    try {
        const filePath = path.join(__dirname, '..', '..', 'data', 'exports', req.params.filename);
        if (!require('fs').existsSync(filePath)) {
            return res.status(404).json({ ok: false, error: 'File not found' });
        }
        res.download(filePath, req.params.filename);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/strategy/audience-stats — Audience stats
router.get('/audience-stats', (req, res) => {
    try {
        const { getAudienceStats } = getAudienceExporter();
        const stats = getAudienceStats();
        res.json({ ok: true, data: stats });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ STRATEGY 3: Hot Lead Telegram Alert
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/strategy/hot-alert/:leadId — Send alert for specific lead
router.post('/hot-alert/:leadId', async (req, res) => {
    try {
        const lead = database.getLeadById.get(req.params.leadId);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

        const { staffName = 'Đức Anh' } = req.body;
        const { onHotLeadDetected } = getHotLeadAlert();
        const result = await onHotLeadDetected(lead, { staffName });

        res.json({ ok: true, data: result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/strategy/hot-alert-all — Alert all un-alerted hot leads
router.post('/hot-alert-all', async (req, res) => {
    try {
        const { staffName = 'Đức Anh', minScore = 80, limit = 10 } = req.body;
        const { alertAllHotLeads } = getHotLeadAlert();

        // Return immediately, process in background
        res.json({ ok: true, message: `Alerting hot leads (min score: ${minScore})...` });

        alertAllHotLeads({ staffName, minScore, limit }).then(results => {
            const sent = results.filter(r => r.sent).length;
            console.log(`[StrategyAPI] ✅ Telegram alerts: ${sent}/${results.length} sent`);
        }).catch(e => {
            console.error(`[StrategyAPI] ❌ Batch alert error: ${e.message}`);
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 👀 STRATEGY 2B: Profile Engager (Organic Retargeting — FREE)
// ═══════════════════════════════════════════════════════════════════════════════
function getProfileEngager() { return require('../ai/agents/strategies/profileEngager'); }

// GET /api/strategy/engager-leads — Get leads ready for profile engagement
router.get('/engager-leads', (req, res) => {
    try {
        const { minScore = 70, limit = 15 } = req.query;
        const { getUnengagedLeads } = getProfileEngager();
        const leads = getUnengagedLeads({ minScore: Number(minScore), limit: Number(limit) });
        res.json({
            ok: true,
            data: leads.map(l => ({
                id: l.id,
                author_name: l.author_name,
                author_url: l.author_url,
                score: l.score,
                category: l.category,
                language: l.language,
            })),
            count: leads.length,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/strategy/engager-stats — Engagement stats
router.get('/engager-stats', (req, res) => {
    try {
        const engaged = database.db.prepare(`
            SELECT COUNT(DISTINCT lead_id) as total_engaged FROM outreach_log WHERE channel = 'profile_engage'
        `).get();

        const recent = database.db.prepare(`
            SELECT ol.lead_id, l.author_name, l.score, ol.message as actions, ol.created_at
            FROM outreach_log ol LEFT JOIN leads l ON ol.lead_id = l.id
            WHERE ol.channel = 'profile_engage'
            ORDER BY ol.created_at DESC LIMIT 20
        `).all();

        const actionBreakdown = database.db.prepare(`
            SELECT message, COUNT(*) as c FROM outreach_log WHERE channel = 'profile_engage' GROUP BY message
        `).all();

        res.json({
            ok: true,
            totalEngaged: engaged.total_engaged || 0,
            recentEngagements: recent,
            actionBreakdown,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 Combined Strategy Stats
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/stats', (req, res) => {
    try {
        const outreach = database.db.prepare(`
            SELECT channel, status, COUNT(*) as count FROM outreach_log
            GROUP BY channel, status
        `).all();

        const pipeline = database.db.prepare(`
            SELECT pipeline_stage, COUNT(*) as count FROM leads
            WHERE role = 'buyer' AND status != 'ignored'
            GROUP BY pipeline_stage
        `).all();

        const recent = database.db.prepare(`
            SELECT ol.*, l.author_name, l.score
            FROM outreach_log ol LEFT JOIN leads l ON ol.lead_id = l.id
            ORDER BY ol.created_at DESC LIMIT 15
        `).all();

        res.json({
            ok: true,
            outreach: outreach.reduce((acc, r) => {
                if (!acc[r.channel]) acc[r.channel] = {};
                acc[r.channel][r.status] = r.count;
                return acc;
            }, {}),
            pipeline: Object.fromEntries(pipeline.map(r => [r.pipeline_stage || 'new', r.count])),
            recentActivity: recent,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
