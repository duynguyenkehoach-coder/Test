/**
 * Stats & Health Routes
 */
const router = require('express').Router();
const database = require('../core/data_store/database');

const startTime = Date.now();

function formatUptime(ms) {
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000) % 24;
    const d = Math.floor(ms / 86400000);
    return `${d}d ${h}h ${m}m ${s}s`;
}

// ── GET /health ──────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
    try {
        const dbStats = database.db.prepare('SELECT COUNT(*) as leads FROM leads').get();
        const convStats = database.db.prepare('SELECT COUNT(*) as convs FROM conversations').get();
        const lastScan = database.db.prepare('SELECT finished_at FROM scan_logs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();

        res.json({
            status: 'ok',
            uptime: Math.floor((Date.now() - startTime) / 1000),
            uptimeHuman: formatUptime(Date.now() - startTime),
            version: require('../../package.json').version,
            db: {
                leads: dbStats.leads,
                conversations: convStats.convs,
            },
            lastScan: lastScan ? lastScan.created_at : null,
            memory: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
                heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            },
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ── GET /api/stats — Dashboard stats bar ─────────────────────────────────────
router.get('/api/stats', (req, res) => {
    try {
        const total = database.db.prepare("SELECT COUNT(*) as c FROM leads WHERE role = 'buyer'").get();
        const totalViet = database.db.prepare("SELECT COUNT(*) as c FROM leads WHERE role = 'buyer' AND language = 'vietnamese'").get();
        const totalForeign = database.db.prepare("SELECT COUNT(*) as c FROM leads WHERE role = 'buyer' AND language = 'foreign'").get();
        const highValue = database.db.prepare("SELECT COUNT(*) as c FROM leads WHERE role = 'buyer' AND score >= 80").get();
        const avgScoreRow = database.db.prepare("SELECT ROUND(AVG(score),0) as avg FROM leads WHERE role = 'buyer' AND score > 0").get();
        const today = database.db.prepare("SELECT COUNT(*) as c FROM leads WHERE role = 'buyer' AND created_at >= date('now', 'start of day')").get();
        const pending = database.db.prepare("SELECT COUNT(*) as c FROM conversations WHERE status = 'pending'").get() || { c: 0 };
        const platforms = database.db.prepare("SELECT platform, COUNT(*) as c FROM leads WHERE role = 'buyer' GROUP BY platform").all();
        const byStatus = database.db.prepare("SELECT status, COUNT(*) as c FROM leads WHERE role = 'buyer' GROUP BY status").all();
        const byCategory = database.db.prepare("SELECT category, COUNT(*) as c FROM leads WHERE role = 'buyer' GROUP BY category").all();

        const byPlatform = {};
        platforms.forEach(p => { byPlatform[p.platform] = p.c; });
        const platParts = platforms.map(p => `${p.platform ? p.platform.toUpperCase().slice(0, 2) : '??'}: ${p.c}`).join(' | ');

        const statusMap = {};
        byStatus.forEach(s => { statusMap[s.status] = s.c; });
        const catMap = {};
        byCategory.forEach(c => { catMap[c.category] = c.c; });

        res.json({
            success: true,
            data: {
                total: total.c,
                totalViet: totalViet.c,
                totalForeign: totalForeign.c,
                highValue: highValue.c,
                avgScore: avgScoreRow?.avg || 0,
                today: today.c,
                pending: pending.c,
                platformCount: platforms.length,
                platformDetail: platParts || 'N/A',
                byStatus: statusMap,
                byPlatform: byPlatform,
                byCategory: catMap,
            },
        });
    } catch (err) {
        console.error('[Stats] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
