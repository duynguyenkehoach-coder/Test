/**
 * responder.js — Generate sale responses using Google Gemini 1.5 Flash
 *
 * Groq handles scanning/classifying (classifier.js)
 * Gemini handles sale response generation (this file)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');

// --- Init Gemini ---
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL });

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
        console.error('[Responder] ✗ Gemini error:', err.message);
        // Fallback to template
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
        // Gemini Flash has generous rate limits, 500ms delay is enough
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[Responder] ✅ Generated ${results.length} responses`);
    return results;
}

module.exports = { generateResponse, generateResponses };
