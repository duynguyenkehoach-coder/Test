const express = require('express');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const database = require('./data_store/database');
const logger = require('./logger');
const { generateCopilotReply, classifyIntent } = require('./prompts/salesCopilot');
const { listDataFiles, readDataFile, cleanOldData, saveConversationToFile } = require('./data_store/fileManager');

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
app.use(express.static(path.join(__dirname, '..', 'public')));

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
        const stats = database.getStats();
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
        const sv = require('./pipelines/sociaVault');
        const log = sv.getCreditLog();
        const stats = sv.getCreditStats();
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
        const { runPipeline } = require('./index');
        const config = require('./config');
        // Dùng config.ENABLED_PLATFORMS thay vì hardcode — FB-only mode
        runPipeline({ platforms: config.ENABLED_PLATFORMS }).catch(console.error);
        res.json({ success: true, message: `Scan started (${config.ENABLED_PLATFORMS.join(', ')})` });
    } catch (err) {
        logger.error('Server', 'Manual scan trigger failed', { error: err.message });
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
        groupDb.upsertGroup({
            name,
            url,
            category: category || 'unknown',
            relevance_score: 50, // Default for new
            notes: notes || '',
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
    server = app.listen(port, () => {
        logger.info('Server', `Dashboard: http://localhost:${port}`);
        logger.info('Server', `Webhook:   http://localhost:${port}/webhook`);
        logger.info('Server', `Health:    http://localhost:${port}/health`);
        logger.info('Server', `CSV Export: http://localhost:${port}/api/leads/export`);
    });
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

// ╔══════════════════════════════════════════════════════╗
// ║  GROUP DISCOVERY DATABASE API                         ║
// ╚══════════════════════════════════════════════════════╝
const groupDiscovery = require('./agent/groupDiscovery');
// Initialize on startup (seeds 107 groups if empty)
try { groupDiscovery.getDb(); logger.info('GroupDB', `Group database initialized`); } catch (e) { logger.warn('GroupDB', e.message); }

// GET /api/groups — List all groups with optional filters
app.get('/api/groups', (req, res) => {
    try {
        const { category, status, limit } = req.query;
        const groups = groupDiscovery.getAllGroups({ category, status, limit: limit ? parseInt(limit) : undefined });
        res.json({ ok: true, data: groups, count: groups.length });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/groups/stats — Group database stats
app.get('/api/groups/stats', (req, res) => {
    try {
        res.json({ ok: true, data: groupDiscovery.getStats() });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/groups — Add new group manually
app.post('/api/groups', (req, res) => {
    try {
        const { name, url, category, relevance_score, notes } = req.body;
        if (!name || !url) return res.status(400).json({ ok: false, error: 'name and url required' });
        groupDiscovery.upsertGroup({ name, url, category: category || 'unknown', relevance_score: relevance_score || 50, notes });
        res.json({ ok: true, message: `Group '${name}' added/updated` });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/groups/:id — Update group score or status
app.patch('/api/groups/:id', (req, res) => {
    try {
        const { url, relevance_score, status } = req.body;
        if (!url) return res.status(400).json({ ok: false, error: 'url required' });
        if (relevance_score !== undefined) groupDiscovery.updateScore(url, relevance_score);
        if (status) groupDiscovery.setStatus(url, status);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
        const ALLOWED = ['assigned_to', 'claimed_by', 'claimed_at', 'status', 'notes', 'suggested_response'];
        const updates = Object.fromEntries(
            Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
        );
        if (!Object.keys(updates).length) return res.status(400).json({ ok: false, error: 'No valid fields' });

        // ═══ CLAIM & LOCK CHECK ═══
        if (updates.claimed_by !== undefined) {
            const current = database.db.prepare('SELECT claimed_by, status FROM leads WHERE id = ?').get(id);
            if (current && current.claimed_by && updates.claimed_by && current.claimed_by !== updates.claimed_by) {
                // Someone else already claimed this lead → LOCK
                return res.status(403).json({
                    ok: false, locked: true,
                    by: current.claimed_by,
                    error: `Lead đã được ${current.claimed_by} tiếp nhận`
                });
            }
            // Auto-manage claim state
            if (updates.claimed_by) {
                updates.claimed_at = new Date().toISOString();
                if (!updates.status) updates.status = 'claimed';
                updates.assigned_to = updates.claimed_by; // Keep assigned_to in sync
            } else {
                // Unclaim
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

        // ═══ AUTO-LOG to sales_activities ═══
        if (updates.claimed_by) {
            try {
                database.db.prepare(
                    `INSERT INTO sales_activities (lead_id, staff_name, action_type, note) VALUES (?, ?, 'CLAIM', ?)`
                ).run(id, updates.claimed_by, `Claimed lead #${id}`);
            } catch (e) { /* ignore logging errors */ }
        }
        if (updates.status === 'contacted' && lead?.claimed_by) {
            try {
                database.db.prepare(
                    `INSERT INTO sales_activities (lead_id, staff_name, action_type, note) VALUES (?, ?, 'CONTACT', ?)`
                ).run(id, lead.claimed_by, `Contacted lead #${id}`);
            } catch (e) { /* ignore */ }
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

module.exports = { app, startServer };
