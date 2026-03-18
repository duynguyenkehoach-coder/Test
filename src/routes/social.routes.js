/**
 * 🔌 Social Agent API Routes
 * 
 * Endpoints to control the Social Agent:
 * - POST /api/social/start — Start the agent loop
 * - POST /api/social/stop — Stop the agent loop
 * - GET  /api/social/status — Current status
 * - GET  /api/social/logs — Activity log
 * - POST /api/social/run-once — Run a single session manually
 * 
 * @module routes/social.routes
 */
const express = require('express');
const router = express.Router();

// Lazy-load to avoid circular deps
let socialAgent = null;
function getAgent() {
    if (!socialAgent) socialAgent = require('../agent/social/socialAgent');
    return socialAgent;
}

// ─── POST /api/social/start ──────────────────────────────────────────────────
router.post('/start', (req, res) => {
    try {
        const agent = getAgent();
        const status = agent.getStatus();
        if (status.running) {
            return res.json({ ok: true, message: 'Social Agent is already running', status });
        }
        agent.start();
        res.json({ ok: true, message: 'Social Agent started', status: agent.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── POST /api/social/stop ───────────────────────────────────────────────────
router.post('/stop', async (req, res) => {
    try {
        const agent = getAgent();
        await agent.stop();
        res.json({ ok: true, message: 'Social Agent stopped', status: agent.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── GET /api/social/status ──────────────────────────────────────────────────
router.get('/status', (req, res) => {
    try {
        const agent = getAgent();
        res.json({ ok: true, ...agent.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── GET /api/social/logs ────────────────────────────────────────────────────
router.get('/logs', (req, res) => {
    try {
        const agent = getAgent();
        const limit = parseInt(req.query.limit) || 50;
        const logs = agent.getActivityLog(limit);
        res.json({ ok: true, data: logs, count: logs.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── POST /api/social/run-once ───────────────────────────────────────────────
router.post('/run-once', async (req, res) => {
    try {
        const agent = getAgent();
        res.json({ ok: true, message: 'Single session triggered (running in background)' });
        // Run async — don't block the response
        agent.runSession().catch(e => {
            console.error(`[SocialAPI] Run-once error: ${e.message}`);
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
