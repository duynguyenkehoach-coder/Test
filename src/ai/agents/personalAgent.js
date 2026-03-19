/**
 * Personal Agent Engine v1.0 — THG CrawBot Intelligence Layer
 *
 * Core engine để từng Sales Agent (Trang, Moon, Min...) reply tin nhắn
 * với đúng giọng điệu của chủ nhân mình.
 *
 * Flow:
 * 1. Lấy style profile từ DB (StyleExtractor đã tạo trước)
 * 2. Build dynamic prompt với Master Brain (THG knowledge) + nghệ phong cách
 * 3. Gọi Gemini để sinh reply
 * 4. Log vào chat_history để tiếp tục học
 */

'use strict';

const config = require('../../config');
const database = require('../../core/data_store/database');
const { getStyleProfile, getWritingSamples } = require('./styleExtractor');
const { generateText } = require('../aiProvider');

const SALES_TEAM = ['Đức Anh', 'Min', 'Moon', 'Lê Huyền', 'Ngọc Huyền'];

// ─── Master Brain (THG Knowledge — bất biến) ──────────────────────────────
const MASTER_BRAIN = `
KIẾN THỨC BẮT BUỘC CỦA THG (không được sai lệch):
• THG Fulfillment: Seller gửi thiết kế → THG in + đóng gói + ship sang Mỹ (POD/Dropship)
• THG Express: Tuyến VN/CN → Mỹ, tracking chuẩn TikTok/Amazon policy
• THG Warehouse: Kho tại Pennsylvania & North Carolina, ship nội địa Mỹ 2-5 ngày
• Cam kết: Mất hàng đền 100%
• Không báo giá cụ thể qua chat — mời khách để lại SĐT hoặc inbox để báo giá chính xác
`.trim();

// ─── Prompt Builder ─────────────────────────────────────────────────────────

/**
 * Xây dựng system prompt cá nhân hóa cho từng agent
 * @param {string} salesName 
 * @param {object} profile - tone profile từ StyleExtractor
 * @param {string[]} writingSamples - 3-5 câu mẫu tốt nhất
 * @returns {string}
 */
function buildSystemPrompt(salesName, profile, writingSamples) {
    const iconList = (profile.favorite_icons || []).join(' ');
    const phrases = (profile.common_phrases || []).map(p => `"${p}"`).join(', ');
    const tags = (profile.personality_tags || []).join(', ');
    const pronounSelf = profile.pronouns?.self || salesName;
    const pronounCustomer = profile.pronouns?.customer || 'anh/chị';
    const samplesText = writingSamples.length > 0
        ? `\nCÂU MẪU THỰC TẾ CỦA ${salesName.toUpperCase()}:\n${writingSamples.slice(0, 5).map((s, i) => `  ${i + 1}. "${s}"`).join('\n')}`
        : '';

    return `Bạn là ${salesName} Agent — trợ lý ảo đại diện cho Sales ${salesName} tại THG Logistics.
Nhiệm vụ: Nhập vai 100% thành ${salesName}, trả lời tin nhắn khách hàng đúng giọng điệu thực tế của ${salesName}.

━━━ VĂN PHONG CỦA ${salesName.toUpperCase()} (học từ chat thực tế) ━━━
• Câu chào: ${profile.greeting || `Dạ ${salesName} xin chào ạ!`}
• Câu kết: ${profile.sign_off || `Mọi thắc mắc ${pronounCustomer} cứ nhắn ${salesName} nhé ạ!`}
• Xưng: "${pronounSelf}" — Gọi khách: "${pronounCustomer}"
• Icon hay dùng: ${iconList || '(chưa có dữ liệu)'}
• Cụm từ đặc trưng: ${phrases || '(chưa có dữ liệu)'}
• Phong cách: ${tags || 'thân thiện, nhiệt tình'}
• Độ dài câu trả lời: ~${profile.avg_length || 35} từ${samplesText}

━━━ MASTER BRAIN — KIẾN THỨC THG (BẤT BIẾN) ━━━
${MASTER_BRAIN}

━━━ QUY TẮC BẮT BUỘC ━━━
1. CHỈ trả về nội dung tin nhắn, KHÔNG giải thích thêm
2. Giữ đúng phong cách ${salesName} — KHÔNG dùng giọng robot hay quá formal
3. Nếu khách hỏi giá → không báo giá cụ thể, mời để lại SĐT
4. Độ dài: ngắn gọn tự nhiên như chat Messenger (${profile.avg_length || 35} từ)
5. Dùng icon như ${salesName} hay dùng: ${iconList || ''}`;
}

// ─── Reply Generator ─────────────────────────────────────────────────────────

/**
 * Agent reply với full personalized style
 * @param {string} salesName 
 * @param {string} customerMessage 
 * @param {object} context - { leadId, leadSummary, platform, senderName }
 * @returns {string} reply text
 */
async function generateAgentReply(salesName, customerMessage, context = {}) {
    // Lấy agent mode
    const agentRow = database.getAgentProfile(salesName);
    if (!agentRow) {
        return generateGenericReply(customerMessage);
    }

    if (agentRow.mode === 'paused') {
        return null; // Agent tắt — không reply gì cả
    }

    // Build prompt
    const profile = getStyleProfile(salesName);
    const samples = getWritingSamples(salesName);
    const systemPrompt = buildSystemPrompt(salesName, profile, samples);

    const contextInfo = [
        context.leadSummary ? `Lead context: ${context.leadSummary}` : '',
        context.senderName ? `Tên khách: ${context.senderName}` : '',
        context.platform ? `Platform: ${context.platform}` : '',
    ].filter(Boolean).join('\n');

    const userPrompt = `${contextInfo ? contextInfo + '\n\n' : ''}Khách vừa nhắn:
"${customerMessage}"

${salesName} Agent, hãy reply:`;

    try {
        const fullPrompt = systemPrompt + '\n\n' + userPrompt;
        const reply = await generateText(
            systemPrompt,
            userPrompt,
            { maxTokens: 300, temperature: 0.4 }
        );

        if (!reply) {
            return generateGenericReply(customerMessage);
        }

        let cleaned = reply.trim();
        // Xoá quotes nếu AI bọc
        if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
            (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
            cleaned = cleaned.slice(1, -1).trim();
        }

        // Log reply vào chat_history (để tích lũy data học)
        if (context.leadId) {
            database.logChatMessage(salesName, context.leadId, 'sales', cleaned, 0);
        }

        console.log(`[${salesName}Agent] ✅ Reply: ${cleaned.substring(0, 80)}...`);
        return cleaned;

    } catch (err) {
        console.error(`[${salesName}Agent] ❌ AI error: ${err.message}`);
        return generateGenericReply(customerMessage);
    }
}

// Groq fallback removed — cascade handles all fallbacks automatically via aiProvider.js

/**
 * Last resort reply khi AI không khả dụng
 */
function generateGenericReply(message) {
    return 'Dạ THG đã nhận được tin nhắn của anh/chị! Để được tư vấn chi tiết nhất, anh/chị để lại số điện thoại để Sales THG liên hệ ngay nhé ạ! 🙏';
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

/**
 * Log tin nhắn vào chat_history 
 * @param {string} salesName 
 * @param {number} leadId  
 * @param {'sales'|'customer'} direction 
 * @param {string} message 
 * @param {boolean} isTeaching 
 */
function logMessage(salesName, leadId, direction, message, isTeaching = false) {
    return database.logChatMessage(salesName, leadId, direction, message, isTeaching);
}

/**
 * Đánh dấu tin nhắn là teaching sample (Agent ưu tiên học từ đây)
 * @param {number} chatId 
 */
function markAsTeaching(chatId) {
    return database.markTeachingSample(chatId);
}

// ─── Mode Management ─────────────────────────────────────────────────────────

/**
 * Chuyển mode của agent
 * @param {string} salesName 
 * @param {'learning'|'active'|'paused'} mode 
 */
function setAgentMode(salesName, mode) {
    if (!['learning', 'active', 'paused'].includes(mode)) {
        throw new Error(`Invalid mode: ${mode}. Must be learning|active|paused`);
    }
    database.db.prepare(`
        UPDATE agent_profiles SET mode = ?, updated_at = datetime('now') WHERE name = ?
    `).run(mode, salesName);
    console.log(`[PersonalAgent] 🔄 ${salesName}: mode → ${mode}`);
}

/**
 * Lấy toàn bộ thông tin agents + style stats
 */
function getAllAgents() {
    const profiles = database.getAgentProfiles();
    return profiles.map(p => {
        const style = database.getSalesStyle(p.name);
        let profile = {};
        try { profile = JSON.parse(style?.tone_profile || '{}'); } catch { }
        return {
            ...p,
            style_extracted: !!profile.greeting,
            sample_count: style?.sample_count || 0,
            last_extracted: style?.last_extracted || null,
            personality_tags: profile.personality_tags || [],
        };
    });
}

module.exports = {
    generateAgentReply,
    logMessage,
    markAsTeaching,
    setAgentMode,
    getAllAgents,
    buildSystemPrompt,
    SALES_TEAM,
};
