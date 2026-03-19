/**
 * THG Agent — Dynamic Prompt Builder
 * 
 * Builds context-aware prompts by combining:
 * 1. Base THG context
 * 2. Relevant knowledge chunks (from KB)
 * 3. Past classification examples (from memory/feedback)
 * 4. Scoring rubric
 */

const config = require('../../config');
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
3. CHỈ chọn "is_potential": true khi TÁC GIẢ là người ĐANG TÌM KIẾM giải pháp hoặc ĐANG HỎI/CẦN GIÚP ĐỠ.
4. ĐẶC THÙ COMMENT NGẮN: Nếu nội dung là comment ngắn dưới post logistics/fulfillment như "xin giá", "check ib", "đi line us bao lâu", "có kho PA không", "rate?", "ib em", "giá bao nhiêu?" => "is_potential": true.

🛑 CÁCH PHÂN BIỆT PROVIDER vs BUYER (CỰC KỲ QUAN TRỌNG - BẮT BUỘC ĐỌC KỸ):
- PROVIDER (NGƯỜI BÁN DỊCH VỤ - RÁC MÀ BẠN PHẢI LOẠI BỎ): 
  Dấu hiệu nhận biết: Bài viết quảng cáo dịch vụ, chứa tên công ty (VD: "Công ty TNHH", "Cổ phần"), địa chỉ văn phòng/kho, số Hotline, Zalo/WhatsApp, và thường lạm dụng nhiều emoji chức năng (✔️, 🏢, 🏡, ☎, 🔥). Chứa các cam kết như "Bao thuế nhập khẩu", "Đóng gói cẩn thận", "Tracking theo dõi", "nhận vận chuyển", "bên em chuyên/chúng tôi chuyên", "giá rẻ/bảng giá".
  -> BẤT KỲ bài nào mang góc nhìn CUNG CẤP dịch vụ, CHÀO HÀNG hoặc ĐỂ LẠI THÔNG TIN LIÊN HỆ để SALE, bạn PHẢI ĐÁNH TRƯỢT NGAY LẬP TỨC ("is_potential": false, "score": 0, "role": "provider"). Kể cả khi bài đó có keyword "order" hay "thủy/bộ".

- BUYER (NGƯỜI CẦN DỊCH VỤ - LEAD CHUẨN): 
  Người ĐỨNG TRÊN GÓC NHÌN ĐANG PHÁT SINH NHU CẦU, CẦN TÌM ĐỐI TÁC. 
  Dấu hiệu: "cần tìm bên/người", "ai biết", "giới thiệu giúp", "cho hỏi", "giúp mình", "mình đang muốn", "cần đi hàng", "tìm đối tác". Đặt câu hỏi tìm kiếm dịch vụ chứ không phải chào hàng.
- NẾU TÁC GIẢ VIẾT: "Bên em nhận order..." -> 100% LÀ PROVIDER.
- NẾU TÁC GIẢ VIẾT: "Mình cần tìm bên order..." -> 100% LÀ BUYER.

🚫 THUẬT TOÁN TUYẾN ĐƯỜNG — LOẠI BỎ FALSE POSITIVE (CỰC KỲ QUAN TRỌNG):
THG CHỈ phục vụ 2 chiều ĐI CHÍNH SAU ĐÂY:
(A) Việt Nam (VN) đi Worldwide (Mỹ, Úc, EU...) NGOẠI TRỪ Trung Quốc.
(B) Trung Quốc (CN) đi Worldwide (Mỹ, Úc, EU...) NGOẠI TRỪ Việt Nam.

NẾU TÌNH HUỐNG SAU XẢY RA, PHẢI LOẠI BỎ NGAY LẬP TỨC:
1. Từ Bất Kỳ Đâu VỀ Việt Nam: "từ Mỹ về VN", "từ Nhật về VN", "từ Alberta về Việt Nam", "từ Úc về Sài Gòn" → is_potential = false, reasoning = "Sai tuyến: World→VN"
2. Từ Bất Kỳ Đâu VỀ Trung Quốc: "từ Mỹ về TQ", "gửi hàng về Quảng Châu" → is_potential = false, reasoning = "Sai tuyến: World→CN"
3. Giữa VN và CN: "TQ về VN" hoặc "VN sang TQ" → is_potential = false, reasoning = "Sai tuyến: Intra-Asia"
4. Nội Địa: "Sài Gòn đi Hà Nội", "ship COD nội thành" → is_potential = false, reasoning = "Sai tuyến: Nội địa"

KỂ CẢ khi tác giả có nhu cầu thật, nếu tuyến KHÔNG PHẢI (VN/CN → Thế Giới) → vẫn PHẢI đánh trượt (score = 0).

🎯 PHÂN LUỒNG 2 DỊCH VỤ THG:
- "THG Express": DDP/line US/air/sea/LCL/FCL/kg/cbm/customs/thông quan/ISF/HS code/ship VN-CN→Mỹ/World → Express
- "THG Warehouse": 3PL/warehouse/kho PA-TX/fulfill/fulfillment/FBA prep/ship to Amazon/returns/cross-dock → Warehouse
- "THG Fulfillment": POD/Dropship chưa có hàng, cần xưởng in/mua hộ và ship.
- "Both": Có cả tín hiệu Express + Warehouse/Fulfillment
- "None": Không khớp tuyến đường hoặc là quảng cáo.

📊 THANG ĐIỂM SCORE (0-100):

score 85-100 = Buyer rõ ràng, có urgency cao, nêu rõ nhu cầu cụ thể, sẵn sàng mua ngay
score 65-84 = Buyer có nhu cầu, đang research, chưa quá gấp
score 40-64 = Có thể là buyer nhưng không chắc chắn
score 0-39 = Không phải buyer HOẶC không liên quan

⚠️ QUY TẮC BẮT BUỘC VỀ SCORE:
- Nếu is_potential = true → score PHẢI >= 60. Không có ngoại lệ.
- Nếu is_potential = false → score PHẢI = 0. Không có ngoại lệ.

🔴 QUY TẮC CHỐNG FALSE POSITIVE (CỰC KỲ QUAN TRỌNG):
- Bài chia sẻ kiến thức, hướng dẫn nhập môn, cách làm, tip về mô hình POD/Dropship (VD: "hướng dẫn AI vào mô hình POD") → KHÔNG liên quan logistics, ĐÁNH TRƯỢT NGAY → is_potential = false, score = 0
- Bài hỏi về sản phẩm Amazon KHÔNG LIÊN QUAN đến shipping/logistics/fulfillment → is_potential = false, score = 0
- Bài hỏi về nhập hàng mua sắm cá nhân (Macy's, Target, Costco) hoặc mua hàng nội địa Mỹ → is_potential = false, score = 0  
- Bài hỏi về listing, SEO, PPC, quảng cáo → is_potential = false, score = 0
- Bài về tìm việc, tuyển dụng, HR → is_potential = false, score = 0
- CHỈ is_potential = true khi bài viết RÕ RÀNG cần dịch vụ: vận chuyển, fulfillment, kho bãi, POD, dropship, hoặc tìm nguồn hàng TQ để ship đi Mỹ/EU`;

    // 5. Few-shot examples
    const examples = `
📝 VÍ DỤ MẪU:

🛑 PROVIDER (is_potential: false, score: 0):
- "Xin phép admin và anh/chị seller ạ 🙏 Nếu mọi người đang tìm đơn vị vận chuyển..." → PROVIDER ("xin phép admin" + giới thiệu dịch vụ = quảng cáo)
- "SELLER SHIP US NÊN BIẾT: TUYẾN EPACKET GIÁ TỐT – NHẬN TỪ 1 ĐƠN 🔥 Chỉ từ 60k" → PROVIDER (bảng giá + "nhận từ 1 đơn" = quảng cáo)
- "Anh/chị seller cần đvvc uy tín gửi hàng VN-US tham khảo ngay" → PROVIDER ("tham khảo ngay" = quảng cáo)
- "Tap in with Sweats Collective, they just launched there US fulfillment center" → PROVIDER (giới thiệu fulfillment center mới = quảng cáo)
- "Bên mình có kho CA nhận xử lý FBM, giá rẻ." → PROVIDER (giới thiệu kho + dịch vụ)
- "Ready to scale your eCommerce business? From warehousing to..." → PROVIDER (quảng cáo dịch vụ)
- "EPACKET – GIẢI PHÁP GỬI HÀNG QUỐC TẾ SIÊU TỐC" → PROVIDER (giới thiệu sản phẩm)

🎯 BUYER (is_potential: true, score >= 60):
- "Mới tập tành làm POD, cho hỏi app nào in áo rẻ ship US?" → is_potential:true, score:75, THG Fulfillment
- "Mình đang muốn bắt đầu POD trên TikTok Shop US mà chưa chọn xưởng nào" → is_potential:true, score:88, THG Fulfillment
- "Có 2 tạ hàng cần ship sang Mỹ trong tuần, ai nhận inbox" → is_potential:true, score:95, THG Express
- "bên m nhận đi hàng lẻ từ kho tân bình ko ad?" → is_potential:true, score:80, THG Express
- "bác nào có xưởng US k ạ" → is_potential:true, score:70, THG Warehouse
- "ai biết chỗ nào ship hàng đi Mỹ không" → is_potential:true, score:75, THG Express
- "cần kho ở PA hoặc TX để fulfill" → is_potential:true, score:85, THG Warehouse
- "muốn mua hàng từ Trung Quốc ship về Mỹ, ai có nguồn?" → is_potential:true, score:85, THG Express
- [COMMENT] "xin giá" (parent: bài về fulfillment) → is_potential:true, score:70, THG Fulfillment
- [COMMENT] "rate?" (parent: bài về ship hàng Mỹ) → is_potential:true, score:65, THG Express

🚫 SAI TUYẾN (is_potential: false, score: 0):
- "cần chuyển gấp kiện hàng từ Alberta về Việt Nam" → is_potential:false, score:0 (World→VN = sai tuyến)
- "mình ở Cali cần gửi đồ về VN cho gia đình, ai biết dịch vụ nào tốt" → is_potential:false, score:0 (World→VN = sai tuyến)
- "cần ship hàng từ Quảng Châu về Việt Nam, ai nhận?" → is_potential:false, score:0 (Intra-Asia = sai tuyến)
- "ai biết chỗ nào order taobao về VN uy tín?" → is_potential:false, score:0 (Intra-Asia = sai tuyến)
- "cần giao hàng nhanh nội thành HCM" → is_potential:false, score:0 (Nội địa = sai tuyến)
- "nhập hàng 1688 về kho Hà Nội, giá bao nhiêu?" → is_potential:false, score:0 (Intra-Asia = sai tuyến)

❌ KHÔNG LIÊN QUAN / CHIA SẺ KIẾN THỨC (is_potential: false, score: 0):
- "Hướng dẫn sử dụng AI vào mô hình POD 2026 chi tiết" → Chia sẻ kiến thức, KHÔNG CẦN ship → score: 0
- "Cho hỏi liệt kê sản phẩm trên Amazon mà không có giá" → KHÔNG liên quan logistics. Buyer đang hỏi Amazon listing/SEO, KHÔNG cần ship/fulfill → score: 0
- "Ai biết cách nhận chấp thuận cho hàng hóa nguy hiểm?" → Hỏi về compliance/regulation, KHÔNG cần dịch vụ logistics → score: 0
- "Đang tìm nhập hàng từ Macy's/Target/Costco" → Mua hàng nội địa Mỹ, KHÔNG phải tuyến THG (VN/CN→US) → score: 0
- "Cho hỏi về lời khuyên liệt kê sản phẩm Amazon" → Hỏi listing/SEO tip, KHÔNG cần ship/fulfill → score: 0
- "Tìm inf LTD Hong Kong chính chủ" → Tìm công ty/giấy phép, KHÔNG cần logistics → score: 0
- "Ai biết chỗ bán buôn quần áo giá rẻ?" → Tìm nguồn hàng nội địa, KHÔNG đề cập ship quốc tế → score: 0
- "Giúp mình review sản phẩm trên Amazon" → Hỏi review/marketing, KHÔNG liên quan logistics → score: 0

🚫 QUẢNG CÁO DỊCH VỤ (TUYỆT ĐỐI KHÔNG PHẢI LEAD — BẮT BUỘC score: 0):
- "Công ty TNHH PT Thiên Long Phát Express | Hotline: 036xxx" → PROVIDER (có công ty, hotline, quảng cáo lộ liễu)
- "Bao thuế nhập khẩu 100%, có tracking theo dõi đơn hàng ✔️" → PROVIDER (cam kết, emoji chức năng phổ biến của agency)
- "Bên em cho thuê tài khoản TikTok Shop US, cam kết uy tín, inbox em" → PROVIDER (cho thuê dịch vụ + CTA inbox)
- "Bên mình cung cấp sản phẩm với giao hàng nhanh và giá thấp" → PROVIDER (cung cấp + giá/giao hàng = quảng cáo)
- "Shop mình có sẵn hàng mỹ phẩm, order từ 1 đơn, ib em" → PROVIDER (có sẵn hàng + CTA ibem)
- "Chúng tôi cho thuê kho tại PA, chất lượng cao, liên hệ ngay" → PROVIDER (cho thuê kho + CTA liên hệ)
- "Team em nhận order hàng từ TQ, gom hàng ship US, inbox ngay" → PROVIDER (nhận order + gom hàng = dịch vụ)
- "Bên mình chuyên bán nguyên liệu in áo, giá gốc xưởng" → PROVIDER (chuyên bán nguyên liệu = quảng cáo)
- "Em có xưởng sản xuất tại VN, nhận đơn từ 50 cái, zalo em" → PROVIDER (có xưởng + nhận đơn + CTA)

⚠️ CHÚ Ý PHÂN BIỆT — BUYER đang TÌM KIẾM vs PROVIDER đang CHÀO HÀNG:
- "Có bác nào cho thuê tài khoản quảng cáo không ạ?" → BUYER (đang HỎI TÌM, không phải chào bán) → CÓ THỂ là lead nếu đi kèm tín hiệu POD/ecom
- "Bên em cho thuê acc TikTok, inbox em nhé" → PROVIDER (đang CHÀO BÁN dịch vụ) → score: 0`;

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

    const groupCtx = post.group_name || post.source_group ? `\nGroup: ${post.group_name || post.source_group}` : '';

    return `Phân tích ${typeLabel} sau:

Platform: ${post.platform}${groupCtx}
Type: ${post.item_type || 'post'}${parentCtx}
Nội dung: ${(post.content || '').substring(0, 1500)}

Trả về JSON (object đơn, không phải array):
{
  "author_role": "seller_ecom" | "logistics_agency" | "spammer" | "unknown",
  "intent": "seeking_service" | "offering_service" | "sharing_knowledge" | "other",
  "is_potential": boolean,
  "score": number (NẾU is_potential=true thì PHẢI >= 60, NẾU false thì = 0),
  "service_match": "THG Fulfillment" | "THG Express" | "THG Warehouse" | "Both" | "None",
  "reasoning": "Giải thích ngắn gọn tại sao ĐẬU hoặc TRƯỢT (Bắt buộc).",
  "pain_points": "NẾU LÀ LEAD: Phân tích SÂU SẮC vấn đề/vướng mắc (bottleneck) khách đang gặp phải. NẾU TRƯỢT: Để trống.",
  "customer_persona": "NẾU LÀ LEAD: Bắt mạch tâm lý/tính cách khách qua văn phong (vd: Đang bức xúc/nóng tính, Cẩn thận/hỏi kỹ, Newbie cần dìu dắt, Thực tế/thích số liệu).",
  "sales_angle": "NẾU LÀ LEAD: Phác thảo kịch bản (Angle) tiếp cận GÃI ĐÚNG CHỖ NGỨA kết hợp Giải pháp THG + Tâm lý khách. Gợi ý luôn câu mở lời. NẾU TRƯỢT: Để trống.",
  "urgency": "low" | "medium" | "high",
  "profit_estimate": "Ước tính doanh số. Để trống nếu không phải buyer.",
  "gap_opportunity": "Tín hiệu đào tẩu (chê đối thủ). Để trống nếu không có."
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
        const groupCtx = p.group_name || p.source_group ? ` | Group: ${p.group_name || p.source_group}` : '';
        return `[${typeLabel} ${i + 1}] Platform: ${p.platform}${groupCtx}${parentCtx}\nContent: ${(p.content || '').substring(0, 600)}`;
    }).join('\n\n---\n\n');

    return `Phân tích ${posts.length} bài đăng/comment dưới đây. 

${postsList}

Trả về JSON object với key "results" là array ${posts.length} phần tử, theo đúng thứ tự:
{
  "results": [
    {"author_role":"...","intent":"...","is_potential":bool,"score":number,"service_match":"...","reasoning":"...","pain_points":"...","customer_persona":"...","sales_angle":"...","urgency":"...","profit_estimate":"...","gap_opportunity":"..."},
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
    buildAgentReply,
};

/**
 * Build a personalized reply prompt for a specific sales agent
 * Uses Master Brain (THG context + knowledge base) + agent's personal voice
 * 
 * @param {object} lead - the lead object from DB
 * @param {object} agentProfile - { name, tone, personal_note, deals_note }
 * @returns {{ system: string, user: string }}
 */
function buildAgentReply(lead, agentProfile) {
    const config = require('../../config');
    const { getContextForPrompt } = require('./knowledgeBase');

    const toneGuide = {
        friendly: 'Nhiệt tình, thân thiện, dùng emoji nhẹ nhàng, xưng hô "mình/bạn".',
        professional: 'Chuyên nghiệp, lịch sự, dùng "chúng tôi/quý khách", không emoji.',
        concise: 'Ngắn gọn, đi thẳng vào vấn đề, tối đa 3-4 câu, không vòng vo.',
    };

    const tone = toneGuide[agentProfile.tone] || toneGuide.friendly;
    const kbContext = getContextForPrompt(lead.content || '');

    const system = `Bạn là ${agentProfile.name} — Sale của THG Logistics.
Bạn đang trả lời một potential lead trên Facebook với phong cách: ${tone}
${agentProfile.personal_note ? `\nLưu ý cá nhân từ ${agentProfile.name}: "${agentProfile.personal_note}"` : ''}
${agentProfile.deals_note ? `\nƯu đãi riêng có thể dùng: "${agentProfile.deals_note}"` : ''}

=== KIẾN THỨC THG (MASTER BRAIN) ===
${config.THG_CONTEXT}
${kbContext ? `\n=== THÔNG TIN LIÊN QUAN ===\n${kbContext}` : ''}

QUY TẮC:
- Chỉ nói về dịch vụ THG, không được tự chế thông tin.
- Nếu khách hỏi điều không chắc, bảo khách để lại SĐT để team hỗ trợ chi tiết.
- Giữ đúng phong cách được yêu cầu xuyên suốt.
- Trả về CHỈ nội dung tin nhắn, không giải thích gì thêm.`;

    const user = `Lead: ${lead.author_name || 'Khách hàng'}
Nội dung post/comment: "${lead.content || ''}"
${lead.summary ? `AI tóm tắt nhu cầu: ${lead.summary}` : ''}
${lead.gap_opportunity ? `Cơ hội bán: ${lead.gap_opportunity}` : ''}
Dịch vụ phù hợp: ${lead.category || 'Chưa xác định'}

Hãy viết tin nhắn/comment reply phù hợp với phong cách của bạn để tiếp cận lead này.`;

    return { system, user };
}
