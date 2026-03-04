const Groq = require('groq-sdk');
const config = require('../config');

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

// Gemini AI fallback
let geminiModel = null;
try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (config.GEMINI_API_KEY) {
        const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL || 'gemini-1.5-flash' });
        console.log('[Classifier] ✅ Gemini AI fallback loaded');
    }
} catch (e) { /* @google/generative-ai not installed */ }

// Fallback models: try main model first, then smaller/cheaper models
const AI_MODELS = [
    config.AI_MODEL || 'llama-3.3-70b-versatile',
    'meta-llama/llama-4-scout-17b-16e-instruct', // Llama 4 (fast, good quality)
    'llama-3.1-8b-instant',    // Smaller, uses fewer tokens
    'qwen-qwq-32b',           // Alibaba Qwen (good Vietnamese)
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
 * Classify a BATCH of posts in one AI call (5x faster)
 */
async function classifyBatch(posts) {
    // Build batch prompt
    const postsList = posts.map((p, i) =>
        `[POST ${i + 1}] Platform: ${p.platform}\nContent: ${(p.content || '').substring(0, 800)}`
    ).join('\n\n');

    const batchUserPrompt = `Phân tích ${posts.length} bài đăng sau. Trả về JSON ARRAY với ${posts.length} phần tử:

${postsList}

Trả về DUY NHẤT JSON array, mỗi phần tử theo format:
[
  {"author_role": "...", "intent": "...", "is_potential": boolean, "score": number, "service_match": "...", "reasoning": "...", "urgency": "..."},
  ...
]`;

    // Try each model
    for (let i = currentModelIndex; i < AI_MODELS.length; i++) {
        try {
            const model = AI_MODELS[i];
            const response = await groq.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: batchUserPrompt },
                ],
                temperature: 0.1,
                max_tokens: 400 * posts.length,
                response_format: { type: 'json_object' },
            });

            const raw = JSON.parse(response.choices[0].message.content);
            // Handle both array and object-with-array responses
            const arr = Array.isArray(raw) ? raw : (raw.results || raw.posts || raw.data || Object.values(raw));

            if (!Array.isArray(arr) || arr.length === 0) {
                throw new Error('AI did not return valid array');
            }

            consecutiveErrors = 0;
            if (i !== currentModelIndex) {
                currentModelIndex = i;
                console.log(`[Classifier] 🔄 Switched to model: ${model}`);
            }

            // Parse each result
            return arr.map(result => {
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
            });
        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
            if (isLimit && i < AI_MODELS.length - 1) {
                console.warn(`[Classifier] ⚠️ ${AI_MODELS[i]} hết limit → thử ${AI_MODELS[i + 1]}...`);
                continue;
            }
            if (isLimit) {
                consecutiveErrors++;
                // Try Gemini for the whole batch
                const geminiResults = await classifyBatchWithGemini(posts);
                if (geminiResults) return geminiResults;
            }
            // Fall back to individual classification
            console.warn(`[Classifier] ⚠️ Batch failed, falling back to individual: ${err.message}`);
            const individual = [];
            for (const post of posts) {
                individual.push(await classifyPost(post));
            }
            return individual;
        }
    }
    return posts.map(() => makeFallback());
}

/**
 * Batch classify via Gemini (fallback)
 */
async function classifyBatchWithGemini(posts) {
    if (!geminiModel) return null;
    try {
        console.log('[Classifier] 🔄 Batch Groq exhausted — trying Gemini batch...');
        const postsList = posts.map((p, i) =>
            `[POST ${i + 1}] Platform: ${p.platform}\nContent: ${(p.content || '').substring(0, 800)}`
        ).join('\n\n');

        const prompt = SYSTEM_PROMPT + `\n\nPhân tích ${posts.length} bài:\n\n${postsList}\n\nTrả về JSON array:`;
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return null;

        const arr = JSON.parse(jsonMatch[0]);
        return arr.map(r => {
            const role = r.author_role || 'unknown';
            const isProvider = role === 'logistics_agency' || role === 'spammer';
            const isPotential = r.is_potential === true && !isProvider;
            return {
                isLead: isPotential,
                role: isPotential ? 'buyer' : (isProvider ? 'provider' : 'irrelevant'),
                score: isPotential ? Math.min(100, Math.max(0, r.score || 0)) : 0,
                category: r.service_match === 'None' ? 'NotRelevant' : (r.service_match || 'General'),
                summary: r.reasoning || '',
                urgency: isPotential ? (r.urgency || 'low') : 'low',
                buyerSignals: isPotential ? (r.reasoning || '') : '',
            };
        });
    } catch (err) {
        console.error('[Classifier] ❌ Gemini batch also failed:', err.message);
        return null;
    }
}

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
            // Try Gemini before giving up
            const geminiResult = await classifyWithGemini(post);
            return geminiResult || makeFallback();
        }
    }

    // All Groq models failed — try Gemini
    const geminiResult = await classifyWithGemini(post);
    return geminiResult || makeFallback();
}

/**
 * Fallback: Classify using Google Gemini AI
 */
async function classifyWithGemini(post) {
    if (!geminiModel) return null;

    try {
        console.log('[Classifier] 🔄 Groq exhausted — trying Gemini...');
        const userPrompt = USER_PROMPT_TEMPLATE
            .replace('{platform}', post.platform)
            .replace('{content}', post.content.substring(0, 1500));

        const prompt = SYSTEM_PROMPT + '\n\n' + userPrompt;
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();

        // Extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        const role = parsed.author_role || 'unknown';
        const isProvider = role === 'logistics_agency' || role === 'spammer';
        const isPotential = parsed.is_potential === true && !isProvider;

        console.log('[Classifier] ✅ Gemini classified successfully');
        return {
            isLead: isPotential,
            role: isPotential ? 'buyer' : (isProvider ? 'provider' : 'irrelevant'),
            score: isPotential ? Math.min(100, Math.max(0, parsed.score || 0)) : 0,
            category: parsed.service_match === 'None' ? 'NotRelevant' : (parsed.service_match || 'General'),
            summary: parsed.reasoning || '',
            urgency: isPotential ? (parsed.urgency || 'low') : 'low',
            buyerSignals: isPotential ? (parsed.reasoning || '') : '',
        };
    } catch (err) {
        console.error('[Classifier] ❌ Gemini also failed:', err.message);
        return null;
    }
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
    // STEP 2: BATCH AI CLASSIFICATION — 5 posts per call (5x faster)
    // ═══════════════════════════════════════════════════
    const BATCH_SIZE = 5;
    const results = [...preFiltered];
    currentModelIndex = 0;
    consecutiveErrors = 0;
    let stopEarly = false;

    for (let i = 0; i < toClassify.length && !stopEarly; i += BATCH_SIZE) {
        const batch = toClassify.slice(i, i + BATCH_SIZE);

        try {
            const batchResults = await classifyBatch(batch);

            if (consecutiveErrors >= 5) {
                stopEarly = true;
            }

            for (let j = 0; j < batch.length; j++) {
                results.push({ ...batch[j], ...(batchResults[j] || makeFallback()) });
            }
        } catch (err) {
            // Fallback: classify individually
            for (const post of batch) {
                results.push({ ...post, ...makeFallback() });
            }
        }

        // Progress log
        const done = Math.min(i + BATCH_SIZE, toClassify.length);
        console.log(`[Classifier]   → ${done}/${toClassify.length} classified (batch ${Math.ceil(done / BATCH_SIZE)}/${Math.ceil(toClassify.length / BATCH_SIZE)}, model: ${AI_MODELS[currentModelIndex]})`);

        // 🛑 THROTTLE: 1s between batches (less delay needed since fewer calls)
        if (i + BATCH_SIZE < toClassify.length && !stopEarly) {
            await delay(1000);
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
