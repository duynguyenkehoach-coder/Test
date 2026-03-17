/**
 * Leaderboard & Points Routes
 */
const router = require('express').Router();
const express = require('express');
const database = require('../core/data_store/database');

// ── GET /api/leaderboard — Full rankings + recent activity ──────────────────
router.get('/api/leaderboard', (req, res) => {
    try {
        const data = database.getLeaderboard();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/leaderboard/log — Recent activity feed ─────────────────────────
router.get('/api/leaderboard/log', (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
        const data = database.getPointsLog(limit);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/points/award — Award points to sales ──────────────────────────
router.post('/api/points/award', express.json(), (req, res) => {
    try {
        const { sales_name, action_type, points, deal_value = 0, lead_id = 0, note = '' } = req.body;
        if (!sales_name || !action_type || points == null) {
            return res.status(400).json({ success: false, error: 'Missing required fields: sales_name, action_type, points' });
        }

        let totalPoints = parseInt(points, 10);
        if (action_type === 'CLOSE_DEAL' && deal_value > 0) {
            totalPoints += Math.floor(deal_value * 0.002);
        }

        const result = database.awardPoints(sales_name, action_type, totalPoints, { dealValue: deal_value, leadId: lead_id, note });

        if (action_type === 'CLOSE_DEAL' && lead_id) {
            try {
                database.db.prepare(`
                    UPDATE leads SET winner_staff = ?, deal_value = ?, closed_at = datetime('now'), status = 'converted'
                    WHERE id = ?
                `).run(sales_name, deal_value, lead_id);
            } catch (_) { }
        }

        res.json({ success: true, result, totalPoints });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/staff/stats — Staff activity stats ─────────────────────────────
router.get('/api/staff/stats', (req, res) => {
    try {
        const stats = database.db.prepare(`
            SELECT
                staff_name,
                COUNT(CASE WHEN action_type = 'CLAIM' THEN 1 END) as claims,
                COUNT(CASE WHEN action_type = 'CONTACT' THEN 1 END) as contacts,
                COUNT(CASE WHEN action_type = 'CLOSE_DEAL' THEN 1 END) as deals,
                MAX(created_at) as last_active
            FROM staff_activity_log
            GROUP BY staff_name
            ORDER BY deals DESC, claims DESC
        `).all();
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
