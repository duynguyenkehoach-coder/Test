const express = require('express');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./config');
const database = require('./data_store/database');
const logger = require('./logger');
const { generateCopilotReply, classifyIntent } = require('./prompts/salesCopilot');
const { listDataFiles, readDataFile, cleanOldData, saveConversationToFile } = require('./data_store/fileManager');
const { verifyToken } = require('./auth/authMiddleware');
const authRoutes = require('./auth/authRoutes');

// ╔═══════════════════════════════════════════════════════════╗
// ║  IN-MEMORY LOG CAPTURE (for Dev Dashboard)                ║
// ╚═══════════════════════════════════════════════════════════╝
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'thg@dev2024';

// Intercept console output
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function captureLog(level, args) {
    const line = {
        time: new Date().toISOString(),
        level,
        msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
    };
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

console.log = (...args) => { captureLog('info', args); origLog.apply(console, args); };
console.error = (...args) => { captureLog('error', args); origError.apply(console, args); };
console.warn = (...args) => { captureLog('warn', args); origWarn.apply(console, args); };

const app = express();
let server = null; // keep reference for graceful shutdown

// Trust proxy (Nginx reverse proxy on VPS)
app.set('trust proxy', 1);

// --- Middleware ---
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Auth pages (public routes) ─────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'signup.html')));

// ── Auth API (no JWT needed) ────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── Dev Console — Log Viewer (password protected, no JWT) ───────────────────
app.get('/api/dev/logs', (req, res) => {
    const pw = req.query.password || '';
    if (pw !== DEV_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const level = req.query.level || '';
    const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
    let logs = logBuffer;
    if (level) logs = logs.filter(l => l.level === level);
    res.json({ data: logs.slice(-limit), total: logBuffer.length });
});

// Trigger manual scan from dev console
app.post('/api/dev/scan', async (req, res) => {
    const pw = req.query.password || req.body?.password || '';
    if (pw !== DEV_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    // Enqueue scan job — Scraper Worker will pick it up
    database.enqueueScan('MANUAL_SCAN', { manualTrigger: true, platforms: ['facebook'] });
    res.json({ ok: true, msg: 'Scan enqueued — Scraper Worker will process it. Check logs.' });
});


// CORS — cho phép admin panel ở domain khác gọi API
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200,
    message: { success: false, error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
});

const scanLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { success: false, error: 'Scan rate limited. Max 5 per minute.' },
});

app.use('/api/', apiLimiter);

// ╔═══════════════════════════════════════════════════════════╗
// ║  WORKER WEBHOOK — Receive leads from remote workers       ║
// ╚═══════════════════════════════════════════════════════════╝
const WORKER_AUTH_KEY = process.env.WORKER_AUTH_KEY || 'thg_worker_2026';

app.post('/api/leads/collect', (req, res) => {
    // Auth via custom header (not JWT — workers don't have JWT tokens)
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
                // Skip duplicates (dedup by post_url)
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

// ╔═══════════════════════════════════════════════════════════╗
// ║  WORKER JOB POLLING — Laptop polls VPS for scan jobs      ║
// ╚═══════════════════════════════════════════════════════════╝

// GET /api/worker/jobs — Laptop polls this to get pending scan jobs
app.get('/api/worker/jobs', (req, res) => {
    if (req.headers['x-thg-auth-key'] !== WORKER_AUTH_KEY) {
        return res.status(401).json({ success: false, error: 'Invalid worker key' });
    }
    try {
        // Claim the next pending job atomically
        const job = database.claimNextScan();
        if (!job) {
            return res.json({ success: true, job: null });
        }
        console.log(`[Hub] 🔧 Worker claimed job #${job.id} (${job.job_type})`);
        res.json({ success: true, job });
    } catch (err) {
        console.error(`[Hub] ❌ Job poll error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/worker/jobs/:id/complete — Laptop reports job completion + sends results
app.post('/api/worker/jobs/:id/complete', express.json({ limit: '10mb' }), (req, res) => {
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

        // Also save any posts/leads the worker sent
        let saved = 0;
        if (Array.isArray(posts) && posts.length > 0) {
            for (const post of posts) {
                try {
                    database.insertLead.run({
                        platform: post.platform || 'facebook',
                        author_name: post.author_name || 'Unknown',
                        author_url: post.author_url || '',
                        author_avatar: post.author_avatar || '',
                        post_url: post.post_url || '',
                        content: post.content || '',
                        score: post.score || 0,
                        category: post.category || 'uncategorised',
                        urgency: post.urgency || 'low',
                        summary: post.summary || '',
                        suggested_response: post.suggested_response || '',
                        role: post.role || 'buyer',
                        buyer_signals: post.buyer_signals || post.buyerSignals || '',
                        scraped_at: post.scraped_at || new Date().toISOString(),
                        post_created_at: post.post_created_at || new Date().toISOString(),
                        profit_estimate: post.profit_estimate || post.profitEstimate || '',
                        gap_opportunity: post.gap_opportunity || post.gapOpportunity || '',
                        pain_score: post.pain_score || post.painScore || 0,
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

// ── JWT Auth Guard — protects ALL /api/* except /api/auth/* ───────────────
app.use('/api/', (req, res, next) => {
    // /api/auth/* routes are already handled above — skip double-check
    if (req.path.startsWith('/auth/')) return next();
    // /api/dev/* stays unprotected for dev dashboard
    if (req.path.startsWith('/dev/')) return next();
    // /api/leads/collect uses X-THG-AUTH-KEY (worker auth), not JWT
    if (req.path === '/leads/collect' && req.method === 'POST') return next();
    return verifyToken(req, res, next);
});

// ─── Request Timeout Middleware ───────────────────────────────────────────────
// Prevents nginx 504 by letting Node respond with 503 before nginx gives up.
// Long-running endpoints (AI, scan) get 120s. Everything else gets 30s.
const LONG_ROUTES = ['/api/agents/generate-reply', '/api/scan', '/api/leads/classify'];
app.use((req, res, next) => {
    const isLong = LONG_ROUTES.some(r => req.path.startsWith(r));
    const timeoutMs = isLong ? 120_000 : 30_000;

    const timer = setTimeout(() => {
        if (!res.headersSent) {
            logger.warn('Server', `⏱ Request timeout: ${req.method} ${req.path} (${timeoutMs / 1000}s)`);
            res.status(503).json({
                success: false,
                error: 'Request timed out — server is busy. Please retry.',
                retryAfter: 5,
            });
        }
    }, timeoutMs);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
});
// ─────────────────────────────────────────────────────────────────────────────

// ╔═══════════════════════════════════════════════════════════╗
// ║  HEALTH CHECK                                             ║
// ╚═══════════════════════════════════════════════════════════╝

const startTime = Date.now();

app.get('/health', (req, res) => {
    try {
        const dbStats = database.db.prepare('SELECT COUNT(*) as leads FROM leads').get();
        const convStats = database.db.prepare('SELECT COUNT(*) as convs FROM conversations').get();
        const lastScan = database.db.prepare('SELECT finished_at FROM scan_logs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();

        res.json({
            status: 'ok',
            uptime: Math.floor((Date.now() - startTime) / 1000),
            uptimeHuman: formatUptime(Date.now() - startTime),
            version: require('../package.json').version,
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

// ╔═══════════════════════════════════════════════════════════╗
// ║  DEV LOGS (password-protected)                            ║
// ╚═══════════════════════════════════════════════════════════╝

app.get('/api/dev/logs', (req, res) => {
    const pw = req.query.password || req.headers['x-dev-password'];
    if (pw !== DEV_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Wrong password' });
    }
    const level = req.query.level; // optional filter: info, warn, error
    const search = req.query.search; // optional text search
    let logs = [...logBuffer];
    if (level) logs = logs.filter(l => l.level === level);
    if (search) logs = logs.filter(l => l.msg.toLowerCase().includes(search.toLowerCase()));
    res.json({ success: true, total: logs.length, data: logs });
});

app.get('/dev', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dev.html'));
});

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
}


// ╔═══════════════════════════════════════════════════════════╗
// ║  API ROUTES — Leads Dashboard                             ║
// ╚═══════════════════════════════════════════════════════════╝

app.get('/api/leads', (req, res) => {
    try {
        const filters = {
            platform: req.query.platform || null,
            category: req.query.category || null,
            status: req.query.status || null,
            exclude_ignored: req.query.exclude_ignored === 'true',
            minScore: req.query.minScore ? parseInt(req.query.minScore) : null,
            search: req.query.search || null,
            dateFrom: req.query.dateFrom || null,
            dateTo: req.query.dateTo || null,
            limit: req.query.limit ? parseInt(req.query.limit) : 100,
            offset: req.query.offset ? parseInt(req.query.offset) : 0,
        };
        const leads = database.getLeads(filters);
        res.json({ success: true, data: leads, count: leads.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- CSV Export (must be before :id route) ---
app.get('/api/leads/export', (req, res) => {
    try {
        const leads = database.db.prepare(`
            SELECT id, platform, author_name, author_url, post_url, content,
                   score, category, urgency, summary, suggested_response, status, created_at, post_created_at
            FROM leads ORDER BY created_at DESC
        `).all();

        const headers = ['ID', 'Platform', 'Author', 'Author URL', 'Post URL', 'Content', 'Score', 'Category', 'Urgency', 'Summary', 'Suggested Response', 'Status', 'Scraped At', 'Post Created At'];
        const csvRows = [headers.join(',')];

        for (const lead of leads) {
            csvRows.push([
                lead.id, lead.platform, csvEscape(lead.author_name),
                lead.author_url || '', lead.post_url || '', csvEscape(lead.content),
                lead.score, lead.category, lead.urgency,
                csvEscape(lead.summary), csvEscape(lead.suggested_response),
                lead.status, lead.created_at, lead.post_created_at || lead.created_at
            ].join(','));
        }

        const filename = `thg_leads_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + csvRows.join('\n'));
    } catch (err) {
        logger.error('Server', 'CSV export failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

function csvEscape(text) {
    if (!text) return '';
    const escaped = String(text).replace(/"/g, '""');
    if (escaped.includes(',') || escaped.includes('\n') || escaped.includes('"')) {
        return `"${escaped}"`;
    }
    return escaped;
}

app.get('/api/leads/:id', (req, res) => {
    try {
        const lead = database.getLeadById.get(parseInt(req.params.id));
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        res.json({ success: true, data: lead });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// NOTE: PATCH /api/leads/:id is defined later (line ~898) with full field support
// including assigned_to, status, notes, suggested_response
// DO NOT add another PATCH here — it would shadow the correct one

// Delete single lead
app.delete('/api/leads/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const lead = database.getLeadById.get(id);
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        database.db.prepare('DELETE FROM leads WHERE id = ?').run(id);
        logger.info('Server', `Lead #${id} deleted`);
        res.json({ success: true, message: `Lead #${id} deleted` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete all leads (requires confirm=true)
app.delete('/api/leads', (req, res) => {
    try {
        if (req.query.confirm !== 'true') {
            return res.status(400).json({ success: false, error: 'Add ?confirm=true to confirm deletion' });
        }
        const count = database.db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
        database.db.prepare('DELETE FROM leads').run();
        database.db.prepare('DELETE FROM scan_logs').run();
        logger.warn('Server', `All ${count} leads and scan logs cleared`);
        res.json({ success: true, message: `Deleted ${count} leads`, deleted: count });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const stats = database.getStatsCached();
        const convStats = database.getConversationStats();
        res.json({ success: true, data: { ...stats, conversations: convStats } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  CREDITS TRACKING                                         ║
// ╚═══════════════════════════════════════════════════════════╝
app.get('/api/credits', (req, res) => {
    try {
        const log = sv.getCreditLog();
        res.json({ success: true, data: { stats, log } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics', (req, res) => {
    try {
        const data = database.getAnalytics();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/scans', (req, res) => {
    try {
        const scans = database.getRecentScans.all();
        res.json({ success: true, data: scans });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/scan', async (req, res) => {
    try {
        const config = require('./config');
        // Enqueue scan job — Scraper Worker process will pick it up
        database.enqueueScan('FULL_SCAN', {
            platforms: config.ENABLED_PLATFORMS,
            maxPosts: config.MAX_POSTS_PER_SCAN || 200,
        });
        res.json({ success: true, message: `Scan enqueued (${config.ENABLED_PLATFORMS.join(', ')}). Worker will process it.` });
    } catch (err) {
        logger.error('Server', 'Manual scan enqueue failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/scan/groups', async (req, res) => {
    res.json({ success: true, message: 'Group scan disabled — using keyword search instead (saves Apify credit)' });
});

// ═══════════════════════════════════════════════════════
// Infrastructure Agent API
// ═══════════════════════════════════════════════════════
app.get('/api/infra/stats', (req, res) => {
    try {
        const { infraAgent } = require('./agents/infraAgent');
        res.json({ success: true, data: infraAgent.getProxyStats() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/infra/health-check', async (req, res) => {
    try {
        const { infraAgent } = require('./agents/infraAgent');
        const result = await infraAgent.runHealthCheck();
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/infra/proxies', async (req, res) => {
    try {
        const { urls, provider, region } = req.body;
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ success: false, error: 'urls array required' });
        }
        const { infraAgent } = require('./agents/infraAgent');
        await infraAgent.addProxies(urls, provider, region);
        res.json({ success: true, message: `Added ${urls.length} proxies` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/infra/proxies', (req, res) => {
    try {
        const { pool } = require('./proxy/proxyPool');
        if (!pool.data) return res.json({ success: true, data: { active: [], blacklisted: [] } });
        res.json({
            success: true,
            data: {
                active: pool.data.active_proxies.map(p => ({
                    id: p.id, provider: p.provider, region: p.region,
                    status: p.status, latency: p.latency, fail_count: p.fail_count,
                    last_used: p.last_used, last_checked: p.last_checked,
                })),
                blacklisted: pool.data.blacklisted_proxies.length,
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/scan/next', (req, res) => {
    try {
        // We use cron-parser to determine the next run time from the schedule string
        const parser = require('cron-parser');
        const parseFn = parser.parseExpression || (parser.default && parser.default.parseExpression);

        if (!parseFn) {
            // Fallback for */30 schedule if parser completely fails
            const now = new Date();
            const minutes = now.getMinutes();
            let nMin = 30; let addH = 0;
            if (minutes >= 30) { nMin = 0; addH = 1; }
            const nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + addH, nMin, 0, 0).getTime();
            return res.json({ success: true, nextRun });
        }

        const interval = parseFn.call(parser, config.CRON_SCHEDULE);
        const nextRun = interval.next().getTime();
        res.json({ success: true, nextRun });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  FB GROUP DISCOVERY API                                   ║
// ╚═══════════════════════════════════════════════════════════╝

app.get('/api/groups', (req, res) => {
    try {
        const groupDb = require('./agent/groupDiscovery');
        const filters = {
            category: req.query.category || null,
            status: req.query.status || null,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 200
        };
        const groups = groupDb.getAllGroups(filters);
        res.json({ success: true, data: groups });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/groups/stats', (req, res) => {
    try {
        const groupDb = require('./agent/groupDiscovery');
        const stats = groupDb.getStats();
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/groups', (req, res) => {
    try {
        const { name, url, category, notes } = req.body;
        if (!name || !url) return res.status(400).json({ success: false, error: 'Name and URL are required' });

        const groupDb = require('./agent/groupDiscovery');
        const autoCategory = (!category || category === 'unknown')
            ? groupDb.autoClassifyCategory(name)
            : category;
        groupDb.upsertGroup({
            name,
            url,
            category: autoCategory,
            relevance_score: 80,
            notes: notes || 'Added by Sales team',
        });
        res.json({ success: true, message: 'Group added successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/groups/status', (req, res) => {
    try {
        const { url, status } = req.body;
        if (!url || !status) return res.status(400).json({ success: false, error: 'URL and Status are required' });

        const groupDb = require('./agent/groupDiscovery');
        groupDb.setStatus(url, status);
        res.json({ success: true, message: 'Group status updated' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Bulk Import Groups (textarea paste) ──
app.post('/api/groups/bulk', (req, res) => {
    try {
        const { urls } = req.body;
        if (!urls || typeof urls !== 'string') {
            return res.status(400).json({ success: false, error: 'urls (string) is required' });
        }

        const groupDb = require('./agent/groupDiscovery');
        const lines = urls.split('\n').map(l => l.trim()).filter(l => l.includes('facebook.com/groups/'));
        let added = 0, skipped = 0;

        for (const line of lines) {
            // Extract clean URL
            const urlMatch = line.match(/(https?:\/\/(?:www\.)?facebook\.com\/groups\/[^\s?#]+)/);
            if (!urlMatch) { skipped++; continue; }
            const cleanUrl = urlMatch[1].replace(/\/$/, '');

            // Check if group already exists
            const db = groupDb.getDb();
            const existing = db.prepare('SELECT id FROM fb_groups WHERE url = ?').get(cleanUrl);
            if (existing) { skipped++; continue; }

            // Extract name from URL slug
            const slug = cleanUrl.split('/groups/')[1] || '';
            const name = slug
                .replace(/[_-]/g, ' ')
                .replace(/\b\w/g, c => c.toUpperCase())
                .substring(0, 80) || 'Unnamed Group';

            const category = groupDb.autoClassifyCategory(name);
            groupDb.upsertGroup({
                name,
                url: cleanUrl,
                category,
                relevance_score: 80,
                notes: 'Bulk import from Dashboard',
            });
            added++;
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

// ╔═══════════════════════════════════════════════════════════╗
// ║  DATA FILES API — Daily JSON browser                      ║
// ╚═══════════════════════════════════════════════════════════╝

app.get('/api/data-files', (req, res) => {
    try {
        const files = listDataFiles();
        res.json({ success: true, data: files });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/data-files/:filename', (req, res) => {
    try {
        const data = readDataFile(req.params.filename);
        if (!data) return res.status(404).json({ success: false, error: 'File not found' });
        res.json({ success: true, data, count: data.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/data-files/cleanup', (req, res) => {
    try {
        const deleted = cleanOldData();
        res.json({ success: true, deleted });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  FACEBOOK MESSENGER WEBHOOK                               ║
// ╚═══════════════════════════════════════════════════════════╝

// GET — Facebook verification
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'thg_verify_2024';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('[Webhook] ✅ Facebook verified!');
        res.status(200).send(challenge);
    } else {
        console.warn('[Webhook] ❌ Verification failed');
        res.sendStatus(403);
    }
});

// POST — Receive messages from Facebook Messenger
app.post('/webhook', async (req, res) => {
    const body = req.body;

    // Must respond 200 immediately
    res.status(200).send('EVENT_RECEIVED');

    if (body.object !== 'page') return;

    for (const entry of (body.entry || [])) {
        for (const event of (entry.messaging || [])) {
            if (!event.message?.text) continue;

            const senderId = event.sender.id;
            const messageText = event.message.text;

            console.log(`\n[Webhook] 💬 Tin nhắn mới từ ${senderId}: "${messageText}"`);

            try {
                // 1. Classify intent
                const intent = await classifyIntent(messageText);
                console.log(`[Webhook] 🏷️ Intent: ${intent}`);

                // 2. AI Copilot soạn reply
                const aiSuggestion = await generateCopilotReply(messageText, {
                    senderId,
                    platform: 'facebook',
                });

                // 3. Save to DB
                const result = database.insertConversation.run({
                    sender_id: senderId,
                    sender_name: `FB User ${senderId.slice(-4)}`,
                    message: messageText,
                    ai_suggestion: aiSuggestion,
                    intent,
                    platform: 'facebook',
                });

                console.log(`[Webhook] 💾 Saved conversation #${result.lastInsertRowid}`);

                // 4. Alert team via Telegram
                await sendTelegramAlert(senderId, messageText, aiSuggestion, intent);

            } catch (err) {
                console.error('[Webhook] ✗ Error processing message:', err.message);
            }
        }
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  API ROUTES — Inbox / Conversations                       ║
// ╚═══════════════════════════════════════════════════════════╝

// List conversations
app.get('/api/conversations', (req, res) => {
    try {
        const filters = {
            status: req.query.status || null,
            platform: req.query.platform || null,
            limit: req.query.limit ? parseInt(req.query.limit) : 50,
        };
        const conversations = database.getConversations(filters);
        res.json({ success: true, data: conversations, count: conversations.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get conversation stats
app.get('/api/conversations/stats', (req, res) => {
    try {
        const stats = database.getConversationStats();
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update conversation (Sale edits reply / changes status)
app.patch('/api/conversations/:id', (req, res) => {
    try {
        const { sale_reply, status } = req.body;
        const id = parseInt(req.params.id);
        database.updateConversation.run({
            id,
            sale_reply: sale_reply || null,
            status: status || 'replied',
        });
        const updated = database.getConversationById.get(id);
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Quick AI re-generate for a conversation
app.post('/api/conversations/:id/regenerate', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const conv = database.getConversationById.get(id);
        if (!conv) return res.status(404).json({ success: false, error: 'Not found' });

        const newSuggestion = await generateCopilotReply(conv.message, {
            senderName: conv.sender_name,
            platform: conv.platform,
        });

        database.db.prepare(
            'UPDATE conversations SET ai_suggestion = ?, updated_at = datetime(\'now\') WHERE id = ?'
        ).run(newSuggestion, id);

        const updated = database.getConversationById.get(id);
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  MANUAL TEST ENDPOINT (simulate webhook)                  ║
// ╚═══════════════════════════════════════════════════════════╝

app.post('/api/test-message', async (req, res) => {
    try {
        const { message, sender_name, platform } = req.body;
        if (!message) return res.status(400).json({ success: false, error: 'Message required' });

        const intent = await classifyIntent(message);
        const aiSuggestion = await generateCopilotReply(message, {
            senderName: sender_name || 'Test User',
            platform: platform || 'manual',
        });

        const result = database.insertConversation.run({
            sender_id: 'test_' + Date.now(),
            sender_name: sender_name || 'Test User',
            message,
            ai_suggestion: aiSuggestion,
            intent,
            platform: platform || 'manual',
        });

        const conv = database.getConversationById.get(result.lastInsertRowid);
        res.json({ success: true, data: conv });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  TELEGRAM ALERTS                                          ║
// ╚═══════════════════════════════════════════════════════════╝

async function sendTelegramAlert(senderId, message, aiSuggestion, intent) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId || token === 'your_telegram_bot_token') return;

    const intentEmojis = {
        price_inquiry: '💰', service_inquiry: '📋',
        urgent_need: '🔥', general: '💬', spam: '🚫',
    };

    const text = `⚡ *KHÁCH INBOX FANPAGE* ⚡

${intentEmojis[intent] || '💬'} *Intent:* ${intent}
🗣️ *Khách nói:*
"${message.substring(0, 300)}"

🤖 *AI Copilot soạn sẵn:*
\`${aiSuggestion.substring(0, 500)}\`

👉 _Sale vào Dashboard → Inbox để review & gửi!_`;

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text, parse_mode: 'Markdown',
        });
        console.log('[Telegram] 📲 Alert sent!');
    } catch (err) {
        console.error('[Telegram] ✗', err.message);
    }
}



// ╔═══════════════════════════════════════════════════════════╗
// ║  START SERVER + GRACEFUL SHUTDOWN                         ║
// ╚═══════════════════════════════════════════════════════════╝

function startServer() {
    const port = config.PORT;
    const http = require('http');
    const httpServer = http.createServer(app);
    let retryCount = 0;
    const MAX_RETRIES = 10;

    function doListen() {
        httpServer.listen({ port, host: '::', ipv6Only: false }, () => {
            server = httpServer;
            logger.info('Server', `Dashboard: http://localhost:${port}`);
            logger.info('Server', `Webhook:   http://localhost:${port}/webhook`);
            logger.info('Server', `Health:    http://localhost:${port}/health`);
            logger.info('Server', `CSV Export: http://localhost:${port}/api/leads/export`);
        });
    }

    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            retryCount++;
            if (retryCount > MAX_RETRIES) {
                logger.error('Server', `Port ${port} still busy after ${MAX_RETRIES} retries. Run "task" to restart.`);
                process.exit(1);
            }
            logger.warn('Server', `Port ${port} busy (${retryCount}/${MAX_RETRIES}) — retrying in 3s...`);
            setTimeout(() => {
                httpServer.close();
                doListen();
            }, 3000);
        } else {
            throw err;
        }
    });

    doListen();
    server = httpServer;
    return app;
}

// Graceful shutdown
function shutdown(signal) {
    logger.warn('Server', `${signal} received. Shutting down gracefully...`);
    if (server) {
        server.close(() => {
            logger.info('Server', 'HTTP server closed');
            try { database.db.close(); } catch { /* ignore */ }
            logger.info('Server', 'Database closed. Goodbye!');
            process.exit(0);
        });
        // Force kill after 5 seconds
        setTimeout(() => {
            logger.error('Server', 'Forced shutdown after timeout');
            process.exit(1);
        }, 5000);
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
    startServer();
}

// GROUP DISCOVERY routes (duplicate block removed — already defined at line 451-506)
// Kept: initialization only
const groupDiscovery = require('./agent/groupDiscovery');
try { groupDiscovery.getDb(); logger.info('GroupDB', `Group database initialized`); } catch (e) { logger.warn('GroupDB', e.message); }

// ╔══════════════════════════════════════════════════════╗
// ║  AGENT FEEDBACK API                                   ║
// ╚══════════════════════════════════════════════════════╝
const memoryStore = require('./agent/memoryStore');
const knowledgeBase = require('./agent/knowledgeBase');

// POST /api/leads/:id/feedback — Human feedback on lead classification
app.post('/api/leads/:id/feedback', (req, res) => {
    try {
        const leadId = parseInt(req.params.id);
        const { type, correct_role, correct_score, note } = req.body;

        if (!type || !['correct', 'wrong', 'upgrade', 'downgrade', 'text_feedback'].includes(type)) {
            return res.status(400).json({ error: 'type must be: correct, wrong, upgrade, downgrade, text_feedback' });
        }

        // Fetch the lead to get its content for hash-based lookup in classification_memory
        // (leads.db and thg_leads.db have different auto-increment IDs, so we can't use ID directly)
        const lead = database.getLeadById.get(leadId);
        const feedbackPayload = {
            type,
            correct_role: correct_role || null,
            correct_score: correct_score || null,
            note: note || null,
            platform: lead?.platform || 'unknown',
        };

        let success = false;
        if (lead && lead.content) {
            success = memoryStore.saveFeedbackByContent(lead.content, feedbackPayload);
            if (success) logger.info('Agent', `Feedback trained for lead #${leadId} (${type}) — matched via content_hash`);
        } else {
            // Fallback: try by ID (may not match but logs error clearly)
            success = memoryStore.saveFeedback(leadId, feedbackPayload);
            logger.warn('Agent', `Lead #${leadId} not found — feedback saved by ID (may not match memory)`);
        }

        if (success) {
            res.json({ ok: true, message: `Feedback '${type}' saved for lead #${leadId}` });
        } else {
            res.status(500).json({ error: 'Failed to save feedback' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/agent/stats — Agent memory statistics
app.get('/api/agent/stats', (req, res) => {
    try {
        const memoryStats = memoryStore.getMemoryStats();
        const kbChunks = knowledgeBase.getChunkCount();
        res.json({
            agent: {
                knowledgeBase: { chunks: kbChunks },
                memory: memoryStats,
            },
        });
    } catch (err) {
        res.json({ agent: { error: err.message } });
    }
});

// GET /api/agent/feedback-history — Training history for dashboard
app.get('/api/agent/feedback-history', (req, res) => {
    try {
        const history = memoryStore.getFeedbackHistory(30);
        const typeLabel = {
            correct: '✅ Đúng',
            wrong: '❌ Sai',
            upgrade: '⬆️ Nâng score',
            downgrade: '⬇️ Giảm score',
            text_feedback: '💬 Ghi chú',
        };
        const formatted = history.map(r => ({
            id: r.id,
            preview: r.preview,
            platform: r.platform,
            type: typeLabel[r.human_feedback] || r.human_feedback,
            correct_role: r.correct_role,
            note: r.feedback_note,
            trained_at: r.feedback_at,
        }));
        res.json({ ok: true, data: formatted, count: formatted.length });
    } catch (err) {
        res.json({ ok: false, error: err.message, data: [] });
    }
});

// PATCH /api/leads/:id — Update fields + Claim & Lock
app.patch('/api/leads/:id', (req, res) => {
    try {
        const { id } = req.params;
        const ALLOWED = ['assigned_to', 'claimed_by', 'claimed_at', 'status', 'notes', 'suggested_response', 'category'];
        const updates = Object.fromEntries(
            Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
        );
        if (!Object.keys(updates).length) return res.status(400).json({ ok: false, error: 'No valid fields' });

        // ═══ MULTI-SALES CLAIM LOGIC ═══
        let claimAction = null; // 'CLAIM' or 'UNCLAIM'
        let actionStaff = req.body.action_staff;

        if (updates.claimed_by !== undefined) {
            const current = database.db.prepare('SELECT claimed_by FROM leads WHERE id = ?').get(id);
            const oldStaffArr = (current?.claimed_by || '').split(',').map(s => s.trim()).filter(Boolean);
            const newStaffArr = (updates.claimed_by || '').split(',').map(s => s.trim()).filter(Boolean);

            if (actionStaff) {
                if (newStaffArr.includes(actionStaff) && !oldStaffArr.includes(actionStaff)) {
                    claimAction = 'CLAIM';
                } else if (!newStaffArr.includes(actionStaff) && oldStaffArr.includes(actionStaff)) {
                    claimAction = 'UNCLAIM';
                }
            }

            if (newStaffArr.length > 0) {
                updates.claimed_at = new Date().toISOString();
                if (!updates.status) updates.status = 'claimed';
                updates.assigned_to = updates.claimed_by;
            } else {
                updates.claimed_at = '';
                if (!updates.status || updates.status === 'claimed') updates.status = 'new';
                updates.assigned_to = '';
            }
        }

        const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
        database.db.prepare(`UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
            .run({ ...updates, id });
        const lead = database.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

        // Auto-train Agent when status changes
        if (lead && lead.content && updates.status) {
            if (updates.status === 'ignored') {
                memoryStore.saveFeedbackByContent(lead.content, {
                    type: 'wrong', correct_role: 'irrelevant',
                    note: 'User ignored — misclassified as lead', platform: lead.platform,
                });
                logger.info('Agent', `[Train] Lead #${id} ignored → feedback: wrong`);
            } else if (updates.status === 'converted') {
                memoryStore.saveFeedbackByContent(lead.content, {
                    type: 'correct', correct_role: 'buyer',
                    note: 'User converted — confirmed genuine buyer', platform: lead.platform,
                });
                logger.info('Agent', `[Train] Lead #${id} converted → feedback: correct`);
            }
        }

        // ═══ AUTO-LOG to sales_activities (Multi-Sales) ═══
        if (claimAction && actionStaff) {
            try {
                database.db.prepare(
                    `INSERT INTO sales_activities (lead_id, staff_name, action_type, note) VALUES (?, ?, ?, ?)`
                ).run(id, actionStaff, claimAction, `${claimAction === 'CLAIM' ? 'Tham gia tiếp nhận' : 'Nhả'} lead #${id}`);
            } catch (e) { /* ignore logging errors */ }
        }
        if (updates.status === 'contacted' && lead?.claimed_by) {
            const primaryStaff = lead.claimed_by.split(',')[0].trim();
            if (primaryStaff) {
                try {
                    database.db.prepare(
                        `INSERT INTO sales_activities (lead_id, staff_name, action_type, note) VALUES (?, ?, 'CONTACT', ?)`
                    ).run(id, primaryStaff, `Contacted lead #${id}`);
                } catch (e) { /* ignore */ }
            }
        }

        res.json({ ok: true, ...lead });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  CLOSE DEAL — Winner + Revenue Tracking                   ║
// ╚═══════════════════════════════════════════════════════════╝

app.post('/api/leads/:id/close', (req, res) => {
    try {
        const { id } = req.params;
        const { winner_staff, deal_value, note } = req.body;

        if (!winner_staff) return res.status(400).json({ ok: false, error: 'winner_staff required' });

        // Update lead with winner info
        database.db.prepare(`
            UPDATE leads SET
                status = 'converted',
                winner_staff = @winner_staff,
                deal_value = @deal_value,
                closed_at = datetime('now'),
                converted_at = CASE WHEN converted_at IS NULL THEN datetime('now') ELSE converted_at END,
                updated_at = datetime('now')
            WHERE id = @id
        `).run({ winner_staff, deal_value: deal_value || 0, id });

        // Log the closing activity
        database.db.prepare(
            `INSERT INTO sales_activities (lead_id, staff_name, action_type, deal_value, note) VALUES (?, ?, 'CLOSED', ?, ?)`
        ).run(id, winner_staff, deal_value || 0, note || `Chốt đơn $${deal_value || 0}`);

        // Auto-train agent: confirmed buyer
        const lead = database.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
        if (lead?.content) {
            memoryStore.saveFeedbackByContent(lead.content, {
                type: 'correct', correct_role: 'buyer',
                note: `Deal closed by ${winner_staff} — $${deal_value || 0}`, platform: lead.platform,
            });
        }

        // ═══ AWARD LEADERBOARD POINTS ═══
        // 100 base pts + bonus (deal_value * 0.002) calculated inside awardPoints
        try {
            database.awardPoints(winner_staff, 'CLOSE_DEAL', 100, {
                dealValue: deal_value || 0,
                leadId: parseInt(id, 10),
                note: note || `Chốt đơn $${deal_value || 0} từ Lead #${id}`,
            });
            logger.info('Gamification', `🏆 ${winner_staff} awarded 100+bonus pts for closing deal #${id}`);
        } catch (ptErr) {
            logger.warn('Gamification', `awardPoints failed silently: ${ptErr.message}`);
        }
        // ═════════════════════════════════

        logger.info('Sales', `🏆 ${winner_staff} closed deal #${id} — $${deal_value || 0}`);
        res.json({ ok: true, message: `🏆 ${winner_staff} chốt đơn thành công!`, lead });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  CLOSING FEED — Recent Wins Ticker                        ║
// ╚═══════════════════════════════════════════════════════════╝

app.get('/api/activities/feed', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const feed = database.db.prepare(`
            SELECT sa.*, l.category, l.source_group, l.author_name
            FROM sales_activities sa
            LEFT JOIN leads l ON sa.lead_id = l.id
            WHERE sa.action_type = 'CLOSED'
            ORDER BY sa.created_at DESC
            LIMIT ?
        `).all(limit);
        res.json({ success: true, data: feed });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  STAFF STATS — Per-Staff Revenue Dashboard                ║
// ╚═══════════════════════════════════════════════════════════╝

app.get('/api/staff/stats', (req, res) => {
    try {
        const stats = database.db.prepare(`
            SELECT
                staff_name,
                COUNT(CASE WHEN action_type = 'CLAIM' THEN 1 END) as claims,
                COUNT(CASE WHEN action_type = 'CONTACT' THEN 1 END) as contacts,
                COUNT(CASE WHEN action_type = 'CLOSED' THEN 1 END) as closes,
                SUM(CASE WHEN action_type = 'CLOSED' THEN deal_value ELSE 0 END) as total_revenue
            FROM sales_activities
            GROUP BY staff_name
            ORDER BY total_revenue DESC
        `).all();

        // Also get today's activity
        const today = database.db.prepare(`
            SELECT staff_name, action_type, COUNT(*) as count
            FROM sales_activities
            WHERE date(created_at) = date('now')
            GROUP BY staff_name, action_type
        `).all();

        res.json({ success: true, data: { allTime: stats, today } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  PERSONAL AGENT SYSTEM                                    ║
// ╚═══════════════════════════════════════════════════════════╝

const { buildAgentReply } = require('./agent/promptBuilder');
const messenger = require('./integrations/messenger');

// GET /api/agents — list all agent profiles
app.get('/api/agents', (req, res) => {
    try {
        const profiles = database.getAgentProfiles();
        res.json({ success: true, data: profiles, messenger_status: messenger.getStatus() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/agents/generate-reply — generate AI reply in agent's voice
// MUST BE BEFORE /api/agents/:name to avoid Express wildcard matching!
app.post('/api/agents/generate-reply', express.json(), async (req, res) => {
    try {
        const { agent_name, lead_id } = req.body;
        const agentProfile = database.getAgentProfile(agent_name);
        if (!agentProfile) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agentProfile.takeover) return res.status(409).json({ success: false, error: 'Agent is in Take Over mode — AI silent', takeover: true });

        const lead = database.db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id);
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

        const { system, user } = buildAgentReply(lead, agentProfile);

        let reply = '';
        try {
            const Groq = require('groq-sdk');
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                model: 'llama-3.1-70b-versatile',
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                max_tokens: 300, temperature: 0.7,
            });
            reply = completion.choices[0]?.message?.content?.trim() || '';
        } catch (aiErr) {
            try {
                const { GoogleGenerativeAI } = require('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const result = await model.generateContent(`${system}\n\n${user}`);
                reply = result.response.text().trim();
            } catch (geminiErr) {
                return res.status(500).json({ success: false, error: 'AI providers unavailable' });
            }
        }
        res.json({ success: true, reply, agent: agent_name });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/agents/:name — save agent profile (WILDCARD — must be after specific paths!)
app.post('/api/agents/:name', express.json(), (req, res) => {
    try {
        const { name } = req.params;
        database.saveAgentProfile(name, req.body);
        const updated = database.getAgentProfile(name);
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/agents/:name/takeover — toggle take over mode
app.post('/api/agents/:name/takeover', (req, res) => {
    try {
        const next = database.toggleAgentTakeover(req.params.name);
        if (next === null) return res.status(404).json({ success: false, error: 'Agent not found' });
        res.json({ success: true, takeover: next });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Facebook Messenger Webhooks (disabled until AUTO_REPLY_ENABLED=true) ───
// GET /webhook — verification
app.get('/webhook', messenger.verifyWebhook);
// POST /webhook — receive events
app.post('/webhook', express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }), messenger.receiveWebhook);


// ╔═══════════════════════════════════════════════════════════╗
// ║  GAMIFICATION — LEADERBOARD & POINTS SYSTEM               ║
// ╚═══════════════════════════════════════════════════════════╝

// GET /api/leaderboard — full rankings + recent activity log
app.get('/api/leaderboard', (req, res) => {
    try {
        const data = database.getLeaderboard();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/leaderboard/log — recent activity feed (for live ticker)
app.get('/api/leaderboard/log', (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
        const data = database.getPointsLog(limit);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/points/award — award points to a sales person
// Used by: Closing Room (close deal), Lead actions (qualify), admin manual
app.post('/api/points/award', express.json(), (req, res) => {
    try {
        const { sales_name, action_type, points, deal_value = 0, lead_id = 0, note = '' } = req.body;
        if (!sales_name || !action_type || points == null) {
            return res.status(400).json({ success: false, error: 'Missing required fields: sales_name, action_type, points' });
        }

        // If CLOSE_DEAL, auto-add revenue bonus (5% of deal value as bonus pts)
        let totalPoints = parseInt(points, 10);
        if (action_type === 'CLOSE_DEAL' && deal_value > 0) {
            totalPoints += Math.floor(deal_value * 0.002); // $500 deal = 1 extra pt per $
        }

        const result = database.awardPoints(sales_name, action_type, totalPoints, { dealValue: deal_value, leadId: lead_id, note });

        // Update lead's winner_staff and deal_value if this is a CLOSE_DEAL
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

// ╔═══════════════════════════════════════════════════════════╗
// ║  FB ACCOUNT MANAGER API                                   ║
// ║  Quản lý pool tài khoản cho CrawBot                       ║
// ╚═══════════════════════════════════════════════════════════╝
try {
    const accountManager = require('./agent/accountManager');

    // GET /api/accounts — Xem trạng thái toàn bộ pool
    app.get('/api/accounts', (req, res) => {
        try {
            const pool = accountManager.getPoolStatus();
            res.json({ success: true, accounts: pool, total: pool.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/accounts — Thêm tài khoản mới vào pool
    app.post('/api/accounts', (req, res) => {
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

    // PATCH /api/accounts/:email/reset — Phục hồi tài khoản sau khi giải checkpoint thủ công
    app.patch('/api/accounts/:email/reset', (req, res) => {
        try {
            accountManager.resetAccount(req.params.email);
            res.json({ success: true, message: `✅ Reset ${req.params.email} → active, trust=70` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // PATCH /api/accounts/:email/proxy — Gán proxy cho tài khoản
    app.patch('/api/accounts/:email/proxy', (req, res) => {
        const { proxy_url } = req.body || {};
        try {
            database.db.prepare(`UPDATE fb_accounts SET proxy_url=? WHERE email=?`).run(proxy_url || '', req.params.email);
            res.json({ success: true, message: `✅ Proxy của ${req.params.email} đã được cập nhật` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // DELETE /api/accounts/:email — Loại tài khoản khỏi pool (mark banned)
    app.delete('/api/accounts/:email', (req, res) => {
        try {
            database.db.prepare(`UPDATE fb_accounts SET status='banned' WHERE email=?`).run(req.params.email);
            res.json({ success: true, message: `🚫 ${req.params.email} đã bị loại khỏi pool` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    console.log('[Server] ✅ Account Manager API routes loaded (/api/accounts)');
} catch (e) {
    console.warn('[Server] ⚠️ Account Manager API skipped:', e.message);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  PERSONAL AGENT API                                       ║
// ║  Agent nhập vai Sales với đúng văn phong                  ║
// ╚═══════════════════════════════════════════════════════════╝
try {
    const personalAgent = require('./agent/personalAgent');
    const styleExtractor = require('./agent/styleExtractor');

    // GET /api/agents — Danh sách tất cả agents + status
    app.get('/api/agents', (req, res) => {
        try {
            res.json({ success: true, agents: personalAgent.getAllAgents() });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/reply — Agent tạo reply từ message khách
    app.post('/api/agents/:name/reply', async (req, res) => {
        const { message, lead_id, lead_summary, platform, sender_name } = req.body || {};
        if (!message) return res.status(400).json({ success: false, error: 'message là bắt buộc' });
        try {
            const reply = await personalAgent.generateAgentReply(req.params.name, message, {
                leadId: lead_id,
                leadSummary: lead_summary,
                platform,
                senderName: sender_name,
            });
            res.json({ success: true, agent: req.params.name, reply });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/log — Log tin nhắn vào chat_history
    app.post('/api/agents/:name/log', (req, res) => {
        const { lead_id, direction, message, is_teaching } = req.body || {};
        if (!direction || !message) return res.status(400).json({ success: false, error: 'direction và message là bắt buộc' });
        try {
            database.logChatMessage(req.params.name, lead_id || 0, direction, message, is_teaching ? 1 : 0);
            res.json({ success: true, message: '✅ Đã lưu chat history' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/teach — Đánh dấu câu chat là teaching sample
    app.post('/api/agents/:name/teach', (req, res) => {
        const { chat_id, message } = req.body || {};
        try {
            if (chat_id) {
                personalAgent.markAsTeaching(chat_id);
            } else if (message) {
                // Thêm trực tiếp như teaching sample
                database.logChatMessage(req.params.name, 0, 'sales', message, 1);
            } else {
                return res.status(400).json({ success: false, error: 'chat_id hoặc message là bắt buộc' });
            }
            res.json({ success: true, message: `🎓 Đã đánh dấu teaching sample cho ${req.params.name}` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // PATCH /api/agents/:name/mode — Chuyển mode learning|active|paused
    app.patch('/api/agents/:name/mode', (req, res) => {
        const { mode } = req.body || {};
        try {
            personalAgent.setAgentMode(req.params.name, mode);
            res.json({ success: true, agent: req.params.name, mode, message: `✅ ${req.params.name} Agent → ${mode}` });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // GET /api/agents/:name/style — Xem tone profile hiện tại của agent
    app.get('/api/agents/:name/style', (req, res) => {
        try {
            const profile = styleExtractor.getStyleProfile(req.params.name);
            const samples = styleExtractor.getWritingSamples(req.params.name);
            const styleRow = database.getSalesStyle(req.params.name);
            res.json({
                success: true,
                agent: req.params.name,
                profile,
                samples,
                sample_count: styleRow?.sample_count || 0,
                last_extracted: styleRow?.last_extracted || null,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/extract-style — Trigger style extraction ngay lập tức
    app.post('/api/agents/:name/extract-style', async (req, res) => {
        try {
            const result = await styleExtractor.extractStyleForAgent(req.params.name);
            res.json({
                success: true,
                agent: req.params.name,
                sample_count: result.sampleCount,
                profile: result.profile,
                message: `✅ Đã chiết xuất style cho ${req.params.name} (${result.sampleCount} mẫu)`,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/agents/:name/history — Xem lịch sử chat
    app.get('/api/agents/:name/history', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const chats = database.getRecentChats(req.params.name, limit);
            res.json({ success: true, agent: req.params.name, chats, total: chats.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    console.log('[Server] ✅ Personal Agent API routes loaded (/api/agents)');
} catch (e) {
    console.warn('[Server] ⚠️ Personal Agent API skipped:', e.message);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  MESSENGER SCRAPER API                                    ║
// ║  CrawBot tự học từ Messenger của Sales                    ║
// ╚═══════════════════════════════════════════════════════════╝
try {
    const accountManager = require('./agent/accountManager');
    const messengerScraper = require('./agent/messengerScraper');

    // POST /api/agents/:name/learn-messenger
    // Trigger học từ Messenger của một Sales cụ thể
    app.post('/api/agents/:name/learn-messenger', async (req, res) => {
        const salesName = req.params.name;
        try {
            // Không block HTTP request — chạy nền
            res.json({
                success: true,
                message: `🤖 CrawBot đang học từ Messenger của ${salesName}... Kiểm tra logs để theo dõi tiến trình.`,
            });
            // Chạy nền sau khi response đã được gửi
            setImmediate(async () => {
                const result = await messengerScraper.scrapeMessengerForSales(salesName, { autoExtract: true });
                console.log(`[Server] Messenger learning ${salesName}: ${JSON.stringify(result)}`);
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/learn-all-messengers
    // Trigger học từ Messenger của TẤT CẢ Sales (dùng thủ công hoặc cron)
    app.post('/api/agents/learn-all-messengers', async (req, res) => {
        try {
            res.json({
                success: true,
                message: '🤖 CrawBot đang học từ Messenger của tất cả Sales... Có thể mất 10-30 phút.',
            });
            setImmediate(async () => {
                await messengerScraper.scrapeAllSalesMessengers({ autoExtract: true });
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/accounts/:email/link-sales — Liên kết account FB với Sales
    app.post('/api/accounts/:email/link-sales', (req, res) => {
        const { sales_name } = req.body || {};
        if (!sales_name) return res.status(400).json({ success: false, error: 'sales_name là bắt buộc' });
        try {
            accountManager.linkAccountToSales(req.params.email, sales_name);
            res.json({
                success: true,
                message: `✅ Đã liên kết ${req.params.email} → ${sales_name}. CrawBot sẽ học từ Messenger của account này.`,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── Nightly Cron: 2AM VN time (UTC+7 = 19:00 UTC) ─────────────────
    if (process.env.NODE_ENV === 'production') {
        const NIGHTLY_HOUR_UTC = 19; // 2AM VN = 7PM UTC
        const NIGHTLY_MINUTE = 0;

        setInterval(async () => {
            const now = new Date();
            if (now.getUTCHours() === NIGHTLY_HOUR_UTC && now.getUTCMinutes() === NIGHTLY_MINUTE) {
                console.log('[CrawBot Cron] 🌙 2AM VN — Bắt đầu nightly Messenger learning...');
                try {
                    await messengerScraper.scrapeAllSalesMessengers({ autoExtract: true });
                    console.log('[CrawBot Cron] ✅ Nightly learning hoàn tất');
                } catch (err) {
                    console.error('[CrawBot Cron] ❌ Nightly learning lỗi:', err.message);
                }
            }
        }, 60 * 1000); // Check mỗi phút

        console.log('[Server] ⏰ Nightly Messenger learning cron scheduled (2AM VN)');
    }

    console.log('[Server] ✅ Messenger Scraper API routes loaded (/api/agents/:name/learn-messenger)');
} catch (e) {
    console.warn('[Server] ⚠️ Messenger Scraper API skipped:', e.message);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  FB SESSION LOGIN — Sales đăng nhập 1 lần để lưu session ║
// ╚═══════════════════════════════════════════════════════════╝
try {
    const { chromium } = require('playwright-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    chromium.use(StealthPlugin());
    const accountManager = require('./agent/accountManager');
    const fs = require('fs');
    const path = require('path');

    // POST /api/agents/fb-login — Playwright login để lưu session cookie
    app.post('/api/agents/fb-login', async (req, res) => {
        const { salesName, email, password } = req.body || {};
        if (!salesName || !email || !password) {
            return res.status(400).json({ success: false, error: 'salesName, email và password là bắt buộc' });
        }

        console.log(`[FBLogin] 🔐 ${salesName} (${email}) đang đăng nhập...`);
        let browser;
        try {
            browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 800 },
                locale: 'vi-VN',
            });

            const page = await context.newPage();

            // Điều hướng đến trang login
            await page.goto('https://www.facebook.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
            await new Promise(r => setTimeout(r, 2000));

            // Điền email & password
            await page.fill('#email', email);
            await new Promise(r => setTimeout(r, 800));
            await page.fill('#pass', password);
            await new Promise(r => setTimeout(r, 600));
            await page.click('[name="login"]');
            await new Promise(r => setTimeout(r, 5000));

            const url = page.url();

            // Kiểm tra kết quả đăng nhập
            if (url.includes('checkpoint') || url.includes('two_step_verification')) {
                return res.json({ success: false, error: '⚠️ Facebook yêu cầu xác thực 2 bước. Vui lòng tắt 2FA và thử lại, hoặc liên hệ Admin để xử lý thủ công.' });
            }
            if (url.includes('/login')) {
                return res.json({ success: false, error: '❌ Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.' });
            }

            // Lưu session
            const cookies = await context.cookies();
            const sessionsDir = accountManager.SESSIONS_DIR;
            fs.mkdirSync(sessionsDir, { recursive: true });
            const sessionPath = path.join(sessionsDir, `${email.replace(/[^a-z0-9]/gi, '_')}.json`);
            fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));

            // Thêm/update account trong fb_accounts và link với Sales
            const existingAcc = database.db.prepare(`SELECT id FROM fb_accounts WHERE email = ?`).get(email);
            if (!existingAcc) {
                accountManager.addAccount({ email, password, proxyUrl: '', notes: `${salesName} personal account` });
            } else {
                // Update password nếu đã có
                database.db.prepare(`UPDATE fb_accounts SET password = ?, session_path = ?, status = 'active' WHERE email = ?`)
                    .run(password, sessionPath, email);
            }
            accountManager.linkAccountToSales(email, salesName);

            console.log(`[FBLogin] ✅ ${salesName} (${email}): Session đã lưu → ${path.basename(sessionPath)}`);
            res.json({
                success: true,
                message: `✅ ${salesName} đã đăng nhập thành công! Session được lưu. Bây giờ có thể bấm "Học từ Messenger".`,
                sessionFile: path.basename(sessionPath),
            });

        } catch (err) {
            console.error(`[FBLogin] ❌ ${salesName}: ${err.message}`);
            res.status(500).json({ success: false, error: `Lỗi khi đăng nhập: ${err.message}` });
        } finally {
            if (browser) await browser.close().catch(() => { });
        }
    });

    console.log('[Server] ✅ FB Login endpoint loaded (/api/agents/fb-login)');
} catch (e) {
    console.warn('[Server] ⚠️ FB Login endpoint skipped:', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// CrawBot Import v2 — Enqueue only (Worker runs in separate process)
//
// Flow:
//  1. POST /api/import/crawbot  → accept array, dedup by URL, enqueue PENDING
//  2. Return 200 immediately (bot never hangs)
//  3. AI Worker process (src/workers/aiWorker.js) polls raw_leads and processes
// ─────────────────────────────────────────────────────────────────────────────
try {
    // ── Normalize incoming CrawBot post ────────────────────────────────────────
    function normalize(raw) {
        return {
            url: raw.url || raw.post_url || raw.link || '',
            author: raw.author || raw.author_name || raw.name || '',
            author_url: raw.author_url || raw.profile_url || raw.author_link || '',
            content: raw.content || raw.text || raw.message || raw.body || '',
            platform: raw.platform || raw.source || 'facebook',
            group_name: raw.group || raw.group_name || raw.source_name || '',
            scraped_at: raw.scraped_at || raw.date || raw.time || new Date().toISOString(),
        };
    }

    // ── POST /api/import/crawbot — JSON webhook ────────────────────────────
    app.post('/api/import/crawbot', (req, res) => {
        const rawPosts = Array.isArray(req.body) ? req.body : req.body?.posts || [];
        if (!rawPosts.length) {
            return res.status(400).json({ ok: false, error: 'Empty posts array.' });
        }
        if (rawPosts.length > 500) {
            return res.status(400).json({ ok: false, error: 'Max 500 posts per request.' });
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

        // ✅ Return immediately — AI Worker process will handle classification
        res.json({ ok: true, enqueued, duplicates, invalid, total: rawPosts.length });
    });

    // ── GET /api/import/crawbot/status — queue stats ───────────────────────
    app.get('/api/import/crawbot/status', (req, res) => {
        const stats = database.db.prepare(`
            SELECT status, COUNT(*) as count FROM raw_leads GROUP BY status
        `).all();
        const recentQualified = database.db.prepare(`
            SELECT author, score, assigned_to, url FROM raw_leads
            WHERE status='QUALIFIED' ORDER BY id DESC LIMIT 10
        `).all();
        res.json({ ok: true, queue: stats, recentQualified });
    });

    // ── GET /api/scan/queue — scan queue status ───────────────────────────
    app.get('/api/scan/queue', (req, res) => {
        const queueStats = database.getScanQueueStatus();
        const running = database.db.prepare(`SELECT * FROM scan_queue WHERE status = 'RUNNING' LIMIT 1`).get();
        const recent = database.db.prepare(`SELECT id, job_type, status, created_at, started_at, finished_at FROM scan_queue ORDER BY id DESC LIMIT 10`).all();
        res.json({ success: true, queue: queueStats, running: running || null, recent });
    });

    console.log('[Server] ✅ CrawBot v2 import loaded (/api/import/crawbot)');
} catch (e) {
    console.warn('[Server] ⚠️ CrawBot import skipped:', e.message);
}

module.exports = { app, startServer };
