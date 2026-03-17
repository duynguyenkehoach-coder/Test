/**
 * Data & Files Routes
 */
const router = require('express').Router();
const { listDataFiles, readDataFile, cleanOldData } = require('../core/data_store/fileManager');

// ── GET /api/data-files — List archive files ────────────────────────────────
router.get('/api/data-files', (req, res) => {
    try {
        const files = listDataFiles();
        res.json({ success: true, data: files, count: files.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/data-files/:filename — Read specific file ──────────────────────
router.get('/api/data-files/:filename', (req, res) => {
    try {
        const content = readDataFile(req.params.filename);
        res.json({ success: true, data: content });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/data-files/cleanup — Clean old data ───────────────────────────
router.post('/api/data-files/cleanup', (req, res) => {
    try {
        const deleted = cleanOldData();
        res.json({ success: true, deleted });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
