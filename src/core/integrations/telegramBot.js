const axios = require('axios');
const config = require('../../config');

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

/**
 * Send a message via Telegram Bot (with optional inline keyboard)
 */
async function sendMessage(text, options = {}) {
    if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN === 'your_telegram_bot_token') {
        console.log('[Notifier] ⚠️ Telegram not configured, skipping notification');
        return false;
    }
    if (!config.TELEGRAM_CHAT_ID || config.TELEGRAM_CHAT_ID === 'your_telegram_chat_id') {
        console.log('[Notifier] ⚠️ Telegram Chat ID not configured, skipping notification');
        return false;
    }

    try {
        const payload = {
            chat_id: config.TELEGRAM_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options,
        };
        await axios.post(`${TELEGRAM_API}/sendMessage`, payload, { timeout: 10000 });
        return true;
    } catch (err) {
        console.error('[Notifier] ✗ Telegram send failed:', err.response?.data?.description || err.message);
        return false;
    }
}

/**
 * Format a lead into a rich Telegram message for Sales team
 */
function formatLeadMessage(lead) {
    const platformEmojis = { facebook: '📘', instagram: '📷', reddit: '🟠', twitter: '🐦', tiktok: '🎵' };
    const platformEmoji = platformEmojis[lead.platform] || '🌐';
    const urgencyEmoji = { low: '🟢', medium: '🟡', high: '🔴' };
    const urgencyLabel = { low: 'Thấp', medium: 'Trung bình', high: 'Cao' };

    const scoreBar = '█'.repeat(Math.round(lead.score / 10)) + '░'.repeat(10 - Math.round(lead.score / 10));
    const serviceTag = lead.category && lead.category !== 'NotRelevant' ? `\n🏷️ <b>Dịch vụ phù hợp:</b> ${escapeHtml(lead.category)}` : '';

    // Time info
    let timeInfo = '';
    if (lead.post_created_at) {
        const postDate = new Date(lead.post_created_at);
        const diffMs = Date.now() - postDate.getTime();
        const diffHrs = Math.round(diffMs / 3600000);
        const diffDays = Math.round(diffMs / 86400000);
        const timeAgo = diffHrs < 1 ? 'Vừa đăng' : diffHrs < 24 ? `${diffHrs} giờ trước` : `${diffDays} ngày trước`;
        timeInfo = `\n⏰ <b>Đăng lúc:</b> ${postDate.toLocaleString('vi-VN')} (${timeAgo})`;
    }

    return `
${platformEmoji} <b>🎯 LEAD MỚI — ${lead.platform.toUpperCase()}</b>

📊 <b>Điểm:</b> ${lead.score}/100 [${scoreBar}]
${urgencyEmoji[lead.urgency] || '🟢'} <b>Độ gấp:</b> ${urgencyLabel[lead.urgency] || 'Thấp'}${serviceTag}${timeInfo}

👤 <b>Người đăng:</b> ${escapeHtml(lead.author_name || 'Unknown')}

💡 <b>Tóm tắt:</b>
${escapeHtml(lead.summary || '')}

📝 <b>Nội dung gốc:</b>
<i>${escapeHtml(truncate(lead.content, 300))}</i>

💬 <b>Gợi ý trả lời:</b>
<code>${escapeHtml(truncate(lead.suggested_response || 'Chưa có gợi ý', 400))}</code>
  `.trim();
}

/**
 * Notify about a new lead with inline buttons
 */
async function notifyNewLead(lead) {
    const message = formatLeadMessage(lead);

    // Build inline keyboard with action buttons
    const buttons = [];
    if (lead.post_url) {
        buttons.push({ text: '🔗 Xem bài viết gốc', url: lead.post_url });
    }
    if (lead.author_url) {
        buttons.push({ text: '👤 Xem profile', url: lead.author_url });
    }

    const options = {};
    if (buttons.length > 0) {
        options.reply_markup = JSON.stringify({
            inline_keyboard: [buttons],
        });
    }

    const sent = await sendMessage(message, options);
    if (sent) {
        console.log(`[Notifier] ✅ Lead #${lead.id || '?'} sent to Telegram (score: ${lead.score})`);
    }
    return sent;
}

/**
 * Send scan summary to channel
 */
async function notifyScanSummary(stats) {
    const platformEmojis = { facebook: '📘', instagram: '📷', reddit: '🟠', twitter: '🐦', tiktok: '🎵' };
    let platformLines = '';
    if (stats.platforms) {
        for (const [p, s] of Object.entries(stats.platforms)) {
            const emoji = platformEmojis[p] || '🌐';
            platformLines += `  ${emoji} ${p}: ${s.posts} bài → ${s.leads} lead\n`;
        }
    }

    const time = new Date().toLocaleString('vi-VN');
    const message = `
🔄 <b>BÁO CÁO QUÉT DỮ LIỆU</b>
🕐 ${time}

📊 <b>Kết quả theo nền tảng:</b>
${platformLines}
⏱️ <b>Thời gian xử lý:</b> ${stats.duration}s
🏆 <b>Tổng lead mới:</b> ${stats.totalLeads}
${stats.totalLeads > 0 ? '\n⬇️ Chi tiết từng lead sẽ được gửi bên dưới...' : '\n😴 Không có lead mới lần này. Hệ thống sẽ quét lại sau 30 phút.'}
  `.trim();

    return sendMessage(message);
}

/**
 * Send system alert (errors, rate limits, etc.)
 */
async function notifyAlert(alertText) {
    const message = `
⚠️ <b>CẢNH BÁO HỆ THỐNG</b>
🕐 ${new Date().toLocaleString('vi-VN')}

${escapeHtml(alertText)}
  `.trim();
    return sendMessage(message);
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function truncate(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
}

module.exports = { sendMessage, notifyNewLead, notifyScanSummary, notifyAlert };
