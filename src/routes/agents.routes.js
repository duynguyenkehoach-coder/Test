/**
 * Agents Routes — Personal Agent System, style, messenger, fb-login
 */
const router = require('express').Router();
const express = require('express');
const database = require('../core/data_store/database');
const logger = require('../logger');
const knowledgeBase = require('../ai/agents/knowledgeBase');
const { buildAgentReply } = require('../ai/agents/promptBuilder');

// ── GET /api/agent/stats — Agent memory statistics ──────────────────────────
router.get('/api/agent/stats', (req, res) => {
    try {
        const memoryStore = require('../ai/agents/memoryStore');
        const memoryStats = memoryStore.getMemoryStats();
        const kbChunks = knowledgeBase.getChunkCount();
        res.json({
            ok: true,
            memory: memoryStats,
            knowledgeBase: { chunks: kbChunks },
        });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ── GET /api/agent/feedback-log — Recent feedback entries ───────────────────
router.get('/api/agent/feedback-log', (req, res) => {
    try {
        const memoryStore = require('../ai/agents/memoryStore');
        const limit = parseInt(req.query.limit) || 50;
        const raw = memoryStore.getRecentFeedback(limit);
        const formatted = raw.map(f => ({
            id: f.id,
            type: f.type,
            correct_role: f.correct_role,
            note: f.note,
            platform: f.platform,
            created_at: f.created_at,
            content_preview: (f.content || '').substring(0, 100) + '…',
        }));
        res.json({ ok: true, data: formatted, count: formatted.length });
    } catch (err) {
        res.json({ ok: false, error: err.message, data: [] });
    }
});

// ── GET /api/agents/:name — Get agent profile (via promptBuilder) ───────────
router.get('/api/agents/:name', (req, res) => {
    try {
        const profile = database.getAgentProfile(req.params.name);
        if (!profile) return res.status(404).json({ success: false, error: 'Agent not found' });
        res.json({ success: true, data: profile });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/agents/generate-reply — Generate AI reply (MUST be before /:name) ─
router.post('/api/agents/generate-reply', express.json(), async (req, res) => {
    try {
        const { agent_name, lead_id } = req.body;
        const agentProfile = database.getAgentProfile(agent_name);
        if (!agentProfile) return res.status(404).json({ success: false, error: 'Agent not found' });

        const lead = lead_id ? database.db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id) : null;
        const { system, user } = buildAgentReply(agentProfile, lead);

        let reply = '';
        try {
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                max_tokens: 300, temperature: 0.7,
            });
            reply = completion.choices[0]?.message?.content?.trim() || '';
        } catch (aiErr) {
            try {
                const { GoogleGenerativeAI } = require('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
                const result = await model.generateContent(`${system}\n\n${user}`);
                reply = result.response.text();
            } catch (geminiErr) {
                return res.status(500).json({ success: false, error: 'AI providers unavailable' });
            }
        }
        res.json({ success: true, reply, agent: agent_name });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/agents/:name — Save agent profile ─────────────────────────────
router.post('/api/agents/:name', express.json(), (req, res) => {
    try {
        const { name } = req.params;
        const { tone, personal_notes, deals_context, is_takeover } = req.body;
        database.saveAgentProfile(name, {
            tone: tone || 'professional',
            personal_notes: personal_notes || '',
            deals_context: deals_context || '',
            is_takeover: is_takeover ? 1 : 0,
        });
        res.json({ success: true, message: `Agent ${name} updated` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Try to load Personal Agent + Messenger modules ──────────────────────────
try {
    const personalAgent = require('../ai/agents/personalAgent');
    const styleExtractor = require('../ai/agents/styleExtractor');

    // GET /api/agents — List all agents + status
    router.get('/api/agents', (req, res) => {
        try {
            res.json({ success: true, agents: personalAgent.getAllAgents() });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/reply — Agent reply from customer message
    router.post('/api/agents/:name/reply', async (req, res) => {
        const { message, lead_id, lead_summary, platform, sender_name } = req.body || {};
        if (!message) return res.status(400).json({ success: false, error: 'message là bắt buộc' });
        try {
            const reply = await personalAgent.generateAgentReply(req.params.name, message, {
                leadId: lead_id, leadSummary: lead_summary, platform, senderName: sender_name,
            });
            res.json({ success: true, agent: req.params.name, reply });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/log — Log chat message
    router.post('/api/agents/:name/log', (req, res) => {
        const { lead_id, direction, message, is_teaching } = req.body || {};
        if (!direction || !message) return res.status(400).json({ success: false, error: 'direction và message là bắt buộc' });
        try {
            database.logChatMessage(req.params.name, lead_id || 0, direction, message, is_teaching ? 1 : 0);
            res.json({ success: true, message: '✅ Đã lưu chat history' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/teach — Mark teaching sample
    router.post('/api/agents/:name/teach', (req, res) => {
        const { chat_id, message } = req.body || {};
        try {
            if (chat_id) {
                personalAgent.markAsTeaching(chat_id);
            } else if (message) {
                database.logChatMessage(req.params.name, 0, 'sales', message, 1);
            } else {
                return res.status(400).json({ success: false, error: 'chat_id hoặc message là bắt buộc' });
            }
            res.json({ success: true, message: `🎓 Đã đánh dấu teaching sample cho ${req.params.name}` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // PATCH /api/agents/:name/mode — Change agent mode
    router.patch('/api/agents/:name/mode', (req, res) => {
        const { mode } = req.body || {};
        try {
            personalAgent.setAgentMode(req.params.name, mode);
            res.json({ success: true, agent: req.params.name, mode, message: `✅ ${req.params.name} Agent → ${mode}` });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // GET /api/agents/:name/style — View tone profile
    router.get('/api/agents/:name/style', (req, res) => {
        try {
            const profile = styleExtractor.getStyleProfile(req.params.name);
            const samples = styleExtractor.getWritingSamples(req.params.name);
            const styleRow = database.getSalesStyle(req.params.name);
            res.json({
                success: true, agent: req.params.name, profile, samples,
                sample_count: styleRow?.sample_count || 0,
                last_extracted: styleRow?.last_extracted || null,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/:name/extract-style — Trigger style extraction
    router.post('/api/agents/:name/extract-style', async (req, res) => {
        try {
            const result = await styleExtractor.extractStyleForAgent(req.params.name);
            res.json({
                success: true, agent: req.params.name,
                sample_count: result.sampleCount, profile: result.profile,
                message: `✅ Đã chiết xuất style cho ${req.params.name} (${result.sampleCount} mẫu)`,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/agents/:name/history — Chat history
    router.get('/api/agents/:name/history', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const chats = database.getRecentChats(req.params.name, limit);
            res.json({ success: true, agent: req.params.name, chats, total: chats.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    console.log('[Routes] ✅ Personal Agent routes loaded');
} catch (e) {
    console.warn('[Routes] ⚠️ Personal Agent routes skipped:', e.message);
}

// ── Messenger Scraper (learn from Messenger) ────────────────────────────────
try {
    const accountManager = require('../ai/agents/accountManager');
    const messengerScraper = require('../ai/agents/messengerScraper');

    // POST /api/agents/:name/learn-messenger
    router.post('/api/agents/:name/learn-messenger', async (req, res) => {
        const salesName = req.params.name;
        try {
            res.json({
                success: true,
                message: `🤖 CrawBot đang học từ Messenger của ${salesName}... Kiểm tra logs để theo dõi tiến trình.`,
            });
            setImmediate(async () => {
                const result = await messengerScraper.scrapeMessengerForSales(salesName, { autoExtract: true });
                console.log(`[Server] Messenger learning ${salesName}: ${JSON.stringify(result)}`);
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/agents/learn-all-messengers
    router.post('/api/agents/learn-all-messengers', async (req, res) => {
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

    // POST /api/accounts/:email/link-sales
    router.post('/api/accounts/:email/link-sales', (req, res) => {
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

    // Nightly Cron: 2AM VN time
    if (process.env.NODE_ENV === 'production') {
        const NIGHTLY_HOUR_UTC = 19;
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
        }, 60 * 1000);
        console.log('[Routes] ⏰ Nightly Messenger learning scheduled (2AM VN)');
    }

    console.log('[Routes] ✅ Messenger Scraper routes loaded');
} catch (e) {
    console.warn('[Routes] ⚠️ Messenger Scraper routes skipped:', e.message);
}

// ── FB Session Login ────────────────────────────────────────────────────────
try {
    const { chromium } = require('playwright-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    chromium.use(StealthPlugin());
    const accountManager = require('../ai/agents/accountManager');
    const fs = require('fs');
    const path = require('path');

    router.post('/api/agents/fb-login', async (req, res) => {
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
            await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
            await page.fill('#email', email);
            await new Promise(r => setTimeout(r, 800));
            await page.fill('#pass', password);
            await new Promise(r => setTimeout(r, 600));
            await page.click('[name="login"]');
            await new Promise(r => setTimeout(r, 5000));

            const url = page.url();

            if (url.includes('checkpoint') || url.includes('two_step_verification')) {
                return res.json({ success: false, error: '⚠️ Facebook yêu cầu xác thực 2 bước.' });
            }
            if (url.includes('/login')) {
                return res.json({ success: false, error: '❌ Email hoặc mật khẩu không đúng.' });
            }

            const cookies = await context.cookies();
            const sessionsDir = accountManager.SESSIONS_DIR;
            fs.mkdirSync(sessionsDir, { recursive: true });
            const sessionPath = path.join(sessionsDir, `${email.replace(/[^a-z0-9]/gi, '_')}.json`);
            fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));

            const existingAcc = database.db.prepare(`SELECT id FROM fb_accounts WHERE email = ?`).get(email);
            if (!existingAcc) {
                accountManager.addAccount({ email, password, proxyUrl: '', notes: `${salesName} personal account` });
            } else {
                database.db.prepare(`UPDATE fb_accounts SET password = ?, session_path = ?, status = 'active' WHERE email = ?`)
                    .run(password, sessionPath, email);
            }
            accountManager.linkAccountToSales(email, salesName);

            console.log(`[FBLogin] ✅ ${salesName} (${email}): Session đã lưu → ${path.basename(sessionPath)}`);
            res.json({
                success: true,
                message: `✅ ${salesName} đã đăng nhập thành công! Session được lưu.`,
                sessionFile: path.basename(sessionPath),
            });
        } catch (err) {
            console.error(`[FBLogin] ❌ ${salesName}: ${err.message}`);
            res.status(500).json({ success: false, error: `Lỗi khi đăng nhập: ${err.message}` });
        } finally {
            if (browser) await browser.close().catch(() => { });
        }
    });

    console.log('[Routes] ✅ FB Login endpoint loaded');
} catch (e) {
    console.warn('[Routes] ⚠️ FB Login endpoint skipped:', e.message);
}

module.exports = router;
