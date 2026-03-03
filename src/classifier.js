const Groq = require('groq-sdk');
const config = require('./config');

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

// Fallback models: try main model first, then smaller/cheaper models
const AI_MODELS = [
    config.AI_MODEL || 'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',    // Smaller, uses fewer tokens
    'llama-3.2-3b-preview',    // Tiny, very fast (replaced gemma2 — decommissioned)
    'meta-llama/llama-4-scout-17b-16e-instruct', // New Llama 4 fallback
];

const SYSTEM_PROMPT = `Bạn là Kỹ sư Data E-commerce làm việc cho THG Logistics. Nhiệm vụ của bạn là đọc bài đăng mạng xã hội và lọc ra CHÍNH XÁC những Seller/Doanh nghiệp đang CÓ NHU CẦU TÌM KIẾM dịch vụ hậu cần (Người mua).

${config.THG_CONTEXT}

🚨 QUY TẮC SỐNG CÒN (LOẠI BỎ FALSE POSITIVE):
1. NẾU bài viết mang tính chất QUẢNG CÁO, CHÀO MỜI dịch vụ từ các công ty vận chuyển, xưởng in, kho bãi khác -> Đánh dấu "author_role": "logistics_agency", "intent": "offering_service", và "is_potential": false. (Ví dụ: "Bên em nhận ship hàng đi US...", "Xưởng em nhận in áo...", "lh em", "ib em").
2. NẾU bài viết chỉ chia sẻ kiến thức, khoe đơn, không hỏi tìm đối tác -> "is_potential": false.
3. CHỈ chọn "is_potential": true khi TÁC GIẢ là người ĐANG TÌM KIẾM giải pháp hoặc ĐANG HỎI/CẦN GIÚP ĐỠ. (Ví dụ: "Cần tìm kho...", "Ai nhận đi hàng...", "Xưởng nào in...").
4. ĐẶC THÙ TIKTOK COMMENT: Nếu nội dung đầu vào rất ngắn (ví dụ: "xin giá", "check ib", "rổ giá sao shop", "đi line us bao lâu", "có kho PA không"). => BẮT BUỘC NHẬN DIỆN đây là "author_role": "seller_ecom", "intent": "seeking_service" và "is_potential": true. Mặc dù câu ngắn, nhưng đó là tín hiệu mua hàng rõ ràng.
5. ĐẶC THÙ REDDIT: Nếu nền tảng là Reddit, tác giả thường phàn nàn về nhà cung cấp cũ (ví dụ: 'My current supplier is too slow'). Hãy nhận diện đây là một "is_potential": true với intent tìm kiếm dịch vụ thay thế.

🎯 PHÂN LOẠI DỊCH VỤ THG (Nếu is_potential = true):
- "THG Fulfillment": Dành cho POD/Dropship chưa có hàng, cần xưởng in ấn/mua hộ và ship.
- "THG Express": Dành cho seller CÓ SẴN HÀNG ở VN/CN, cần book chuyến bay ship đi US/CA nhanh.
- "THG Warehouse": Dành cho seller bán Amazon/Tiktok cần THUÊ KHO tại Mỹ (Pennsylvania/NC) để stock hàng và ship nội địa.
- "None": Không khớp hoặc là bài quảng cáo của đối thủ.

📝 VÍ DỤ MẪU (FEW-SHOT):
- Input: "Bên mình có kho CA nhận xử lý FBM, FBA, Tiktok shop, giá rẻ."
  => Output: {"author_role": "logistics_agency", "intent": "offering_service", "is_potential": false, "service_match": "None", "reasoning": "Đây là đối thủ đang quảng cáo dịch vụ kho, không phải khách hàng.", "urgency": "low"}
  
- Input: "Mới tập tành làm POD, anh em cho hỏi app nào in áo thun rẻ mượt ship US ổn ạ?"
  => Output: {"author_role": "seller_ecom", "intent": "seeking_service", "is_potential": true, "service_match": "THG Fulfillment", "reasoning": "Seller mới đang tìm đơn vị sản xuất và ship POD.", "urgency": "medium"}

- Input: "Có 2 tạ hàng ở Tân Bình, cần đi air sang Mỹ trong tuần, ai nhận inbox."
  => Output: {"author_role": "seller_ecom", "intent": "seeking_service", "is_potential": true, "service_match": "THG Express", "reasoning": "Seller có hàng sẵn ở VN cần tìm đơn vị vận chuyển gấp.", "urgency": "high"}

- Input (TikTok Comment): "bên m nhận đi hàng lẻ từ kho tân bình ko ad?"
  => Output: {"author_role": "seller_ecom", "intent": "seeking_service", "is_potential": true, "service_match": "THG Express", "reasoning": "Khách comment hỏi dịch vụ vận chuyển hàng có sẵn từ VN.", "urgency": "medium"}

Trả về DUY NHẤT định dạng JSON được yêu cầu, không kèm text nào khác.
`;

const USER_PROMPT_TEMPLATE = `Phân tích bài đăng/comment sau:

Platform: {platform}
Nội dung: {content}

Trả về JSON:
{
  "author_role": "seller_ecom" | "logistics_agency" | "spammer" | "unknown",
  "intent": "seeking_service" | "offering_service" | "sharing_knowledge" | "other",
  "is_potential": boolean, 
  "score": number (0-100, dựa trên độ tiềm năng và khẩn cấp. NẾU is_potential=false -> điểm luôn 0),
  "service_match": "THG Fulfillment" | "THG Express" | "THG Warehouse" | "None",
  "reasoning": "Giải thích ngắn gọn tại sao chọn role và intent này. Phân tích ngữ cảnh nếu là TikTok hoặc Reddit.",
  "urgency": "low" | "medium" | "high"
}`;

// Danh sách từ khóa nhận diện nhanh Provider / Đối thủ quảng cáo
const PROVIDER_REGEX = /(chúng tôi nhận gửi|quy trình gửi hàng|lợi ích khi gửi hàng với chúng tôi|nhận gửi hàng đi|chuyên tuyến việt|cước phí cạnh tranh|cam kết giao tận tay|hỗ trợ tư vấn, chăm sóc khách hàng 24\/7|we offer fulfillment|shipping services from us|dịch vụ vận chuyển uy tín|không phát sinh chi phí|bao thuế bao luật|nhận pick up|đóng gói miễn phí|hút chân không|lh em ngay|lh em|liên hệ em|ib em ngay|ib em|inbox em|cmt em|chấm em|check ib|check inbox|dạ em nhận|em chuyên nhận|gửi hàng đi mỹ inbox|nhận vận chuyển|zalo: 0)/i;

// Track which model is currently working
let currentModelIndex = 0;
let consecutiveErrors = 0;

/**
 * Classify a single post — tries multiple models on rate limit
 */
async function classifyPost(post) {
    // 1. Regex Fast-Fail: Chặn ngay lập tức các bài quảng cáo lộ liễu
    if (PROVIDER_REGEX.test(post.content)) {
        return {
            isLead: false,
            role: "provider",
            score: 0,
            category: "NotRelevant",
            summary: "Bị chặn bởi bộ lọc từ khóa: Bài đăng quảng cáo dịch vụ (Provider).",
            urgency: "low",
            buyerSignals: ""
        };
    }

    const userPrompt = USER_PROMPT_TEMPLATE
        .replace('{platform}', post.platform)
        .replace('{content}', post.content.substring(0, 1500)); // Shorter to save tokens

    // Try each model in order
    for (let i = currentModelIndex; i < AI_MODELS.length; i++) {
        try {
            const model = AI_MODELS[i];
            const response = await groq.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.1,
                max_tokens: 350,
                response_format: { type: 'json_object' },
            });

            const result = JSON.parse(response.choices[0].message.content);
            consecutiveErrors = 0;

            // If we switched models, log it
            if (i !== currentModelIndex) {
                currentModelIndex = i;
                console.log(`[Classifier] 🔄 Switched to model: ${model}`);
            }

            // Parse new JSON format
            const role = result.author_role || 'unknown';
            const isProvider = role === 'logistics_agency' || role === 'spammer';
            const isPotential = result.is_potential === true && !isProvider;

            return {
                isLead: isPotential,
                role: isPotential ? 'buyer' : (isProvider ? 'provider' : 'irrelevant'),
                score: isPotential ? Math.min(100, Math.max(0, result.score || 0)) : 0,
                category: result.service_match === 'None' ? 'NotRelevant' : (result.service_match || 'General'),
                summary: result.reasoning || '',
                urgency: isPotential ? (result.urgency || 'low') : 'low',
                buyerSignals: isPotential ? (result.reasoning || '') : '',
            };
        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
            if (isLimit && i < AI_MODELS.length - 1) {
                console.warn(`[Classifier] ⚠️ ${AI_MODELS[i]} hết limit → thử ${AI_MODELS[i + 1]}...`);
                continue; // Try next model
            }

            // If it's a rate limit on the last model, wait and retry
            if (isLimit) {
                consecutiveErrors++;
                if (consecutiveErrors >= 5) {
                    console.error(`[Classifier] ❌ Tất cả model đều hết limit. Dừng classify.`);
                    return makeFallback();
                }
                const waitSec = Math.min(30, 5 * consecutiveErrors);
                console.warn(`[Classifier] ⏳ Waiting ${waitSec}s before retry...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                i = 0; // Retry from first model
                continue;
            }

            console.error('[Classifier] ✗ Error:', err.message);
            return makeFallback();
        }
    }

    return makeFallback();
}

function makeFallback() {
    return {
        isLead: false, score: 0, category: 'NotRelevant',
        summary: 'Lỗi phân tích (hết token AI)', urgency: 'low',
    };
}

// Simple irrelevant content filter (skip posts clearly not about logistics/ecommerce)
const IRRELEVANT_REGEX = /(recipe|cooking|football|soccer|gaming|movie|trailer|music video|crypto airdrop|token launch|weight loss|diet pill)/i;

// Delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classify a batch of posts with smart rate limiting
 * Strategy: Pre-filter → Sequential processing → 2s delay between calls
 */
async function classifyPosts(posts) {
    console.log(`[Classifier] 🧠 Classifying ${posts.length} posts...`);
    console.log(`[Classifier] 🔄 Models: ${AI_MODELS.join(' → ')}`);

    // ═══════════════════════════════════════════════════
    // STEP 1: PRE-FILTER — Skip obvious non-leads locally (no AI cost)
    // ═══════════════════════════════════════════════════
    const toClassify = [];
    const preFiltered = [];

    for (const post of posts) {
        const content = post.content || '';

        // Skip if content is too short to be meaningful
        if (content.length < 10) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Nội dung quá ngắn, bỏ qua.' });
            continue;
        }

        // Skip if PROVIDER_REGEX matches (obvious competitor ads)
        if (PROVIDER_REGEX.test(content)) {
            preFiltered.push({
                ...post,
                isLead: false, role: 'provider', score: 0,
                category: 'NotRelevant',
                summary: 'Bị chặn bởi bộ lọc từ khóa: Bài đăng quảng cáo dịch vụ (Provider).',
                urgency: 'low', buyerSignals: '',
            });
            continue;
        }

        // Skip if clearly irrelevant topic
        if (IRRELEVANT_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Không liên quan đến logistics/ecommerce.' });
            continue;
        }

        toClassify.push(post);
    }

    console.log(`[Classifier] 🔍 Pre-filter: ${preFiltered.length} posts skipped locally, ${toClassify.length} posts → AI`);

    // ═══════════════════════════════════════════════════
    // STEP 2: SEQUENTIAL AI CLASSIFICATION — One post at a time with 2s delay
    // ═══════════════════════════════════════════════════
    const results = [...preFiltered];
    currentModelIndex = 0;
    consecutiveErrors = 0;
    let stopEarly = false;

    for (let i = 0; i < toClassify.length && !stopEarly; i++) {
        const post = toClassify[i];
        const classification = await classifyPost(post);

        if (consecutiveErrors >= 5) {
            stopEarly = true;
        }

        results.push({ ...post, ...classification });

        // Progress log every 5 posts
        if ((i + 1) % 5 === 0 || i === toClassify.length - 1) {
            console.log(`[Classifier]   → ${i + 1}/${toClassify.length} classified (model: ${AI_MODELS[currentModelIndex]})`);
        }

        // 🛑 THROTTLE: Wait 2 seconds between each AI call to respect Groq free tier RPM
        if (i < toClassify.length - 1 && !stopEarly) {
            await delay(2000);
        }
    }

    if (stopEarly) {
        // Mark remaining posts as unclassified
        const classifiedCount = results.length - preFiltered.length;
        const remaining = toClassify.slice(classifiedCount);
        for (const post of remaining) {
            results.push({ ...post, ...makeFallback() });
        }
        console.warn(`[Classifier] ⚠️ ${remaining.length} posts skipped (AI quota exhausted)`);
    }

    const leads = results.filter(r => r.isLead && r.score >= config.LEAD_SCORE_THRESHOLD);
    console.log(`[Classifier] ✅ Done! ${leads.length} qualified leads (score ≥ ${config.LEAD_SCORE_THRESHOLD}) out of ${posts.length} total posts`);
    console.log(`[Classifier]    📊 Breakdown: ${preFiltered.length} pre-filtered, ${toClassify.length} sent to AI`);

    return results;
}

module.exports = { classifyPost, classifyPosts };
