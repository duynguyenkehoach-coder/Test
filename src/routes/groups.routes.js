/**
 * Groups Routes — CRUD, stats, bulk import
 */
const router = require('express').Router();

// ── GET /api/groups — List groups with filters ──────────────────────────────
router.get('/api/groups', (req, res) => {
    try {
        const groupDb = require('../ai/agents/groupDiscovery');
        const filters = {
            category: req.query.category || null,
            status: req.query.status || null,
        };
        const groups = groupDb.getGroups(filters);
        res.json({ success: true, data: groups, count: groups.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/groups/stats — Group statistics ────────────────────────────────
router.get('/api/groups/stats', (req, res) => {
    try {
        const groupDb = require('../ai/agents/groupDiscovery');
        const stats = groupDb.getStats();
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/groups — Add new group ────────────────────────────────────────
router.post('/api/groups', (req, res) => {
    try {
        const { name, url, category, notes } = req.body;
        if (!name || !url) return res.status(400).json({ success: false, error: 'Name and URL are required' });

        const groupDb = require('../ai/agents/groupDiscovery');
        const id = groupDb.addGroup({ name, url, category: category || 'uncategorized', notes: notes || '' });
        res.json({ success: true, id, message: 'Group added' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── PATCH /api/groups/:id — Toggle group status ─────────────────────────────
router.patch('/api/groups/:id', (req, res) => {
    try {
        const { status } = req.body;
        const groupDb = require('../ai/agents/groupDiscovery');
        groupDb.updateGroupStatus(parseInt(req.params.id), status);
        res.json({ success: true, message: 'Group status updated' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/groups/bulk — Bulk import groups ──────────────────────────────
router.post('/api/groups/bulk', (req, res) => {
    try {
        const { urls } = req.body;
        if (!urls || typeof urls !== 'string') {
            return res.status(400).json({ success: false, error: 'urls (string) is required' });
        }

        const groupDb = require('../ai/agents/groupDiscovery');
        const lines = urls.split('\n').map(l => l.trim()).filter(l => l.includes('facebook.com/groups/'));
        let added = 0, skipped = 0;

        for (const line of lines) {
            const urlMatch = line.match(/(https?:\/\/(?:www\.)?facebook\.com\/groups\/[^\s?#]+)/);
            if (!urlMatch) { skipped++; continue; }

            const cleanUrl = urlMatch[1].replace(/\/$/, '');
            const slug = cleanUrl.split('/groups/')[1] || 'unknown';

            try {
                groupDb.addGroup({
                    name: slug.replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                    url: cleanUrl,
                    category: 'uncategorized',
                    notes: 'Bulk import',
                });
                added++;
            } catch (e) {
                if (e.message?.includes('UNIQUE')) skipped++;
                else throw e;
            }
        }

        res.json({
            success: true,
            message: `Imported ${added} groups (${skipped} skipped/duplicate)`,
            added, skipped, total: lines.length
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
