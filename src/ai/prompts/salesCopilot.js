/**
 * salesCopilot.js — THG AI Sales Assistant
 * 
 * Combines:
 * - Sales Copilot (Messenger reply drafting via Gemini)
 * - Lead Response Generator (Comment/DM response via Gemini)
 * - Intent Classifier (Groq lightweight)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const config = require('../../config');

// Gemini for response generation
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL });

// Groq for lightweight intent classification (free, fast)
const groq = new Groq({ apiKey: config.GROQ_API_KEY });

// ╔═══════════════════════════════════════════════════════════╗
// ║  COPILOT — Draft replies for Messenger                    ║
// ╚═══════════════════════════════════════════════════════════╝

const COPILOT_SYSTEM = `Bạn là AI Trợ lý Sales xuất sắc của THG Logistics — công ty chuyên fulfillment cho e-commerce seller bán hàng sang Mỹ.

${config.THG_CONTEXT}

Dịch vụ chính:
1. THG Fulfillment (POD/Dropship) — Seller gửi thiết kế hoặc link SP, THG lo từ sản xuất → đóng gói → ship
2. THG Express — Tuyến vận chuyển riêng VN/CN → Mỹ, giá tốt, tracking đáp ứng policy TikTok/Amazon
3. THG Warehouse — Kho tại Pennsylvania & North Carolina, ship nội địa Mỹ 2-5 ngày

Quy tắc soạn tin nhắn:
- Viết thân thiện, chuyên nghiệp, không pushy
- Xưng hô "em" (THG) và "anh/chị" (khách)
- Nếu khách hỏi giá → nói "giá phụ thuộc volume, em gửi bảng giá chi tiết ngay ạ"
- Nếu khách hỏi chung chung → giới thiệu ngắn gọn 3 dịch vụ trên
- Nếu khách gửi spam/không liên quan → trả lời lịch sự ngắn gọn
- Độ dài: 3-5 câu, tự nhiên như chat Messenger
- CHỈ trả về nội dung tin nhắn, KHÔNG giải thích thêm`;

/**
 * Generate AI Copilot reply — routes through PersonalAgent if agent is active.
 * @param {string} customerMessage 
 * @param {object} context - { senderName, platform, salesName, leadId, leadSummary }
 */
async function generateCopilotReply(customerMessage, context = {}) {
    // ── Personal Agent Route (khi agent đã bật active mode) ──
    const salesName = context.salesName;
    if (salesName) {
        try {
            const database = require('../../core/data_store/database');
            const agentRow = database.getAgentProfile(salesName);
            if (agentRow && agentRow.mode === 'active') {
                const personalAgent = require('../agents/personalAgent');
                const reply = await personalAgent.generateAgentReply(salesName, customerMessage, {
                    leadId: context.leadId,
                    leadSummary: context.leadSummary,
                    platform: context.platform,
                    senderName: context.senderName,
                });
                if (reply) return reply;
            }
        } catch (e) {
            console.warn('[Copilot] ⚠️ PersonalAgent unavailable, dùng generic:', e.message);
        }
    }

    // ── Generic fallback (learning mode hoặc không có salesName) ──
    const prompt = `${COPILOT_SYSTEM}

Khách hàng vừa nhắn tin vào Fanpage THG:
"${customerMessage}"

${context.senderName ? `Tên khách: ${context.senderName}` : ''}
${context.platform ? `Platform: ${context.platform}` : 'Platform: Facebook Messenger'}

Soạn câu trả lời phù hợp:`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const reply = result.response.text().trim();
        console.log(`[Copilot] ✅ Generic reply: ${reply.substring(0, 80)}...`);
        return reply;
    } catch (err) {
        console.error('[Copilot] ✗ Gemini error:', err.message);
        return '⚠️ AI đang bận, Sale vui lòng tự reply khách nhé!';
    }
}

/**
 * Classify intent of incoming message (Groq — lightweight, free)
 */
async function classifyIntent(message) {
    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{
                role: 'user',
                content: `Phân loại tin nhắn sau thành 1 trong: "price_inquiry", "service_inquiry", "urgent_need", "general", "spam"
Tin nhắn: "${message.substring(0, 200)}"
Chỉ trả về 1 từ duy nhất.`,
            }],
            temperature: 0,
            max_tokens: 10,
        });
        return response.choices[0].message.content.trim().toLowerCase();
    } catch {
        return 'general';
    }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  RESPONDER — Generate comment/DM responses for leads      ║
// ╚═══════════════════════════════════════════════════════════╝

const RESPONSE_TEMPLATES = {
    POD: `Chào bạn! Mình thấy bạn đang tìm giải pháp Print on Demand. Bên mình là THG — chuyên fulfillment POD cho seller bán hàng sang Mỹ. Mình có xưởng in riêng tại VN, CN và US, seller chỉ cần gửi file thiết kế, mình lo từ in ấn đến ship tận tay khách Mỹ. Bạn có thể inbox mình để trao đổi thêm nhé!`,
    Dropship: `Hi bạn! Mình thấy bạn đang quan tâm đến dropship. THG có dịch vụ dropship từ Taobao/1688 sang Mỹ — bạn chỉ cần gửi link sản phẩm, mình lo từ mua hàng, đóng gói đến ship sang Mỹ. Có kho tại CN xử lý nhanh. Inbox mình để biết thêm chi tiết nhé!`,
    Fulfillment: `Chào bạn! THG chuyên cung cấp dịch vụ fulfillment cho e-commerce seller. Mình có kho tại Pennsylvania và North Carolina, hệ thống OMS/WMS tracking real-time, ship nội địa Mỹ 2-5 ngày. Bạn muốn tìm hiểu thêm không?`,
    Express: `Hi bạn! Mình thấy bạn đang cần ship hàng từ VN/CN sang Mỹ. THG có tuyến bay riêng, giá tốt hơn DHL/FedEx, tracking rõ ràng (đáp ứng policy TikTok/Amazon). Inbox mình để báo giá cụ thể nhé!`,
    Warehouse: `Chào bạn! Nếu bạn muốn stock hàng sẵn tại Mỹ để ship nhanh cho khách, THG có kho fulfillment ở Pennsylvania và North Carolina. Nhập hàng trước → khi có đơn ship nội địa 2-5 ngày. Rất phù hợp để cạnh tranh trên Amazon. Inbox mình nhé!`,
    General: `Hi bạn! Mình là THG, chuyên hỗ trợ seller e-commerce bán hàng sang Mỹ. Mình có dịch vụ POD, dropship, fulfillment, và vận chuyển quốc tế. Bạn đang cần hỗ trợ gì cụ thể thì inbox mình nhé!`,
};

/**
 * Generate a personalized response for a lead using Gemini 1.5 Flash
 */
async function generateResponse(lead) {
    try {
        const template = RESPONSE_TEMPLATES[lead.category] || RESPONSE_TEMPLATES.General;
        const isTikTok = lead.platform === 'tiktok';

        const lenRule = isTikTok
            ? "- ĐỘ DÀI: Cực kỳ ngắn, DƯỚI 15 TỪ. Văn phong Gen Z, nhanh gọn."
            : "- Độ dài: 2-3 câu ngắn gọn.";

        const toneRule = isTikTok
            ? "- KHÔNG dạ vâng dài dòng. Mục tiêu duy nhất là kéo khách check tin nhắn (VD: 'Bạn check inbox THG hỗ trợ ngay nhé!', 'Bên mình có kho PA ạ, b check ib nhé')."
            : "- Viết tự nhiên, không quá bán hàng (không pushy). Trả lời thẳng vào vấn đề họ đang hỏi.";

        const prompt = `Bạn là sales representative của THG. Nhiệm vụ: viết một comment/message phản hồi lại bài đăng/bình luận của khách hàng trên ${lead.platform}.

${config.THG_CONTEXT}

Quy tắc:
${lenRule}
${toneRule}
- Đề cập đúng nhu cầu của họ (dựa trên nội dung post)
- Kết thúc bằng CTA nhẹ nhàng (inbox, liên hệ, check DMs)
- Ngôn ngữ: sử dụng cùng ngôn ngữ với bài đăng gốc (tiếng Anh thì rep tiếng Anh, tiếng Việt thì rep tiếng Việt).
- CHỈ trả về nội dung response, KHÔNG giải thích thêm. KHÔNG dùng ngoặc kép bọc câu trả lời.

Nội dung bài đăng/comment gốc của khách hàng:
"${lead.content.substring(0, 1000)}"

Phân tích nhu cầu:
- Category: ${lead.category}
- Nhu cầu/Insight: ${lead.summary}
- Mức độ cấp bách: ${lead.urgency}

Template dịch vụ tham khảo (Hãy rút gọn siêu ngắn nếu là TikTok):
${template}

Viết response phù hợp nhất:`;

        const result = await geminiModel.generateContent(prompt);
        let text = result.response.text().trim();

        // Remove quotes if AI accidentally adds them
        if (text.startsWith('"') && text.endsWith('"')) {
            text = text.substring(1, text.length - 1);
        }

        console.log(`[Responder] ✅ Gemini generated response: ${text.substring(0, 80)}...`);
        return text;
    } catch (err) {
        const is429 = err.message?.includes('429') || err.message?.includes('quota');
        if (is429) {
            // Gemini free tier exhausted — fallback to Groq
            try {
                const groqResp = await groq.chat.completions.create({
                    model: 'llama-3.1-8b-instant',
                    messages: [
                        { role: 'system', content: `Bạn là sales rep THG Logistics. Viết comment ngắn (2-3 câu) phản hồi bài đăng khách trên ${lead.platform}. Xưng "em THG". Nhẹ nhàng, không pushy. CHỈ trả về nội dung comment.` },
                        { role: 'user', content: `Bài đăng: "${lead.content.substring(0, 300)}"\nDịch vụ phù hợp: ${lead.category || 'General'}` },
                    ],
                    temperature: 0.3,
                    max_tokens: 150,
                });
                const groqText = groqResp.choices[0].message.content.trim();
                console.log(`[Responder] ✅ Groq fallback: ${groqText.substring(0, 60)}...`);
                return groqText;
            } catch (groqErr) {
                console.warn(`[Responder] ⚠️ Groq fallback also failed: ${groqErr.message}`);
            }
        } else {
            console.error('[Responder] ✗ Gemini error:', err.message);
        }
        return RESPONSE_TEMPLATES[lead.category] || RESPONSE_TEMPLATES.General;
    }
}

/**
 * Generate responses for a batch of leads
 */
async function generateResponses(leads) {
    console.log(`[Responder] 💬 Generating responses for ${leads.length} leads with Gemini 1.5 Flash...`);
    const results = [];

    for (const lead of leads) {
        const response = await generateResponse(lead);
        results.push({ ...lead, suggested_response: response });
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[Responder] ✅ Generated ${results.length} responses`);
    return results;
}

module.exports = { generateCopilotReply, classifyIntent, generateResponse, generateResponses };
