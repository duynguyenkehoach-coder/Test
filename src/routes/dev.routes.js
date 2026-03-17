/**
 * Dev Console Routes — Log viewer, dev dashboard
 */
const router = require('express').Router();
const path = require('path');

const DEV_PASSWORD = process.env.DEV_PASSWORD || 'thg@dev2024';

// Access to logBuffer via shared reference
let logBuffer = [];
function setLogBuffer(buf) { logBuffer = buf; }

// ── GET /api/dev/logs — Password-protected log viewer ───────────────────────
router.get('/api/dev/logs', (req, res) => {
    const pw = req.query.password || req.headers['x-dev-password'];
    if (pw !== DEV_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized — wrong password' });
    }
    const level = req.query.level || '';
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    let logs = logBuffer;
    if (level) logs = logs.filter(l => l.level === level);
    res.json({ success: true, total: logs.length, data: logs.slice(-limit) });
});

// ── GET /dev — Dev console HTML page ────────────────────────────────────────
router.get('/dev', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'dev.html'));
});

module.exports = router;
module.exports.setLogBuffer = setLogBuffer;
