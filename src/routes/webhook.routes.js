/**
 * Webhook Routes — Facebook Messenger + Telegram alerts
 */
const router = require('express').Router();
const express = require('express');
const axios = require('axios');
const database = require('../core/data_store/database');
const { generateCopilotReply, classifyIntent } = require('../ai/prompts/salesCopilot');

// ── Telegram Alert Helper ───────────────────────────────────────────────────
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

// ── GET /webhook — Facebook verification ────────────────────────────────────
router.get('/webhook', (req, res) => {
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

// ── POST /webhook — Receive messages from Facebook Messenger ────────────────
router.post('/webhook', async (req, res) => {
    const body = req.body;
    res.status(200).send('EVENT_RECEIVED');

    if (body.object !== 'page') return;

    for (const entry of (body.entry || [])) {
        for (const event of (entry.messaging || [])) {
            if (!event.message?.text) continue;

            const senderId = event.sender.id;
            const messageText = event.message.text;

            console.log(`\n[Webhook] 💬 Tin nhắn mới từ ${senderId}: "${messageText}"`);

            try {
                const intent = await classifyIntent(messageText);
                console.log(`[Webhook] 🏷️ Intent: ${intent}`);

                const aiSuggestion = await generateCopilotReply(messageText, {
                    senderId, platform: 'facebook',
                });

                database.insertConversation.run({
                    sender_id: senderId,
                    sender_name: `FB User ${senderId.slice(-4)}`,
                    message: messageText,
                    ai_suggestion: aiSuggestion,
                    intent,
                    platform: 'facebook',
                });

                await sendTelegramAlert(senderId, messageText, aiSuggestion, intent);
            } catch (err) {
                console.error('[Webhook] ✗ Error processing message:', err.message);
            }
        }
    }
});

// ── POST /api/test-message — Manual test webhook ────────────────────────────
router.post('/api/test-message', async (req, res) => {
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

module.exports = router;
