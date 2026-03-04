/**
 * THG Agent — Dynamic Prompt Builder
 * 
 * Builds context-aware prompts by combining:
 * 1. Base THG context
 * 2. Relevant knowledge chunks (from KB)
 * 3. Past classification examples (from memory/feedback)
 * 4. Scoring rubric
 */

const config = require('../config');
const { getContextForPrompt } = require('./knowledgeBase');
const { getFeedbackExamples, getRecentBuyers } = require('./memoryStore');

/**
 * Build the system prompt dynamically for a given post
 */
function buildSystemPrompt(postContent) {
    // 1. Base context
    const base = `Bạn là THG AI Agent — chuyên gia phân tích lead cho THG Logistics. 
Bạn có kiến thức SÂU về THG và thị trường logistics/fulfillment e-commerce.

${config.THG_CONTEXT}`;

    // 2. Relevant knowledge from KB
    const kbContext = getContextForPrompt(postContent);

    // 3. Past feedback examples (learned from human corrections)
    const feedbackSection = buildFeedbackSection();

    // 4. Classification rules + scoring rubric (kept from original)
    const rules = `
🚨 QUY TẮC SỐNG CÒN (LOẠI BỎ FALSE POSITIVE):
1. NẾU bài viết mang tính chất QUẢNG CÁO, CHÀO MỜI dịch vụ từ các công ty vận chuyển, xưởng in, kho bãi khác -> "author_role": "logistics_agency", "intent": "offering_service", "is_potential": false.
2. NẾU bài viết chỉ chia sẻ kiến thức, khoe đơn, không hỏi tìm đối tác -> "is_potential": false.
3. CHỈ chọn "is_potential": true khi TÁC GIẢ là người ĐANG TÌM KIẾM giải pháp hoặc ĐANG HỎI/CẦN GIÚP ĐỖ.
4. ĐẶC THÙ TIKTOK COMMENT: Nếu nội dung rất ngắn như "xin giá", "check ib", "đi line us bao lâu", "có kho PA không" => "is_potential": true, đây là tín hiệu mua hàng rõ ràng.

🎯 PHÂN LOẠI DỊCH VỤ THG (Nếu is_potential = true):
- "THG Fulfillment": POD/Dropship chưa có hàng, cần xưởng in/mua hộ và ship.
- "THG Express": Có sẵn hàng ở VN/CN, cần book chuyến ship đi US/CA nhanh.
- "THG Warehouse": Cần thuê kho tại Mỹ để stock hàng và ship nội địa.
- "None": Không khớp hoặc là bài quảng cáo.

📊 THANG ĐIỂM SCORE (0-100):

score 85-100 = Buyer rõ ràng, có urgency cao, nêu rõ nhu cầu cụ thể, sẵn sàng mua ngay
score 65-84 = Buyer có nhu cầu, đang research, chưa quá gấp
score 40-64 = Có thể là buyer nhưng không chắc chắn
score 0-39 = Không phải buyer HOẶC không liên quan

⚠️ QUY TẮC BẮT BUỘC VỀ SCORE:
- Nếu is_potential = true → score PHẢI >= 60. Không có ngoại lệ.
- Nếu is_potential = false → score PHẢI = 0. Không có ngoại lệ.`;

    // 5. Few-shot examples
    const examples = `
📝 VÍ DỤ MẪU:
- "Bên mình có kho CA nhận xử lý FBM, giá rẻ." → is_potential:false, score:0, role:logistics_agency
- "Mới tập tành làm POD, cho hỏi app nào in áo rẻ ship US?" → is_potential:true, score:75, THG Fulfillment
- "Mình đang muốn bắt đầu POD trên TikTok Shop US mà chưa chọn xưởng nào" → is_potential:true, score:88, THG Fulfillment
- "Có 2 tạ hàng cần ship sang Mỹ trong tuần, ai nhận inbox" → is_potential:true, score:95, THG Express
- "bên m nhận đi hàng lẻ từ kho tân bình ko ad?" → is_potential:true, score:80, THG Express`;

    // Combine all parts
    return [base, kbContext, feedbackSection, rules, examples,
        '\nTrả về DUY NHẤT JSON được yêu cầu, không kèm text nào khác.'
    ].filter(Boolean).join('\n\n');
}

/**
 * Build feedback section from past human corrections
 */
function buildFeedbackSection() {
    const examples = getFeedbackExamples(5);
    if (examples.length === 0) return '';

    const lines = examples.map(ex => {
        const originalLabel = `${ex.role} (score ${ex.score})`;
        const feedbackLabel = ex.human_feedback === 'correct'
            ? '✅ Đúng'
            : `❌ Sai → đúng là ${ex.correct_role} (score ${ex.correct_score})`;
        const content = (ex.content || '').substring(0, 80);
        return `- "${content}..." → AI: ${originalLabel} | Feedback: ${feedbackLabel}`;
    });

    return `🔄 HỌC TỪ FEEDBACK (${examples.length} ví dụ gần đây):
${lines.join('\n')}
→ Hãy tham khảo feedback này để chấm điểm chính xác hơn.`;
}

/**
 * Build the user prompt for a single post
 */
function buildUserPrompt(post) {
    return `Phân tích bài đăng/comment sau:

Platform: ${post.platform}
Nội dung: ${(post.content || '').substring(0, 1500)}

Trả về JSON (object đơn, không phải array):
{
  "author_role": "seller_ecom" | "logistics_agency" | "spammer" | "unknown",
  "intent": "seeking_service" | "offering_service" | "sharing_knowledge" | "other",
  "is_potential": boolean,
  "score": number (NẾU is_potential=true thì PHẢI >= 60, NẾU false thì = 0),
  "service_match": "THG Fulfillment" | "THG Express" | "THG Warehouse" | "None",
  "reasoning": "Giải thích ngắn gọn",
  "urgency": "low" | "medium" | "high"
}`;
}

/**
 * Build the batch prompt for multiple posts
 */
function buildBatchPrompt(posts) {
    const postsList = posts.map((p, i) =>
        `[POST ${i + 1}] Platform: ${p.platform}\nContent: ${(p.content || '').substring(0, 600)}`
    ).join('\n\n---\n\n');

    return `Phân tích ${posts.length} bài đăng dưới đây. 

${postsList}

Trả về JSON object với key "results" là array ${posts.length} phần tử, theo đúng thứ tự POST 1, 2, 3...:
{
  "results": [
    {"author_role":"...","intent":"...","is_potential":bool,"score":number,"service_match":"...","reasoning":"...","urgency":"..."},
    ...
  ]
}

Nhớ: is_potential=true → score PHẢI >= 60. is_potential=false → score = 0.`;
}

module.exports = {
    buildSystemPrompt,
    buildUserPrompt,
    buildBatchPrompt,
};
