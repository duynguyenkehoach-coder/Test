/**
 * Scan Routes — Keyword scan, group scan, infra health
 */
const router = require('express').Router();
const database = require('../core/data_store/database');
const logger = require('../logger');
const config = require('../config');

// ── POST /api/scan — Trigger keyword scan ───────────────────────────────────
router.post('/api/scan', (req, res) => {
    try {
        database.enqueueScan('KEYWORD_SCAN', {
            platforms: req.body.platforms || ['facebook'],
            manualTrigger: true,
        });
        logger.info('Server', '🔍 Manual keyword scan enqueued');
        res.json({ success: true, message: 'Keyword scan enqueued — worker will process it.' });
    } catch (err) {
        logger.error('Server', 'Manual scan enqueue failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/scan/groups — Group scan (disabled) ───────────────────────────
router.post('/api/scan/groups', async (req, res) => {
    res.json({ success: true, message: 'Group scan disabled — using keyword search instead (saves Apify credit)' });
});

// ── GET /api/scan/next — Next scan time ─────────────────────────────────────
router.get('/api/scan/next', (req, res) => {
    try {
        const parser = require('cron-parser');
        const schedule = config.SCAN_CRON || '*/10 * * * *';
        const interval = parser.parseExpression(schedule);
        res.json({
            success: true,
            next: interval.next().toISOString(),
            schedule,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/scan/queue — Scan queue status ─────────────────────────────────
router.get('/api/scan/queue', (req, res) => {
    try {
        const queueStats = database.getScanQueueStatus();
        const running = database.db.prepare(`SELECT * FROM scan_queue WHERE status = 'RUNNING' LIMIT 1`).get();
        const recent = database.db.prepare(`SELECT id, job_type, status, created_at, started_at, finished_at FROM scan_queue ORDER BY id DESC LIMIT 10`).all();
        res.json({ success: true, queue: queueStats, running: running || null, recent });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/infra/health — Infrastructure health check ─────────────────────
router.get('/api/infra/health', async (req, res) => {
    try {
        const infraAgent = require('../infra/proxy/infraAgent');
        const result = await infraAgent.runHealthCheck();
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/infra/proxies — Add proxies to pool ───────────────────────────
router.post('/api/infra/proxies', async (req, res) => {
    try {
        const { urls, provider, region } = req.body;
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ success: false, error: 'urls array required' });
        }
        const infraAgent = require('../infra/proxy/infraAgent');
        const pool = await infraAgent.addProxies(urls, { provider, region });
        res.json({
            success: true,
            added: urls.length,
            pool: {
                active: pool.data.active_proxies.length,
                proxies: pool.data.active_proxies.map(p => ({
                    url: p.url, latency: p.latency, provider: p.provider,
                })),
                blacklisted: pool.data.blacklisted_proxies.length,
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
