const express = require('express');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const database = require('./database');
const logger = require('./logger');
const { generateCopilotReply, classifyIntent } = require('./copilot');
const { listDataFiles, readDataFile, cleanOldData, saveConversationToFile } = require('./dataManager');

const app = express();
let server = null; // keep reference for graceful shutdown

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

app.patch('/api/leads/:id', (req, res) => {
    try {
        const { status, notes, suggested_response } = req.body;
        if (status && !['new', 'contacted', 'converted', 'ignored'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        database.updateLeadStatus.run({
            id: parseInt(req.params.id),
            status: status || 'new',
            notes: notes !== undefined ? notes : null,
            suggested_response: suggested_response !== undefined ? suggested_response : null,
        });
        const updated = database.getLeadById.get(parseInt(req.params.id));
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

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
        runPipeline().catch(console.error); // Run async
        res.json({ success: true, message: 'Scan started in background' });
    } catch (err) {
        logger.error('Server', 'Manual scan trigger failed', { error: err.message });
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

module.exports = { app, startServer };
