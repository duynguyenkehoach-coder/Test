/**
 * 🎯 Outreach Generator — AI-Powered Personalized Messages for Leads
 * 
 * Generates highly personalized outreach messages for each lead:
 * - References the lead's SPECIFIC post content & pain point
 * - Matches the assigned sales staff's communication style
 * - Supports 3 tones: friendly / professional / urgent
 * - Auto-detects language (VN / EN)
 * 
 * Provider cascade: Cerebras → Sambanova → Groq → Gemini
 * 
 * @module ai/outreachGenerator
 */
'use strict';

const OpenAI = require('openai');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

// ─── Provider Clients ────────────────────────────────────────────────────────
let cerebras = null;
let sambanova = null;
let groq = null;
let geminiModel = null;

try {
    if (config.CEREBRAS_API_KEY) {
        cerebras = new OpenAI({ apiKey: config.CEREBRAS_API_KEY, baseURL: 'https://api.cerebras.ai/v1' });
    }
    if (config.SAMBANOVA_API_KEY) {
        sambanova = new OpenAI({ apiKey: config.SAMBANOVA_API_KEY, baseURL: 'https://api.sambanova.ai/v1' });
    }
    if (config.GROQ_API_KEY) {
        groq = new Groq({ apiKey: config.GROQ_API_KEY });
    }
    if (config.GEMINI_API_KEY) {
        const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL || 'gemini-2.0-flash' });
    }
} catch (e) {
    console.error(`[OutreachGen] ⚠️ Provider init error: ${e.message}`);
}

const PROVIDERS = [
    { name: 'Cerebras', client: cerebras, model: 'llama-3.3-70b', type: 'openai' },
    { name: 'Sambanova', client: sambanova, model: 'Meta-Llama-3.3-70B-Instruct', type: 'openai' },
    { name: 'Groq', client: groq, model: 'llama-3.1-8b-instant', type: 'groq' },
].filter(p => p.client);

// ─── THG Service Context ─────────────────────────────────────────────────────
const THG_CONTEXT = `
THG LOGISTICS — THÔNG TIN DỊCH VỤ:
• THG Fulfillment: Seller gửi thiết kế → THG in + đóng gói + ship sang Mỹ (POD/Dropship)
• THG Express: Tuyến VN/CN → Mỹ, tracking chuẩn TikTok/Amazon/Etsy policy
• THG Warehouse: Kho tại Pennsylvania & North Carolina, ship nội địa Mỹ 2-5 ngày
• Cam kết: Mất hàng đền 100%, tracking real-time, hỗ trợ 24/7
• USP: Giá cạnh tranh, tốc độ xử lý nhanh, đội ngũ support tiếng Việt tại Mỹ
`.trim();

const THG_CONTEXT_EN = `
THG LOGISTICS — SERVICE INFO:
• THG Fulfillment: Print-on-demand & dropship fulfillment (VN/CN → US)
• THG Express: Shipping routes VN/CN → US, TikTok/Amazon/Etsy compliant tracking
• THG Warehouse: US warehouses in Pennsylvania & North Carolina, 2-5 day domestic shipping
• Guarantee: 100% lost package compensation, real-time tracking, 24/7 support
• USP: Competitive pricing, fast processing, Vietnamese-speaking US-based support team
`.trim();

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Build outreach prompt for Vietnamese leads
 */
function buildPromptVN(lead, staffName, tone) {
    const toneGuide = {
        friendly: 'Thân thiện, gần gũi, dùng emoji vừa phải. Xưng "mình" hoặc tên staff.',
        professional: 'Chuyên nghiệp, lịch sự, ít emoji. Xưng "em" hoặc tên staff.',
        urgent: 'Khẩn trương nhưng không push bán. Nhấn mạnh thời gian là cơ hội.',
    };

    return `Bạn là ${staffName}, Sales của THG Logistics. Khách hàng vừa đăng bài trong group Facebook:

━━━ BÀI POST CỦA KHÁCH ━━━
"${(lead.content || '').substring(0, 500)}"

━━━ PHÂN TÍCH AI ━━━
• Category: ${lead.category || 'General'}
• Pain point: ${lead.summary || 'Chưa xác định'}
• Score: ${lead.score || 0}/100
• Buyer signals: ${lead.buyer_signals || 'N/A'}

━━━ DỊCH VỤ THG ━━━
${THG_CONTEXT}

━━━ YÊU CẦU ━━━
Viết TIN NHẮN MESSENGER DM tiếp cận khách. Bắt buộc:
1. MỞ ĐẦU bằng reference TRỰC TIẾP đến vấn đề trong bài post (KHÔNG chào chung chung)
2. Đưa ra giải pháp THG PHÙ HỢP với nhu cầu cụ thể
3. Tone: ${toneGuide[tone] || toneGuide.friendly}
4. Kết bằng CTA nhẹ (hỏi thêm thông tin, mời inbox)
5. Độ dài: 3-5 câu, ngắn gọn tự nhiên

KHÔNG ĐƯỢC:
- Quảng cáo chung chung kiểu "bên mình chuyên..."  
- Copy-paste template
- Báo giá cụ thể
- Spam

CHỈ trả về nội dung tin nhắn, KHÔNG giải thích thêm.`;
}

/**
 * Build outreach prompt for English leads
 */
function buildPromptEN(lead, staffName, tone) {
    const toneGuide = {
        friendly: 'Friendly and approachable, use occasional emojis. Casual but professional.',
        professional: 'Professional and polished, minimal emojis. Business-appropriate.',
        urgent: 'Urgent but not pushy. Emphasize time-sensitive opportunity.',
    };

    return `You are ${staffName}, a Sales representative at THG Logistics. A potential customer just posted in a Facebook group:

━━━ CUSTOMER'S POST ━━━
"${(lead.content || '').substring(0, 500)}"

━━━ AI ANALYSIS ━━━
• Category: ${lead.category || 'General'}
• Pain point: ${lead.summary || 'Not determined'}
• Score: ${lead.score || 0}/100
• Buyer signals: ${lead.buyer_signals || 'N/A'}

━━━ THG SERVICES ━━━
${THG_CONTEXT_EN}

━━━ REQUIREMENTS ━━━
Write a MESSENGER DM outreach message. Must:
1. OPEN by directly referencing the SPECIFIC issue in their post (NO generic greeting)
2. Provide a THG solution MATCHING their specific need
3. Tone: ${toneGuide[tone] || toneGuide.friendly}
4. End with soft CTA (ask about details, invite to chat)
5. Length: 3-5 sentences, natural and concise

DO NOT:
- Use generic pitches like "we specialize in..."
- Copy-paste templates  
- Quote specific prices
- Be spammy

Return ONLY the message content, no explanations.`;
}

/**
 * Build a comment reply prompt (shorter, more casual)
 */
function buildCommentPrompt(lead, staffName, language) {
    if (language === 'vietnamese') {
        return `Bạn là ${staffName} (THG Logistics). Khách đăng bài:
"${(lead.content || '').substring(0, 300)}"

Viết COMMENT REPLY ngắn (1-2 câu) phản hồi trực tiếp vấn đề khách nêu, gợi ý THG có thể giúp, và kết bằng "inbox mình nghe" hoặc tương tự.
CHỈ trả về nội dung comment.`;
    }
    return `You are ${staffName} (THG Logistics). Customer posted:
"${(lead.content || '').substring(0, 300)}"

Write a SHORT comment reply (1-2 sentences) directly addressing their issue, briefly mentioning THG can help, ending with "DM me for details" or similar.
Return ONLY the comment text.`;
}

// ─── AI Call with Provider Cascade ───────────────────────────────────────────

/**
 * Call an OpenAI-compatible provider
 */
async function callOpenAIProvider(client, model, prompt) {
    const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 400,
    });
    return response.choices[0].message.content.trim();
}

/**
 * Call Gemini as last resort
 */
async function callGemini(prompt) {
    if (!geminiModel) throw new Error('Gemini not configured');
    const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    return result.response.text().trim();
}

/**
 * Generate outreach message with provider cascade
 * @param {string} prompt - Full prompt
 * @returns {string} AI-generated message
 */
async function generateWithCascade(prompt) {
    // Try each provider in order
    for (const provider of PROVIDERS) {
        try {
            console.log(`[OutreachGen] 🔄 Trying ${provider.name}...`);
            const result = await callOpenAIProvider(provider.client, provider.model, prompt);
            console.log(`[OutreachGen] ✅ ${provider.name} success`);
            return result;
        } catch (e) {
            console.warn(`[OutreachGen] ⚠️ ${provider.name} failed: ${e.message}`);
        }
    }

    // Last resort: Gemini
    try {
        console.log(`[OutreachGen] 🔄 Trying Gemini (last resort)...`);
        const result = await callGemini(prompt);
        console.log(`[OutreachGen] ✅ Gemini success`);
        return result;
    } catch (e) {
        console.error(`[OutreachGen] ❌ All providers failed: ${e.message}`);
        throw new Error('All AI providers failed');
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate personalized DM outreach message for a lead
 * @param {object} lead - Lead from database (must include content, category, summary, language)
 * @param {object} opts
 * @param {string} opts.staffName - Sales staff name (default 'Trang')
 * @param {string} opts.tone - 'friendly' | 'professional' | 'urgent'
 * @returns {{ message: string, language: string, type: string }}
 */
async function generateDM(lead, opts = {}) {
    const { staffName = 'Trang', tone = 'friendly' } = opts;
    const language = lead.language || 'vietnamese';

    const prompt = language === 'vietnamese'
        ? buildPromptVN(lead, staffName, tone)
        : buildPromptEN(lead, staffName, tone);

    let message = await generateWithCascade(prompt);

    // Clean up AI quirks
    message = cleanMessage(message);

    return { message, language, type: 'dm' };
}

/**
 * Generate comment reply for a lead's post
 * @param {object} lead
 * @param {object} opts
 * @returns {{ message: string, language: string, type: string }}
 */
async function generateComment(lead, opts = {}) {
    const { staffName = 'Trang' } = opts;
    const language = lead.language || 'vietnamese';

    const prompt = buildCommentPrompt(lead, staffName, language);
    let message = await generateWithCascade(prompt);
    message = cleanMessage(message);

    return { message, language, type: 'comment' };
}

/**
 * Generate follow-up message (for leads already contacted but no reply)
 * @param {object} lead
 * @param {string} previousMessage - Last message sent
 * @param {object} opts
 * @returns {{ message: string, language: string, type: string }}
 */
async function generateFollowUp(lead, previousMessage, opts = {}) {
    const { staffName = 'Trang' } = opts;
    const language = lead.language || 'vietnamese';

    let prompt;
    if (language === 'vietnamese') {
        prompt = `Bạn là ${staffName} (THG Logistics). Trước đó bạn đã gửi tin nhắn cho khách:
"${previousMessage}"

Nhưng khách chưa reply. Viết TIN NHẮN FOLLOW-UP nhẹ nhàng (2-3 câu):
- Nhắc lại vấn đề khách cần
- Không push bán
- Tone thân thiện
CHỈ trả về nội dung tin nhắn.`;
    } else {
        prompt = `You are ${staffName} (THG Logistics). You previously sent:
"${previousMessage}"

But the customer hasn't replied. Write a GENTLE FOLLOW-UP (2-3 sentences):
- Reference their original need
- Don't be pushy
- Friendly tone
Return ONLY the message.`;
    }

    let message = await generateWithCascade(prompt);
    message = cleanMessage(message);

    return { message, language, type: 'followup' };
}

/**
 * Batch generate outreach for multiple leads
 * @param {object[]} leads - Array of leads
 * @param {object} opts
 * @returns {Array<{leadId: number, message: string, language: string, type: string}>}
 */
async function batchGenerate(leads, opts = {}) {
    const results = [];
    const BATCH_DELAY_MS = 2000; // 2s between calls to avoid rate limits

    for (let i = 0; i < leads.length; i++) {
        try {
            const result = await generateDM(leads[i], opts);
            results.push({ leadId: leads[i].id, ...result });
            console.log(`[OutreachGen] 📝 ${i + 1}/${leads.length} - Lead #${leads[i].id} done`);
        } catch (e) {
            console.error(`[OutreachGen] ❌ Lead #${leads[i].id} failed: ${e.message}`);
            results.push({ leadId: leads[i].id, message: null, error: e.message });
        }

        // Delay between calls
        if (i < leads.length - 1) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    return results;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Clean up common AI response quirks
 */
function cleanMessage(text) {
    if (!text) return '';
    // Remove surrounding quotes
    text = text.replace(/^["'""]|["'""]$/g, '').trim();
    // Remove "Subject:" or "Chủ đề:" prefixes
    text = text.replace(/^(Subject|Chủ đề)\s*:\s*/i, '').trim();
    // Remove markdown bold
    text = text.replace(/\*\*/g, '').trim();
    return text;
}

module.exports = {
    generateDM,
    generateComment,
    generateFollowUp,
    batchGenerate,
};
