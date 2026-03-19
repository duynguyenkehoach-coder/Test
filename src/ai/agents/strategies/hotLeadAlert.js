/**
 * ⚡ Hot Lead Alert — Real-time Telegram Notification + AI Pre-written Message
 * 
 * Khi AI phát hiện lead nóng (score 80+):
 * 1. Push Telegram notification NGAY LẬP TỨC
 * 2. Kèm tin nhắn AI viết sẵn (ready to copy-paste)
 * 3. Inline buttons: "🔗 Xem post" | "👤 Mở profile" | "📋 Copy tin nhắn"
 * 4. Sales click → mở profile → paste → gửi → done trong 5 phút
 * 
 * Tận dụng:
 * - telegramBot.js → sendMessage() with inline_keyboard
 * - outreachGenerator.js → generateDM()
 * 
 * Tích hợp hook: Gọi `onHotLeadDetected(lead)` từ pipeline khi lead mới vào
 * 
 * @module agent/strategies/hotLeadAlert
 */
'use strict';

const { sendMessage } = require('../../core/integrations/telegramBot');
const { generateDM } = require('../../ai/outreachGenerator');
const database = require('../../core/data_store/database');

// ─── Config ──────────────────────────────────────────────────────────────────
const HOT_SCORE_THRESHOLD = 80;
const CRITICAL_SCORE_THRESHOLD = 90;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown per lead

// Track sent alerts to avoid spam
const _alertCache = new Map(); // leadId → timestamp

/**
 * Check if alert was already sent recently for this lead
 */
function wasRecentlyAlerted(leadId) {
    const lastSent = _alertCache.get(leadId);
    if (!lastSent) return false;
    return Date.now() - lastSent < ALERT_COOLDOWN_MS;
}

/**
 * Build rich Telegram alert for a hot lead
 */
function buildAlertMessage(lead, aiMessage, isEmergency = false) {
    const icon = isEmergency ? '🚨🔥' : '🎯⚡';
    const urgencyText = isEmergency ? 'CỰC NÓNG — PHẢN HỒI NGAY!' : 'Lead nóng — ưu tiên cao';
    const scoreBar = '█'.repeat(Math.round(lead.score / 10)) + '░'.repeat(10 - Math.round(lead.score / 10));

    const escape = (t) => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `
${icon} <b>${urgencyText}</b>

📊 <b>Score:</b> ${lead.score}/100 [${scoreBar}]
🏷️ <b>Category:</b> ${escape(lead.category || 'General')}
🌐 <b>Language:</b> ${lead.language === 'vietnamese' ? '🇻🇳 VN' : '🌍 EN'}

👤 <b>Khách:</b> ${escape(lead.author_name || 'Unknown')}

💡 <b>Tóm tắt:</b>
${escape((lead.summary || '').substring(0, 200))}

📝 <b>Bài post gốc:</b>
<i>${escape((lead.content || '').substring(0, 250))}${(lead.content || '').length > 250 ? '...' : ''}</i>

━━━ 🤖 TIN NHẮN AI VIẾT SẴN ━━━
<code>${escape(aiMessage)}</code>

⏱️ <b>Copy tin nhắn ↑ → Mở Profile → Paste → Gửi!</b>
    `.trim();
}

/**
 * Send hot lead alert to Telegram with AI pre-written message
 * THIS IS THE MAIN FUNCTION — call from pipeline when new lead is detected
 * 
 * @param {object} lead - Lead object from DB
 * @param {object} opts
 * @param {string} opts.staffName - Sales staff (for AI tone)
 * @returns {{ sent: boolean, aiMessage: string }}
 */
async function onHotLeadDetected(lead, opts = {}) {
    const { staffName = 'Đức Anh' } = opts;

    // Check thresholds
    if (!lead || lead.score < HOT_SCORE_THRESHOLD) return { sent: false, aiMessage: '' };

    // Check cooldown
    if (wasRecentlyAlerted(lead.id)) {
        console.log(`[HotAlert] ⏳ Lead #${lead.id} already alerted recently — skipping`);
        return { sent: false, aiMessage: '', reason: 'cooldown' };
    }

    const isCritical = lead.score >= CRITICAL_SCORE_THRESHOLD;
    console.log(`[HotAlert] ${isCritical ? '🚨' : '⚡'} Hot lead detected: #${lead.id} (score: ${lead.score})`);

    try {
        // 1. AI writes outreach message
        let aiMessage = '';
        try {
            const result = await generateDM(lead, { staffName, tone: 'friendly' });
            aiMessage = result.message;
            console.log(`[HotAlert] 🤖 AI message ready: "${aiMessage.substring(0, 60)}..."`);
        } catch (e) {
            console.error(`[HotAlert] ⚠️ AI message failed: ${e.message}`);
            aiMessage = lead.language === 'vietnamese'
                ? `Chào bạn! Mình thấy bạn đang cần dịch vụ ${lead.category || 'vận chuyển'}. Bên mình có thể hỗ trợ — inbox mình nghe tư vấn nhé! 👍`
                : `Hi! I saw your post about ${lead.category || 'shipping'}. We can help — feel free to DM me for details! 👍`;
        }

        // 2. Build Telegram message
        const alertText = buildAlertMessage(lead, aiMessage, isCritical);

        // 3. Build inline keyboard
        const buttons = [];
        if (lead.post_url) buttons.push({ text: '🔗 Xem bài post', url: lead.post_url });
        if (lead.author_url) buttons.push({ text: '👤 Mở profile', url: lead.author_url });

        const telegramOpts = {};
        if (buttons.length > 0) {
            telegramOpts.reply_markup = JSON.stringify({ inline_keyboard: [buttons] });
        }

        // 4. Send alert
        const sent = await sendMessage(alertText, telegramOpts);

        if (sent) {
            _alertCache.set(lead.id, Date.now());
            console.log(`[HotAlert] ✅ Alert sent for lead #${lead.id}`);

            // Log to DB
            try {
                database.db.prepare(`
                    INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status)
                    VALUES (?, ?, 'telegram_alert', ?, 1, 'alerted')
                `).run(lead.id, staffName, aiMessage);
            } catch { }
        }

        return { sent, aiMessage };

    } catch (e) {
        console.error(`[HotAlert] ❌ Alert failed: ${e.message}`);
        return { sent: false, aiMessage: '', error: e.message };
    }
}

/**
 * Manually trigger alerts for all unalerted hot leads
 * @param {object} opts
 * @returns {Array<{leadId, sent, score}>}
 */
async function alertAllHotLeads(opts = {}) {
    const { staffName = 'Đức Anh', minScore = HOT_SCORE_THRESHOLD, limit = 10 } = opts;

    const leads = database.db.prepare(`
        SELECT l.* FROM leads l
        LEFT JOIN outreach_log ol ON l.id = ol.lead_id AND ol.channel = 'telegram_alert'
        WHERE l.score >= ? AND l.role = 'buyer' AND l.status != 'ignored'
        AND ol.id IS NULL
        ORDER BY l.score DESC LIMIT ?
    `).all(minScore, limit);

    console.log(`[HotAlert] ⚡ Found ${leads.length} un-alerted hot leads`);

    const results = [];
    for (const lead of leads) {
        const result = await onHotLeadDetected(lead, { staffName });
        results.push({ leadId: lead.id, score: lead.score, ...result });

        // Delay between alerts (1-3 seconds to avoid Telegram rate limit)
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }

    return results;
}

module.exports = { onHotLeadDetected, alertAllHotLeads, HOT_SCORE_THRESHOLD };
