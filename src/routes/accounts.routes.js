/**
 * Accounts Routes — FB account pool management
 */
const router = require('express').Router();
const database = require('../core/data_store/database');

try {
    const accountManager = require('../ai/agents/accountManager');

    // GET /api/accounts — Pool status
    router.get('/api/accounts', (req, res) => {
        try {
            const pool = accountManager.getPoolStatus();
            res.json({ success: true, accounts: pool, total: pool.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/accounts — Add new account
    router.post('/api/accounts', (req, res) => {
        const { email, password, proxy_url, notes } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'email và password là bắt buộc' });
        }
        try {
            const id = accountManager.addAccount({ email, password, proxyUrl: proxy_url || '', notes: notes || '' });
            res.json({ success: true, id, message: `✅ Đã thêm tài khoản ${email}` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // PATCH /api/accounts/:email/reset — Reset account
    router.patch('/api/accounts/:email/reset', (req, res) => {
        try {
            accountManager.resetAccount(req.params.email);
            res.json({ success: true, message: `✅ Reset ${req.params.email} → active, trust=70` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // PATCH /api/accounts/:email/proxy — Assign proxy
    router.patch('/api/accounts/:email/proxy', (req, res) => {
        const { proxy_url } = req.body || {};
        try {
            database.db.prepare(`UPDATE fb_accounts SET proxy_url=? WHERE email=?`).run(proxy_url || '', req.params.email);
            res.json({ success: true, message: `✅ Proxy của ${req.params.email} đã được cập nhật` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // DELETE /api/accounts/:email — Ban account
    router.delete('/api/accounts/:email', (req, res) => {
        try {
            database.db.prepare(`UPDATE fb_accounts SET status='banned' WHERE email=?`).run(req.params.email);
            res.json({ success: true, message: `🚫 ${req.params.email} đã bị loại khỏi pool` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    console.log('[Routes] ✅ Account Manager routes loaded');
} catch (e) {
    console.warn('[Routes] ⚠️ Account Manager routes skipped:', e.message);
}

module.exports = router;
