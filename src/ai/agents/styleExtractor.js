/**
 * Style Extractor Agent v1.0 — THG CrawBot Intelligence Layer
 *
 * Phân tích lịch sử chat của từng Sales và chiết xuất "DNA văn phong":
 * - Cách chào, xưng hô, ký tên
 * - Icon hay dùng
 * - Độ dài trung bình câu trả lời
 * - Phong cách: thân thiện / chuyên nghiệp / ngắn gọn
 *
 * Kết quả được lưu vào bảng `sales_styles` để PersonalAgent dùng khi reply.
 */

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config');
const database = require('../../core/data_store/database');

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: config.GEMINI_MODEL || 'gemini-1.5-flash' });

// ─── Default profile (dùng khi chưa đủ data để học) ────────────────────────
const DEFAULT_PROFILES = {
    Trang: {
        greeting: 'Dạ Trang chào anh/chị ạ!',
        sign_off: 'Mọi thắc mắc anh/chị cứ nhắn Trang nhé ạ 🙏',
        formality: 'friendly',
        pronouns: { self: 'em Trang', customer: 'anh/chị' },
        avg_length: 35,
        favorite_icons: ['🚛', '📦', '✨'],
        common_phrases: ['Dạ ạ', 'anh/chị ơi', 'bên Trang'],
        personality_tags: ['nhiệt tình', 'thân thiện', 'chuyên nghiệp'],
    },
    Moon: {
        greeting: 'Hi bạn, Moon đây!',
        sign_off: 'Inbox Moon để Moon hỗ trợ nhé!',
        formality: 'casual',
        pronouns: { self: 'Moon', customer: 'bạn' },
        avg_length: 25,
        favorite_icons: ['🌙', '💫', '🔥'],
        common_phrases: ['xịn lắm', 'super nhanh', 'giá oki'],
        personality_tags: ['năng động', 'hiện đại', 'Gen Z'],
    },
    Min: {
        greeting: 'Dạ chào anh/chị, Min đây ạ!',
        sign_off: 'Anh/chị cần gì nhắn Min ngay nhé ạ!',
        formality: 'professional',
        pronouns: { self: 'em Min', customer: 'anh/chị' },
        avg_length: 40,
        favorite_icons: ['📊', '✅', '🎯'],
        common_phrases: ['Dạ vâng ạ', 'chính xác ạ', 'em sẽ check ngay'],
        personality_tags: ['cẩn thận', 'chuyên nghiệp', 'tỉ mỉ'],
    },
    'Lê Huyền': {
        greeting: 'Dạ chào anh/chị, Huyền đây ạ!',
        sign_off: 'Anh/chị inbox Huyền nhé ạ!',
        formality: 'friendly',
        pronouns: { self: 'em Huyền', customer: 'anh/chị' },
        avg_length: 35,
        favorite_icons: ['💼', '🌟', '❤️'],
        common_phrases: ['Dạ ạ', 'em xin phép', 'Huyền hỗ trợ'],
        personality_tags: ['nhiệt tình', 'chu đáo'],
    },
    'Ngọc Huyền': {
        greeting: 'Dạ bên Ngọc Huyền xin chào anh/chị ạ!',
        sign_off: 'Cần hỗ trợ anh/chị cứ nhắn Ngọc Huyền nhé!',
        formality: 'professional',
        pronouns: { self: 'Ngọc Huyền', customer: 'anh/chị' },
        avg_length: 38,
        favorite_icons: ['📋', '🤝', '✨'],
        common_phrases: ['Dạ ạ', 'xin phép', 'theo như thông tin'],
        personality_tags: ['chuyên nghiệp', 'trọng tâm'],
    },
};

// ─── AI Extraction ──────────────────────────────────────────────────────────

/**
 * Dùng AI để phân tích 50 câu chat gần nhất của một Sales
 * và rút ra "DNA văn phong"
 * @param {string} salesName 
 * @returns {object} tone profile JSON
 */
async function extractStyleWithAI(salesName, chatSamples) {
    const sampleText = chatSamples
        .map((s, i) => `${i + 1}. "${s}"`)
        .join('\n');

    const prompt = `Bạn là AI chuyên phân tích văn phong. Hãy phân tích ${chatSamples.length} tin nhắn sau của Sales "${salesName}" làm việc tại THG Logistics, và trả về JSON MÔ TẢ CHÍNH XÁC phong cách của họ.

TIN NHẮN MẪU CỦA ${salesName.toUpperCase()}:
${sampleText}

Hãy trả về JSON với cấu trúc sau (CHỈ JSON, không giải thích thêm):
{
  "greeting": "câu chào đặc trưng nhất",
  "sign_off": "câu kết thúc/CTA đặc trưng",
  "formality": "casual|friendly|professional",
  "pronouns": {
    "self": "cách xưng tên (em/mình/tên riêng...)",
    "customer": "cách gọi khách (anh/chị/bạn...)"
  },
  "avg_length": <số từ trung bình mỗi câu>,
  "favorite_icons": ["icon1", "icon2"],
  "common_phrases": ["cụm từ1", "cụm từ2", "cụm từ3"],
  "personality_tags": ["tag1", "tag2"]
}`;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();

        // Strip markdown code block nếu có
        text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

        const profile = JSON.parse(text);
        console.log(`[StyleExtractor] ✅ ${salesName}: Đã chiết xuất profile`);
        return profile;
    } catch (err) {
        console.error(`[StyleExtractor] ❌ ${salesName}: AI extraction failed — ${err.message}`);
        return null;
    }
}

/**
 * Chọn 10 câu mẫu tốt nhất (teaching samples ưu tiên, còn lại lấy dài nhất)
 * @param {string} salesName 
 * @param {string[]} recentMessages
 * @returns {string[]}
 */
function selectBestSamples(salesName, recentMessages) {
    const teachingSamples = database.getTeachingSamples(salesName);

    // Combine: teaching samples + các câu dài nhất > 20 từ từ recent chats
    const goodChats = recentMessages
        .filter(m => m.split(' ').length > 10 && m.length < 300)
        .slice(0, 15);

    const combined = [...new Set([...teachingSamples, ...goodChats])];
    return combined.slice(0, 20);
}

/**
 * Main function: chiết xuất style cho một Sales và lưu vào DB
 * @param {string} salesName 
 * @returns {object} { profile, samples, sampleCount }
 */
async function extractStyleForAgent(salesName) {
    console.log(`[StyleExtractor] 🔬 Bắt đầu phân tích văn phong: ${salesName}`);

    // Lấy 50 tin nhắn gần nhất
    const chats = database.getRecentChats(salesName, 50);
    const messages = chats.map(c => c.message);

    let profile;
    let samples;

    if (messages.length < 5) {
        // Không đủ data → dùng default profile
        console.log(`[StyleExtractor] ⚠️ ${salesName}: Chưa đủ data (${messages.length} tin nhắn) — dùng profile mặc định`);
        profile = DEFAULT_PROFILES[salesName] || DEFAULT_PROFILES['Min'];
        samples = [];
    } else {
        // Đủ data → dùng AI
        profile = await extractStyleWithAI(salesName, messages);
        if (!profile) {
            // AI failed → fallback default
            profile = DEFAULT_PROFILES[salesName] || DEFAULT_PROFILES['Min'];
        }
        samples = selectBestSamples(salesName, messages);
    }

    // Lưu vào DB
    database.saveSalesStyle(salesName, profile, samples, messages.length);

    console.log(`[StyleExtractor] 💾 ${salesName}: Profile lưu xong (${messages.length} mẫu, ${samples.length} câu hay)`);
    return { profile, samples, sampleCount: messages.length };
}

/**
 * Lấy style profile từ DB (đã được extract từ trước)
 * Falls back to default profile nếu chưa có.
 * @param {string} salesName 
 * @returns {object} tone profile
 */
function getStyleProfile(salesName) {
    const row = database.getSalesStyle(salesName);
    if (!row) return DEFAULT_PROFILES[salesName] || DEFAULT_PROFILES['Min'];

    try {
        const profile = JSON.parse(row.tone_profile || '{}');
        // Nếu profile rỗng (chưa extract) → dùng default
        if (!profile.greeting) return DEFAULT_PROFILES[salesName] || DEFAULT_PROFILES['Min'];
        return profile;
    } catch {
        return DEFAULT_PROFILES[salesName] || DEFAULT_PROFILES['Min'];
    }
}

/**
 * Lấy writing samples từ DB
 * @param {string} salesName 
 * @returns {string[]}
 */
function getWritingSamples(salesName) {
    const row = database.getSalesStyle(salesName);
    if (!row) return [];
    try {
        return JSON.parse(row.writing_samples || '[]');
    } catch {
        return [];
    }
}

/**
 * Chạy extraction cho TẤT CẢ agents (dùng cho cron job hàng đêm)
 */
async function runNightlyExtraction() {
    const agents = database.getAgentProfiles();
    console.log(`[StyleExtractor] 🌙 Nightly extraction cho ${agents.length} agents...`);

    for (const agent of agents) {
        try {
            await extractStyleForAgent(agent.name);
            // Delay giữa các agents để không spam AI API
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            console.error(`[StyleExtractor] ❌ ${agent.name}: ${err.message}`);
        }
    }

    console.log('[StyleExtractor] ✅ Nightly extraction hoàn tất');
}

module.exports = {
    extractStyleForAgent,
    getStyleProfile,
    getWritingSamples,
    runNightlyExtraction,
    DEFAULT_PROFILES,
};
