/**
 * THG AI Copilot — Sales Assistant (powered by Gemini 1.5 Flash)
 *
 * Khi khách nhắn tin vào Fanpage, Gemini sẽ:
 * 1. Đọc nội dung tin nhắn
 * 2. Soạn sẵn câu trả lời chuyên nghiệp
 * 3. Sale chỉ cần review → edit → gửi
 *
 * Intent classification vẫn dùng Groq (nhẹ, nhanh, miễn phí)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const config = require('./config');

// Gemini for response generation
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL });

// Groq for lightweight intent classification (free, fast)
const groq = new Groq({ apiKey: config.GROQ_API_KEY });

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
 * Generate AI Copilot reply using Gemini 1.5 Flash
 */
async function generateCopilotReply(customerMessage, context = {}) {
    const prompt = `${COPILOT_SYSTEM}

Khách hàng vừa nhắn tin vào Fanpage THG:
"${customerMessage}"

${context.senderName ? `Tên khách: ${context.senderName}` : ''}
${context.platform ? `Platform: ${context.platform}` : 'Platform: Facebook Messenger'}

Soạn câu trả lời phù hợp:`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const reply = result.response.text().trim();
        console.log(`[Copilot] ✅ Gemini soạn reply: ${reply.substring(0, 80)}...`);
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

module.exports = { generateCopilotReply, classifyIntent };
