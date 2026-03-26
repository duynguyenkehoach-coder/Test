/**
 * Telegram Bot — Gửi thông báo bài viết mới
 */
'use strict';
const axios = require('axios');
const config = require('./config');

const API_BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

/**
 * Gửi 1 tin nhắn text về Telegram
 */
async function sendMessage(text) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        console.warn('[Telegram] ⚠️ Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
        return false;
    }
    try {
        await axios.post(`${API_BASE}/sendMessage`, {
            chat_id: config.TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }, { timeout: 10000 });
        return true;
    } catch (err) {
        console.error(`[Telegram] ❌ Gửi thất bại: ${err.message}`);
        return false;
    }
}

/**
 * Format 1 bài viết thành tin nhắn Telegram gọn gàng
 */
function formatPost(post, matchedKeywords) {
    const content = (post.content || '').substring(0, 500);
    const author = post.author_name || 'Ẩn danh';
    const group = post.group_name || 'N/A';
    const link = post.post_url || '#';
    const keywords = matchedKeywords.length > 0 ? matchedKeywords.join(', ') : 'N/A';
    const time = post.time_raw || '';

    return [
        `📢 <b>BÀI VIẾT MỚI</b>`,
        ``,
        `👤 <b>${escapeHtml(author)}</b>`,
        `📂 ${escapeHtml(group)}${time ? ` · ${escapeHtml(time)}` : ''}`,
        ``,
        `${escapeHtml(content)}${post.content && post.content.length > 500 ? '...' : ''}`,
        ``,
        `🔑 Từ khóa: <i>${escapeHtml(keywords)}</i>`,
        `🔗 <a href="${link}">Xem bài viết</a>`,
    ].join('\n');
}

/**
 * Gửi batch nhiều bài viết — delay 1s giữa mỗi tin tránh rate limit
 */
async function sendBatch(posts, matchKeywordsFn) {
    if (posts.length === 0) return;

    console.log(`[Telegram] 📤 Đang gửi ${posts.length} bài viết...`);
    let sent = 0;

    for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const matched = matchKeywordsFn ? matchKeywordsFn(post.content) : [];
        const text = formatPost(post, matched);
        const ok = await sendMessage(text);
        if (ok) sent++;

        // Delay 1s giữa mỗi tin để tránh rate limit Telegram (30 msg/s)
        if (i < posts.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    console.log(`[Telegram] ✅ Đã gửi ${sent}/${posts.length} bài`);
}

/**
 * Gửi tin nhắn hệ thống (thông báo bắt đầu/kết thúc scan)
 */
async function sendSystemMessage(text) {
    return sendMessage(`🤖 <b>SYSTEM</b>\n${text}`);
}

/**
 * Escape HTML entities để tránh lỗi parse_mode
 */
function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = { sendMessage, sendBatch, sendSystemMessage, formatPost };
