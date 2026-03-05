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

    // 4. Classification rules + scoring rubric + 2-funnel routing
    const rules = `
🚨 QUY TẮC SỐNG CÒN (LOẠI BỎ FALSE POSITIVE):
1. NẾU bài viết mang tính chất QUẢNG CÁO, CHÀO MỜI dịch vụ từ các công ty vận chuyển, xưởng in, kho bãi khác -> "author_role": "logistics_agency", "intent": "offering_service", "is_potential": false.
2. NẾU bài viết chỉ chia sẻ kiến thức, khoe đơn, không hỏi tìm đối tác -> "is_potential": false.
3. CHỈ chọn "is_potential": true khi TÁC GIẢ là người ĐANG TÌM KIẾM giải pháp hoặc ĐANG HỎI/CẦN GIÚP ĐỖ.
4. ĐẶC THÙ COMMENT NGẮN: Nếu nội dung là comment ngắn dưới post logistics/fulfillment như "xin giá", "check ib", "đi line us bao lâu", "có kho PA không", "rate?", "ib em", "giá bao nhiêu?" => "is_potential": true. Đây là tín hiệu mua hàng rõ ràng, ĐẶC BIỆT khi Parent context liên quan logistics/shipping.

🎯 PHÂN LUỒNG 2 DỊCH VỤ THG:
- "THG Express": DDP/line US/air/sea/LCL/FCL/kg/cbm/customs/thông quan/ISF/HS code/ship VN-CN→Mỹ → Express
- "THG Warehouse": 3PL/warehouse/kho PA-TX/fulfill/fulfillment/FBA prep/ship to Amazon/returns/cross-dock → Warehouse
- "THG Fulfillment": POD/Dropship chưa có hàng, cần xưởng in/mua hộ và ship.
- "Both": Có cả tín hiệu Express + Warehouse/Fulfillment
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
- "bên m nhận đi hàng lẻ từ kho tân bình ko ad?" → is_potential:true, score:80, THG Express
- "Cần kho Mỹ fulfill cho TikTok Shop, đồng thời cũng cần line VN→US cho hàng mới" → is_potential:true, score:90, Both
- [COMMENT] "xin giá" (parent: bài về fulfillment) → is_potential:true, score:70, THG Fulfillment
- [COMMENT] "rate?" (parent: bài về ship hàng Mỹ) → is_potential:true, score:65, THG Express
- "bác nào có xưởng US k ạ" → is_potential:true, score:70, THG Warehouse (đang tìm xưởng ở Mỹ)
- "có xưởng US k b" → is_potential:true, score:65, THG Warehouse (câu hỏi ngắn tìm xưởng)
- "ai biết chỗ nào ship hàng đi Mỹ không" → is_potential:true, score:75, THG Express
- "cần kho ở PA hoặc TX để fulfill" → is_potential:true, score:85, THG Warehouse
- [COMMENT] "Avail pa?" (parent: bài về logistics dịch vụ) → is_potential:true, score:60, None (cần thêm context)`;

    // Combine all parts
    return [base, kbContext, feedbackSection, rules, examples,
        '\nTrả về DUY NHẤT JSON được yêu cầu, không kèm text nào khác.'
    ].filter(Boolean).join('\n\n');
}

/**
 * Build feedback section from past human text corrections
 */
function buildFeedbackSection() {
    const examples = getFeedbackExamples(5);
    if (examples.length === 0) return '';

    const lines = examples.map(ex => {
        const content = (ex.content || '').substring(0, 80);
        const aiLabel = `${ex.role} (score ${ex.score})`;
        const humanNote = ex.feedback_note || ex.human_feedback || 'n/a';
        return `- Post: "${content}..."
  AI đánh: ${aiLabel}
  Sale feedback: ${humanNote}`;
    });

    return `🔄 HỌC TỪ FEEDBACK CỦA TEAM SALE (${examples.length} ví dụ gần nhất):
${lines.join('\n')}

→ Hãy học từ feedback này. Nếu sale nói AI sai → điều chỉnh cách chấm.`;
}

/**
 * Build the user prompt for a single post
 */
function buildUserPrompt(post) {
    const typeLabel = post.item_type === 'comment' ? 'COMMENT' : 'POST';
    const parentCtx = post.parent_excerpt
        ? `\nParent post context: ${post.parent_excerpt}`
        : '';

    return `Phân tích ${typeLabel} sau:

Platform: ${post.platform}
Type: ${post.item_type || 'post'}${parentCtx}
Nội dung: ${(post.content || '').substring(0, 1500)}

Trả về JSON (object đơn, không phải array):
{
  "author_role": "seller_ecom" | "logistics_agency" | "spammer" | "unknown",
  "intent": "seeking_service" | "offering_service" | "sharing_knowledge" | "other",
  "is_potential": boolean,
  "score": number (NẾU is_potential=true thì PHẢI >= 60, NẾU false thì = 0),
  "service_match": "THG Fulfillment" | "THG Express" | "THG Warehouse" | "Both" | "None",
  "reasoning": "Giải thích ngắn gọn",
  "urgency": "low" | "medium" | "high"
}`;
}

/**
 * Build the batch prompt for multiple posts
 */
function buildBatchPrompt(posts) {
    const postsList = posts.map((p, i) => {
        const typeLabel = p.item_type === 'comment' ? 'COMMENT' : 'POST';
        const parentCtx = p.parent_excerpt
            ? `\nParent: ${p.parent_excerpt.substring(0, 200)}`
            : '';
        return `[${typeLabel} ${i + 1}] Platform: ${p.platform}${parentCtx}\nContent: ${(p.content || '').substring(0, 600)}`;
    }).join('\n\n---\n\n');

    return `Phân tích ${posts.length} bài đăng/comment dưới đây. 

${postsList}

Trả về JSON object với key "results" là array ${posts.length} phần tử, theo đúng thứ tự:
{
  "results": [
    {"author_role":"...","intent":"...","is_potential":bool,"score":number,"service_match":"...","reasoning":"...","urgency":"..."},
    ...
  ]
}

service_match có thể là: "THG Fulfillment" | "THG Express" | "THG Warehouse" | "Both" | "None"
Nớng: is_potential=true → score PHẢI >= 60. is_potential=false → score = 0.
Nếu là COMMENT ngắn nhưng rõ buyer intent ("xin giá", "ib", "rate?") + Parent context liên quan logistics → is_potential=true.`;
}

module.exports = {
    buildSystemPrompt,
    buildUserPrompt,
    buildBatchPrompt,
};
