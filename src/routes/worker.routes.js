/**
 * Worker Routes — Job polling, CrawBot import
 */
const router = require('express').Router();
const express = require('express');
const database = require('../core/data_store/database');

const WORKER_AUTH_KEY = process.env.WORKER_AUTH_KEY || 'thg_worker_2026';

// ── POST /api/leads/collect — Receive leads from remote workers ─────────────
router.post('/api/leads/collect', (req, res) => {
    const clientKey = req.headers['x-thg-auth-key'];
    if (clientKey !== WORKER_AUTH_KEY) {
        console.warn(`[Hub] 🚫 Unauthorized worker from ${req.ip}`);
        return res.status(401).json({ success: false, error: 'Invalid worker key' });
    }

    try {
        const posts = req.body.posts || req.body.data || [];
        if (!Array.isArray(posts) || posts.length === 0) {
            return res.status(400).json({ success: false, error: 'No posts provided' });
        }

        let saved = 0;
        for (const post of posts) {
            try {
                database.insertLead.run({
                    platform: post.platform || 'facebook',
                    author_name: post.authorName || post.author_name || 'Unknown',
                    author_url: post.authorUrl || post.author_url || '',
                    post_url: post.url || post.post_url || '',
                    content: post.text || post.content || '',
                    score: post.score || 0,
                    category: post.category || 'uncategorised',
                    urgency: post.urgency || 'low',
                    summary: post.summary || '',
                    suggested_response: post.suggested_response || '',
                    group_name: post.groupName || post.group_name || '',
                    post_created_at: post.postedAt || post.post_created_at || new Date().toISOString(),
                });
                saved++;
            } catch (e) {
                if (!e.message?.includes('UNIQUE')) console.warn(`[Hub] ⚠️ Insert error: ${e.message}`);
            }
        }

        console.log(`[Hub] 📥 Received ${posts.length} posts from worker (saved: ${saved})`);
        res.json({ success: true, received: posts.length, saved });
    } catch (err) {
        console.error(`[Hub] ❌ Collect error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/worker/jobs — Laptop polls for pending scan jobs ────────────────
router.get('/api/worker/jobs', (req, res) => {
    if (req.headers['x-thg-auth-key'] !== WORKER_AUTH_KEY) {
        return res.status(401).json({ success: false, error: 'Invalid worker key' });
    }
    try {
        const job = database.claimNextScan();
        if (!job) return res.json({ success: true, job: null });
        console.log(`[Hub] 🔧 Worker claimed job #${job.id} (${job.job_type})`);
        res.json({ success: true, job });
    } catch (err) {
        console.error(`[Hub] ❌ Job poll error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/worker/jobs/:id/complete — Worker reports job completion ───────
router.post('/api/worker/jobs/:id/complete', express.json({ limit: '10mb' }), (req, res) => {
    if (req.headers['x-thg-auth-key'] !== WORKER_AUTH_KEY) {
        return res.status(401).json({ success: false, error: 'Invalid worker key' });
    }
    try {
        const jobId = parseInt(req.params.id);
        const { status, result, error, posts } = req.body;

        if (status === 'error') {
            database.failScan(jobId, error || 'Unknown error');
            console.log(`[Hub] ❌ Worker reported job #${jobId} failed: ${error}`);
        } else {
            database.completeScan(jobId, result || {});
            console.log(`[Hub] ✅ Worker completed job #${jobId}`);
        }

        let saved = 0;
        if (Array.isArray(posts) && posts.length > 0) {
            for (const post of posts) {
                try {
                    database.insertLead.run({
                        platform: post.platform || 'facebook',
                        author_name: post.author_name || 'Unknown',
                        author_url: post.author_url || '',
                        post_url: post.post_url || post.url || '',
                        content: post.content || '',
                        score: post.score || 0,
                        category: post.category || 'uncategorised',
                        urgency: post.urgency || 'low',
                        summary: post.summary || '',
                        suggested_response: post.suggested_response || '',
                        group_name: post.group_name || '',
                        role: post.role || 'buyer',
                        buyer_signals: post.buyer_signals || '',
                        language: post.language || 'foreign',
                        pain_score: post.pain_score || 0,
                        spam_score: post.spam_score || post.spamScore || 0,
                        item_type: post.item_type || 'post',
                    });
                    saved++;
                } catch (e) {
                    if (!e.message?.includes('UNIQUE')) console.warn(`[Hub] ⚠️ Insert error: ${e.message}`);
                }
            }
            if (saved > 0) database.invalidateStatsCache();
            console.log(`[Hub] 📥 Saved ${saved}/${posts.length} leads from worker`);
        }

        res.json({ success: true, saved });
    } catch (err) {
        console.error(`[Hub] ❌ Complete error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── CrawBot v2 Import ───────────────────────────────────────────────────────
try {
    function normalize(raw) {
        return {
            url: raw.url || raw.post_url || '',
            author: raw.author || raw.author_name || 'Unknown',
            author_url: raw.author_url || raw.authorUrl || '',
            content: raw.content || raw.text || '',
            platform: raw.platform || 'facebook',
            group_name: raw.group_name || raw.groupName || '',
            scraped_at: raw.scraped_at || new Date().toISOString(),
        };
    }

    // POST /api/import/crawbot — JSON webhook
    router.post('/api/import/crawbot', (req, res) => {
        const rawPosts = req.body.posts || req.body.data || [];
        if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
            return res.status(400).json({ ok: false, error: 'No posts provided' });
        }

        let enqueued = 0, duplicates = 0, invalid = 0;
        const insertStmt = database.db.prepare(`
            INSERT OR IGNORE INTO raw_leads (url, author, author_url, content, platform, group_name, scraped_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const raw of rawPosts) {
            const p = normalize(raw);
            if (!p.content || p.content.trim().length < 15) { invalid++; continue; }
            if (!p.url) { invalid++; continue; }
            const r = insertStmt.run(p.url, p.author, p.author_url, p.content, p.platform, p.group_name, p.scraped_at);
            if (r.changes > 0) enqueued++;
            else duplicates++;
        }

        res.json({ ok: true, enqueued, duplicates, invalid, total: rawPosts.length });
    });

    // GET /api/import/crawbot/status — Queue stats
    router.get('/api/import/crawbot/status', (req, res) => {
        const stats = database.db.prepare(`
            SELECT status, COUNT(*) as count FROM raw_leads GROUP BY status
        `).all();
        const recentQualified = database.db.prepare(`
            SELECT author, score, assigned_to, url FROM raw_leads
            WHERE status='QUALIFIED' ORDER BY id DESC LIMIT 10
        `).all();
        res.json({ ok: true, queue: stats, recentQualified });
    });

    console.log('[Routes] ✅ CrawBot v2 import loaded');
} catch (e) {
    console.warn('[Routes] ⚠️ CrawBot import skipped:', e.message);
}

module.exports = router;
