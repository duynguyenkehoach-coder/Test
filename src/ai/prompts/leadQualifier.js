/**
 * THG Lead Qualifier v5 — Agent-Powered Classification
 * 
 * Uses dynamic prompts from Agent:
 * - Knowledge Base: relevant company context per post
 * - Memory Store: past classifications + feedback
 * - Prompt Builder: assembles context-aware prompts
 */

const OpenAI = require('openai');
const config = require('../../config');
const { buildSystemPrompt, buildUserPrompt, buildBatchPrompt } = require('../agents/promptBuilder');
const { saveClassification } = require('../agents/memoryStore');
const { runProviderGuard, buildKnownProviderSet, buildKnownProviderNameSet } = require('../agents/providerGuard');

// ═══════════════════════════════════════════════════════
// AI Provider Chain: Ollama (local, NO limit) → Cerebras → Sambanova
// ❌ Groq REMOVED — constantly rate limited (429)
// ❌ Gemini REMOVED — key permanently suspended
// ═══════════════════════════════════════════════════════
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Provider 1: Ollama (PRIMARY — self-hosted on VPS, $0, NO rate limit!)
let ollama = null;
const OLLAMA_BASE_URL = config.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = config.OLLAMA_MODEL || 'qwen2.5:3b';
try {
    ollama = new OpenAI({
        apiKey: 'ollama',
        baseURL: `${OLLAMA_BASE_URL}/v1`,
    });
    console.log(`[Classifier] ✅ Ollama loaded (primary — ${OLLAMA_MODEL} @ ${OLLAMA_BASE_URL})`);
} catch (e) {
    console.warn('[Classifier] ⚠️ Ollama not available:', e.message);
}

// Provider 2: Cerebras (FALLBACK — cloud, free 30 RPM)
let cerebras = null;
if (config.CEREBRAS_API_KEY) {
    cerebras = new OpenAI({
        apiKey: config.CEREBRAS_API_KEY,
        baseURL: 'https://api.cerebras.ai/v1',
    });
    console.log('[Classifier] ✅ Cerebras loaded (fallback — llama3.1-8b)');
}

// Provider 3: Sambanova (FALLBACK 2 — cloud, free 30 RPM)
let sambanova = null;
if (config.SAMBANOVA_API_KEY) {
    sambanova = new OpenAI({
        apiKey: config.SAMBANOVA_API_KEY,
        baseURL: 'https://api.sambanova.ai/v1',
    });
    console.log('[Classifier] ✅ Sambanova loaded (fallback 2 — Meta-Llama-3.3-70B-Instruct)');
}

// Provider list for cascade (Ollama → Cerebras → Sambanova)
const PROVIDERS = [
    { name: 'Ollama', client: ollama, model: OLLAMA_MODEL, type: 'openai', timeout: 30000 },
    { name: 'Cerebras', client: cerebras, model: 'llama3.1-8b', type: 'openai', timeout: 15000 },
    { name: 'Sambanova', client: sambanova, model: 'Meta-Llama-3.3-70B-Instruct', type: 'openai', timeout: 15000 },
].filter(p => p.client);

console.log(`[Classifier] 🔄 Provider chain: ${PROVIDERS.map(p => p.name).join(' → ')}`);

let activeProviderIndex = 0;
let consecutiveErrors = 0;
const BATCH_SIZE = 5; // Posts per batch
const BATCH_DELAY_MS = 5000; // 5s delay — cloud fallbacks have 30 RPM limit

const PROVIDER_REGEX = /(chúng tôi nhận gửi|quy trình gửi hàng|lợi ích khi gửi hàng với chúng tôi|nhận gửi hàng đi|chuyên tuyến việt|cước phí cạnh tranh|cam kết giao tận tay|hỗ trợ tư vấn, chăm sóc khách hàng 24\/7|we offer fulfillment|shipping services from us|dịch vụ vận chuyển uy tín|không phát sinh chi phí|bao thuế bao luật|bao thuế 2 đầu|bao thuế|nhận pick up|đóng gói miễn phí|hút chân không|lh em ngay|lh em|liên hệ em|ib em ngay|ib em|ibox em|ibox ngay|inbox em|cmt em|chấm em|check ib|check inbox|dạ em nhận|em chuyên nhận|em chuyên vận chuyển|em chuyên gửi|em nhận ship|em nhận gửi|gửi hàng đi mỹ inbox|nhận vận chuyển|zalo: 0|tham khảo ngay|viettel post|epacket|saigonbay|nhận ship hàng|dịch vụ ship|cước ship|giá ship từ|bảng giá ship|đặt ship ngay|cam kết|chuyên gửi|nhận gửi|dịch vụ gửi|giao hàng nhanh|giao tận nơi|ship cod|bên em chuyên|bên em nhận|bên em có kho|bên em sẵn|bên mình chuyên|bên mình nhận|bên mình có kho|bên mình sẵn|anh.chị.*(tham khảo|liên hệ|ib|inbox|ibox)|giải pháp gửi hàng|ready to scale|from warehousing|we ship|we offer|contact us|whatsapp|xin phép admin|seller nên biết|nhận từ 1 đơn|chỉ từ \d+k|chỉ từ \d+đ|giá tốt nhất|nếu mọi người đang tìm|nếu anh.chị.*(cần|tìm|đang)|just launched.*(fulfillment|warehouse)|moving into our new|ecoli express|free quote|get started today|our warehouse|customs clearance|nhắn em để|nhắn em ngay|inbox ngay|mở rộng sản xuất|sẵn sàng cùng seller|xưởng.*sản xuất|fulfill trực tiếp|fulfill ngay tại|giá xưởng|giá gốc|báo giá|cần thêm thông tin.*nhắn|hỗ trợ.*nhanh nhất|đánh chiếm|siêu lợi nhuận|ưu đãi.*seller|chương trình.*ưu đãi|dm\s+for|dm\s+me|message\s+us|book\s+a\s+call|schedule\s+a\s+call|sign\s+up\s+now|sẵn sàng phục vụ|phục vụ.*seller|cung cấp dịch vụ|chúng tôi cung cấp|we\s+provide|we\s+specialize|our\s+service|tele\s*:\s*@|\bpm\s+em\b|\bpm\s+mình\b|gom đồ hộ|nhận mua hộ|nhận mua và gom|đường sea chỉ từ|đường bay chỉ từ|bay cargo|cước.{0,10}\d+[eđdk]\/kg|sẵn kho ở|em sẵn kho|hỗ trợ đóng gói|hỗ trợ lưu kho|pick.?up tận nơi|pick.?up tận nhà|free nhận đồ|free nhận hàng|nhận đồ tại nhà|gom hàng|xử lý trọn gói|tận tâm trên từng|đừng chần chừ|đừng bỏ lỡ|mở ưu đãi|cước.*chỉ\s*(?:từ\s*)?\d|bay thẳng.*\d+[eđdk]|traking|tracking theo dõi)/i;

// Pricing regex — catches logistics pricing ads: 159.000đ/kg, $2.5/kg, 8.2e/kg
const PRICING_AD_REGEX = /(?:cước|giá|price|rate|cost|phí)\s*.{0,20}\d+[.,]?\d*\s*(?:đ|d|k|usd|\$|e)\/(?:kg|kiện|cbm|m3|đơn|order|pcs)/i;

// Company name in content — "Phúc An Logistics", "XYZ Express", "Công ty TNHH", "Cổ phần"
const COMPANY_IN_CONTENT_REGEX = /(?:[A-ZÀ-Ỹ][a-zà-ỹ]+\s+){1,3}(?:logistics|express|shipping|cargo|freight|fulfillment|warehouse|vận chuyển|chuyển phát)|(công ty tnhh|cổ phần|cp|nhà phân phối).{1,30}(logistics|express|shipping|cargo|freight|fulfillment|vận chuyển|chuyển phát)/i;

// SERVICE_AD_REGEX — catches service ads with SELF-PROMOTION CONTEXT
// These patterns REQUIRE provider self-identification words ("bên em", "bên mình", "chúng tôi")
// to avoid false-positive blocking of BUYERS who mention similar terms while SEEKING services.
const SERVICE_AD_REGEX = /((bên em|bên mình|chúng tôi|chúng mình|shop em|shop mình|team em|team mình).{0,30}(cho thuê|cung cấp|nhận làm|sẵn kho|sẵn sàng|có sẵn|chuyên bán|chuyên cung|nhận order|gom order|nhà cung cấp|mở bán|đang bán|bán sỉ|bán lẻ|sỉ lẻ)|(cho thuê|cung cấp|nhận làm|sẵn kho|chuyên bán|chuyên cung|nhà cung cấp|mở bán|bán sỉ|sỉ lẻ).{0,30}(inbox em|ib em|liên hệ em|nhắn em|zalo em|lh em|check ib|inbox ngay|liên hệ ngay)|(bên em|bên mình|chúng tôi).{0,20}(cho thuê tài khoản|cho thuê acc|cho thuê shop|cho thuê kho|cho thuê dịch vụ)|(bên em|bên mình|chúng tôi|em).{0,15}(có|cung cấp|chuyên).{0,20}(sản phẩm|nguyên liệu|vật tư|hàng hóa).{0,20}(giá thấp|giá tốt|giá rẻ|giá cạnh tranh|giá gốc|chất lượng cao|giao nhanh))/i;

const IRRELEVANT_REGEX = /(hướng dẫn.*(pod|dropship|cách làm|chạy ads|bán hàng)|cách (làm|tạo|bắt đầu).*(pod|dropship|tiktok shop|etsy)|chia sẻ kinh nghiệm.*(pod|dropship)|recipe|cooking|football|soccer|gaming|movie|trailer|music video|crypto airdrop|token launch|weight loss|diet pill|korean bbq|beef|chicken|salad|mushroom|makeup|skincare|nail art|hair style|workout|gym|fitness|bible verse|prayer|astrology|horoscope|ritual|spell|food stamp|military|warzone|nuclear|missile|burmese|myanmar|capcut pioneer|kpop|anime|concert|healing|meditation)/i;
const MARKETING_REGEX = /(link in bio|tap to shop|shop now|save for later|#ad\b|#sponsored|swipe up|limited time offer|use code|promo code|giveaway alert|we're hiring)/i;

// Wrong-route filters: THG only serves VN/CN → US/World, NOT inbound to VN/CN
const DOMESTIC_VN_REGEX = /(giao hàng nhanh nội|ship cod toàn quốc|chuyển phát nội tỉnh|vận chuyển nội địa|giao tận nơi trong nước|ship nội thành|giao hàng toàn quốc|giao hàng tiết kiệm|giao hàng nhanh j&t|viettel post nội địa|nhất tín logistics|ghn nội địa)/i;
const TQ_TO_VN_REGEX = /(nhập hàng.{0,20}(trung quốc|tq|quảng châu|1688|taobao).{0,20}(về|ve).{0,20}(vn|việt nam|việt)|vận chuyển.{0,20}(tq|trung quốc).{0,20}(về|ve).{0,20}(vn|việt nam)|ship.{0,20}(tq|trung quốc).{0,20}(về|ve).{0,20}(vn|việt nam)|order.{0,20}(taobao|1688).{0,20}(về|ve).{0,20}(vn|việt)|hàng.{0,10}(tq|trung quốc).{0,10}(về|ve).{0,10}(vn|việt nam)|chuyển hàng.{0,15}(tq|trung quốc).{0,15}(về|ve).{0,10}(việt|vn)|gửi hàng.{0,10}(về|ve).{0,10}(việt nam|vn).{0,10}(từ|tu).{0,10}(mỹ|my|us))/i;
const US_TO_VN_REGEX = /(gửi (hàng|đồ|quà).{0,15}(về|ve).{0,15}(việt nam|vn|quê)|ship.{0,10}(hàng|đồ).{0,10}(về|ve).{0,10}(việt|vn)|chuyển (hàng|đồ|kiện hàng).{0,15}(từ|tu).{0,15}(mỹ|us|america|alberta|canada|úc|australia|nhật|hàn|đài|taiwan|korea|japan|pháp|đức|uk|châu âu|eu|world).{0,15}(về|ve).{0,15}(việt|vn))/i;
const WORLD_TO_CN_REGEX = /(chuyển (hàng|đồ|kiện).{0,15}(từ|tu).{0,15}(mỹ|us|america|alberta|canada|úc|nhật|hàn|vn|việt).{0,15}(về|ve).{0,15}(trung quốc|tq|china|quảng châu))/i;

// Blacklist: posts from these accounts are NEVER leads (they're competitors/providers)
const BLACKLIST_AUTHORS = ['merchize', 'bestexpressvn', 'boxmeglobal', 'printify', 'shopify', 'printful', 'amzprep', 'shiphype', 'salesupply', 'viettelpost', 'viettel post', 'saigonbay', 'ak47express', 'burgerprints', 'onospod', 'cj dropshipping', 'omega fulfillment', 'yourfulfillment', 'lizyprint', 'lizy print', 'tiximax', 'ecoli express', 'northpointe', 'northpointe logistics', 'sweats collective'];

// Must-have: posts without ANY business keyword are skipped (saves AI credits)
const MUST_HAVE_KEYWORDS = /(ship|vận chuyển|fulfillment|fulfill|pod|dropship|gửi hàng|tuyến|kho|warehouse|giá|báo giá|tìm đơn vị|logistics|3pl|fba|ecommerce|e-commerce|seller|bán hàng|order|đơn hàng|tracking|inventory|supplier|basecost|print on demand|freight|cargo|express|đóng gói|cần tìm|xưởng|prep|xin|nhờ|hỏi|tìm|cần|review|recommend|line us|ddp|forwarder|thông quan|customs|lcl|fcl|cbm|pallet|container|amazon|tiktok shop|etsy|shopify|mua hàng|hàng từ|gửi về|ship về|nhờ ai|ai biết|chỗ nào|ở đâu|mua ở|đặt hàng|order hàng|mua sỉ|nhập hàng|nguồn hàng|đồ từ|hàng việt|hàng trung)/i;

// ═══════════════════════════════════════════════════════
// LAYER 2 — Hard Pattern Guards (Phone, Link, Bio, Contact)
// Zero-cost regex — runs BEFORE AI, catches 10-15% extra providers
// ═══════════════════════════════════════════════════════

// Vietnamese phone number pattern (0[3|5|7|8|9]xxxxxxxx)
const PHONE_VN_REGEX = /(?:^|[\s\,\.\(\[])0[35789]\d{8}(?:$|[\s\,\.\)\]])/;

// Provider links — zalo, telegram, landing pages
const PROVIDER_LINK_REGEX = /(?:zalo\.me|t\.me|telegram\.me|wa\.me|m\.me\/[a-z]|bit\.ly|linktr\.ee|beacon\.by|flowpage\.com|shopee\.vn\/shop|lazada\.vn\/shop|tiktok\.com\/@[a-z])/i;

// Bio / author name signals of providers
const BIO_PROVIDER_REGEX = /\b(logistics|agency|freight|forwarder|fulfillment co|3pl|ceo|founder|director|manager|shipping company|courier|express co|nhà phân phối|đại lý|tuyển dụng)\b/i;

// Contact CTAs embedded in content: 'zalo: 09...', 'tel: 0...', 'sđt: 0...', 'hotline:'
const CONTACT_EMBED_REGEX = /(?:zalo|tel|sđt|phone|liên hệ|contact|hotline|địa chỉ)\s*[:\-]?\s*(?:0[35789]\d{7,}|[a-zA-Z0-9.\-_/]+)/i;

// Pain point keywords (buyer signals) for painScore computation
const PAIN_KEYWORDS_REGEX = /(lỗi|bị lỗi|lỗi thanh toán|cần tìm|cho hỏi|nhờ ai|ai biết|chỗ nào|ở đâu|review|recommend|bị khóa|hold tiền|mất hàng|hàng chậm|giao chậm|ship chậm|pixel không|chán rồi|tệ quá|bó tay|cần gấp|urgent|help|cần giúp|tư vấn giúp|giúp em|giúp mình|suggest|tìm kho|tìm xưởng|tìm bên|tìm đơn vị|tìm supplier|muốn bắt đầu|mới bắt đầu|lần đầu|chưa biết|không biết|đang tìm|có ai|ai có|nên chọn|nên dùng|so sánh|xin giá|báo giá giúp|rate\?|check giá|ib em giá|hỏi giá)/i;

/**
 * Compute spam score: count provider signals (phone, links, service language)
 * @param {string} content - Post content
 * @param {string} bio - Author bio
 * @returns {number} spamScore (0-10+)
 */
function computeSpamScore(content = '', bio = '') {
    let score = 0;
    if (PHONE_VN_REGEX.test(content)) score += 3;       // Phone in content = strong provider signal
    if (PROVIDER_LINK_REGEX.test(content)) score += 2;  // Provider links
    if (CONTACT_EMBED_REGEX.test(content)) score += 2;  // 'zalo: 09...'
    if (BIO_PROVIDER_REGEX.test(bio)) score += 2;       // Bio has agency/logistics
    // Count service-language phrases
    const serviceHits = (content.match(/(?:bên mình|bên em|chúng tôi|chúng mình).{0,20}(?:nhận|chuyên|cung cấp|hỗ trợ)/gi) || []).length;
    score += Math.min(serviceHits * 2, 4);
    // Count hashtags (providers spam hashtags)
    const hashtagCount = (content.match(/#[\wÀ-ỹ]+/g) || []).length;
    if (hashtagCount >= 5) score += 2;
    if (hashtagCount >= 10) score += 2;
    return score;
}

/**
 * Compute pain score: count buyer pain point signals
 * @param {string} content
 * @returns {number} painScore
 */
function computePainScore(content = '') {
    const matches = content.match(PAIN_KEYWORDS_REGEX) || [];
    // Also count question marks as buyer signals
    const questionCount = (content.match(/\?/g) || []).length;
    return Math.min(matches.length + Math.floor(questionCount / 2), 10);
}

// International route boost: THG serves VN/CN → US/World
const US_ROUTE_REGEX = /(mỹ|\bus\b|\busa\b|america|amazon|tiktok shop us|fba|đi mỹ|ship mỹ|kho mỹ|warehouse us|pennsylvania|texas|fulfill us|line us|美国|发美国)/i;
// UK/FR/DE = secondary markets (same priority as US)
const EU_ROUTE_REGEX = /(đức|\bgermany\b|đi đức|ship đức|kho đức|warehouse de|pháp|\bfrance\b|đi pháp|ship pháp|kho pháp|anh|\buk\b|\bengland\b|đi anh|ship anh|kho anh|warehouse uk|fulfillment uk|fulfillment eu|amazon\.de|amazon\.fr|amazon\.co\.uk|châu âu|europe|european market)/i;
const INTL_ROUTE_REGEX = /(nhật bản|\bjapan\b|đi nhật|ship nhật|gửi.{0,10}nhật|hàn quốc|\bkorea\b|đi hàn|ship hàn|gửi.{0,10}hàn|úc|\baustralia\b|đi úc|ship úc|đài loan|\btaiwan\b|uae|dubai|saudi|chile|colombia|mexico)/i;
const US_ROUTE_BOOST = 25;
const EU_ROUTE_BOOST = 20;  // UK/FR/DE = secondary market, nearly same as US
const INTL_ROUTE_BOOST = 15;

// ═══════════════════════════════════════════════════════
// Lead Intent Analyzer — Multilingual (EN/VN/CN)
// Maps pain points → THG products
// ═══════════════════════════════════════════════════════
const THG_INTENT_PATTERNS = {
    THG_EXPRESS: {
        // Shipping chậm, tracking, delivery delays
        regex: /(slow|delay|waiting|long time|shipping time|tracking|stuck|delivery issue|where is my order|giao chậm|ship chậm|đơn lâu|bao giờ tới|hàng bị kẹt|tracking pending|đi bao lâu|vận chuyển chậm|đơn đi đâu|chờ lâu|发货慢|物流慢|快递慢|追踪|运输时间)/i,
        solution: 'THG Express — Bay thẳng, tracking real-time, giao 2-5 ngày toàn US',
        boost: 15,
    },
    THG_FULFILL: {
        // POD, basecost, in ấn, sản phẩm
        regex: /(expensive|basecost|high fee|profit margin|printing cost|DTG|POD cost|phonecase|jersey|hawaiian shirt|canvas print|tìm xưởng in|basecost cao|giá in|lợi nhuận thấp|phí sản xuất|cần supplier POD|xưởng in|in thêu|定制|印刷成本|利润低|代发成本)/i,
        solution: 'THG Fulfill — Basecost thấp, in tại VN/CN/US, quality control',
        boost: 12,
    },
    THG_WAREHOUSE: {
        // Kho bãi, SKU, inventory, FBA prep
        regex: /(wrong product|inventory|stock issue|sku management|warehouse|FBA prep|3PL|fulfillment center|tồn kho|hết hàng|sai sản phẩm|quản lý đơn|OMS|WMS|kho bãi|cần kho|nhập kho|tìm kho|có kho|kho nào|xưởng|xưởng us|xưởng mỹ|factory|库存|仓库|发错货|SKU管理|入仓)/i,
        solution: 'THG Warehouse — Kho kép PA+TX, OMS/WMS real-time, miễn phí 90 ngày',
        boost: 15,
    },
    CUSTOMER_FRUSTRATION: {
        // Phàn nàn, bất mãn → lead nóng nhất
        regex: /(bad service|no response|scam|lost package|refund|complaint|terrible|worst|never again|tệ quá|chán rồi|lừa đảo|mất hàng|hoàn tiền|dịch vụ tệ|phản hồi chậm|bó tay|không bao giờ dùng|差评|服务差|投诉|骗子|退款)/i,
        solution: 'THG — Dịch vụ uy tín, hỗ trợ 24/7, cam kết chất lượng',
        boost: 20,
    },
};

/**
 * Phân tích ý định lead — multilingual (EN/VN/CN)
 * @param {string} content - Nội dung bài post/comment
 * @returns {{ categories: string[], priority: string, boost: number, solutions: string[] } | null}
 */
function analyzeLeadIntent(content) {
    if (!content || content.length < 10) return null;

    const detected = [];
    let totalBoost = 0;
    const solutions = [];

    for (const [category, config] of Object.entries(THG_INTENT_PATTERNS)) {
        if (config.regex.test(content)) {
            detected.push(category);
            totalBoost += config.boost;
            solutions.push(config.solution);
        }
    }

    if (detected.length === 0) return null;

    const isHigh = detected.length >= 2 || detected.includes('CUSTOMER_FRUSTRATION');

    return {
        categories: detected,
        priority: isHigh ? 'HIGH' : 'MEDIUM',
        boost: Math.min(totalBoost, 30), // Cap at +30
        solutions,
    };
}


// ═══════════════════════════════════════════════════════
// Parse + enforce scoring rules
// ═══════════════════════════════════════════════════════
function parseResult(result) {
    const role = result.author_role || 'unknown';
    const isProvider = role === 'logistics_agency' || role === 'spammer';

    // service_match = "None" means post has NO relevance to THG services → NOT a lead
    const serviceNone = !result.service_match || result.service_match === 'None' || result.service_match === 'none';
    const isPotential = result.is_potential === true && !isProvider && !serviceNone;

    let score = Math.min(100, Math.max(0, result.score || 0));

    if (isPotential && score < 60) {
        console.warn(`[Classifier] ⚠️ Model trả score ${score} cho buyer — tự động bump lên 60`);
        score = 60;
    }
    if (!isPotential) score = 0;

    // Log false positive catch
    if (result.is_potential === true && serviceNone) {
        console.log(`[Classifier] 🛡️ Blocked: is_potential=true but service_match=None — forced to score 0`);
    }

    return {
        isLead: isPotential,
        role: isPotential ? 'buyer' : (isProvider ? 'provider' : 'irrelevant'),
        score,
        category: serviceNone ? 'NotRelevant' : (result.service_match || 'General'),
        summary: isPotential ? (result.sales_angle || result.reasoning || '') : (result.reasoning || ''),
        urgency: isPotential ? (result.urgency || 'low') : 'low',
        buyerSignals: isPotential ? (result.customer_persona ? `[${result.customer_persona}] ${result.pain_points || ''}` : (result.pain_points || result.reasoning || '')) : '',
        profitEstimate: isPotential ? (result.profit_estimate || '') : '',
        gapOpportunity: isPotential ? (result.gap_opportunity || '') : '',
    };
}

// ═══════════════════════════════════════════════════════
// Core: Call any OpenAI-compatible provider
// ═══════════════════════════════════════════════════════
async function callProvider(provider, systemPrompt, userPrompt, maxTokens = 400) {
    const params = {
        model: provider.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
    };
    if (provider.type === 'openai') {
        params.response_format = { type: 'json_object' };
    }

    const timeoutMs = provider.timeout || 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await provider.client.chat.completions.create(params, { signal: controller.signal });
        return response.choices[0].message.content;
    } finally {
        clearTimeout(timer);
    }
}

function parseAIResponse(text) {
    let arr;
    try {
        const parsed = JSON.parse(text);
        arr = parsed.results || parsed.items || parsed.data;
        if (!Array.isArray(arr)) arr = Object.values(parsed).find(v => Array.isArray(v));
        if (!Array.isArray(arr) && parsed.is_potential !== undefined) return [parsed];
    } catch {
        const arrMatch = text.match(/\[[\s\S]*\]/);
        if (arrMatch) try { arr = JSON.parse(arrMatch[0]); } catch { }
        if (!arr) {
            const objMatch = text.match(/\{[\s\S]*\}/);
            if (objMatch) try { const obj = JSON.parse(objMatch[0]); arr = obj.results || [obj]; } catch { }
        }
    }
    return Array.isArray(arr) ? arr : null;
}

// ═══════════════════════════════════════════════════════
// Classify ≤10 posts with provider cascade
// ═══════════════════════════════════════════════════════
async function classifySmallBatch(posts) {
    const combinedContent = posts.map(p => p.content || '').join(' ');
    const sysPrompt = buildSystemPrompt(combinedContent);
    const usrPrompt = buildBatchPrompt(posts);

    for (let i = activeProviderIndex; i < PROVIDERS.length; i++) {
        const prov = PROVIDERS[i];
        try {
            const text = await callProvider(prov, sysPrompt, usrPrompt, 500 * posts.length);
            const arr = parseAIResponse(text);
            if (!arr || arr.length === 0) throw new Error('No valid array');
            consecutiveErrors = 0;
            if (i !== activeProviderIndex) {
                activeProviderIndex = i;
                console.log(`[Classifier] 🔄 Switched to: ${prov.name} (${prov.model})`);
            }
            return arr.map(r => parseResult(r));
        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit') || err.message?.includes('Too Many Requests');
            if (isLimit && i < PROVIDERS.length - 1) {
                console.warn(`[Classifier] ⚠️ ${prov.name} rate-limited → trying ${PROVIDERS[i + 1].name}...`);
                continue;
            }
            console.warn(`[Classifier] ⚠️ ${prov.name} error: ${err.message?.substring(0, 120)}`);
        }
    }
    // All 3 providers failed — fallback to individual classification
    console.warn('[Classifier] ⚠️ All providers failed for batch → trying individual...');
    const individual = [];
    for (const post of posts) { individual.push(await classifySinglePost(post)); await sleep(3000); }
    return individual;
}

// classifyBatch now delegates to classifySmallBatch (cascade: Ollama→Cerebras→Sambanova)
async function classifyBatch(posts) {
    return classifySmallBatch(posts);
}

// ═══════════════════════════════════════════════════════
// Single post classification using provider cascade
// ═══════════════════════════════════════════════════════
async function classifySinglePost(post) {
    if (PROVIDER_REGEX.test(post.content)) {
        return { isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Provider regex match', urgency: 'low', buyerSignals: '' };
    }

    const dynamicSystemPrompt = buildSystemPrompt(post.content);
    const userPrompt = buildUserPrompt(post);

    for (let i = activeProviderIndex; i < PROVIDERS.length; i++) {
        const prov = PROVIDERS[i];
        try {
            const text = await callProvider(prov, dynamicSystemPrompt, userPrompt, 400);
            const result = JSON.parse(text);
            consecutiveErrors = 0;
            return parseResult(result);
        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit') || err.message?.includes('Too Many Requests');
            if (isLimit && i < PROVIDERS.length - 1) {
                console.warn(`[Classifier] ⚠️ ${prov.name} rate-limited → trying ${PROVIDERS[i + 1].name}...`);
                continue;
            }
            console.warn(`[Classifier] ⚠️ ${prov.name} single-post error: ${err.message?.substring(0, 120)}`);
        }
    }
    return makeFallback();
}

// Keep old name exported for backward compat
const classifyPost = classifySinglePost;

// ═══════════════════════════════════════════════════════
// Gemini fallbacks (also use dynamic prompts)
// ═══════════════════════════════════════════════════════
async function classifyBatchWithGemini(posts) {
    if (!geminiModel) return null;
    try {
        const combinedContent = posts.map(p => p.content || '').join(' ');
        const dynamicPrompt = buildSystemPrompt(combinedContent);
        const postsList = posts.map((p, i) =>
            `[POST ${i + 1}] Platform: ${p.platform}\nContent: ${(p.content || '').substring(0, 600)}`
        ).join('\n\n');
        const prompt = dynamicPrompt + `\n\nPhân tích ${posts.length} bài. Trả về {"results": [...]}:\n\n${postsList}`;
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const arr = parsed.results || Object.values(parsed).find(v => Array.isArray(v));
        if (!Array.isArray(arr)) return null;
        return arr.map(r => parseResult(r));
    } catch (err) {
        // If Gemini 429, wait and retry once
        if (err.message?.includes('429') || err.message?.includes('Too Many Requests')) {
            console.warn('[Classifier] ⏳ Gemini 429 — waiting 60s before retry...');
            await new Promise(r => setTimeout(r, 60000));
            try {
                const combinedContent = posts.map(p => p.content || '').join(' ');
                const dynamicPrompt = buildSystemPrompt(combinedContent);
                const postsList = posts.map((p, i) =>
                    `[POST ${i + 1}] Platform: ${p.platform}\nContent: ${(p.content || '').substring(0, 600)}`
                ).join('\n\n');
                const prompt = dynamicPrompt + `\n\nPhân tích ${posts.length} bài. Trả về {"results": [...]}:\n\n${postsList}`;
                const result = await geminiModel.generateContent(prompt);
                const text = result.response.text();
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (!jsonMatch) return null;
                const parsed = JSON.parse(jsonMatch[0]);
                const arr = parsed.results || Object.values(parsed).find(v => Array.isArray(v));
                if (!Array.isArray(arr)) return null;
                return arr.map(r => parseResult(r));
            } catch (retryErr) {
                console.error('[Classifier] ❌ Gemini batch retry failed:', retryErr.message);
                return null;
            }
        }
        console.error('[Classifier] ❌ Gemini batch failed:', err.message);
        return null;
    }
}

async function classifyWithGemini(post) {
    if (!geminiModel) return null;
    try {
        const dynamicPrompt = buildSystemPrompt(post.content);
        const userPrompt = buildUserPrompt(post);
        const prompt = dynamicPrompt + '\n\n' + userPrompt;
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return parseResult(JSON.parse(jsonMatch[0]));
    } catch (err) {
        // If Gemini 429, wait 60s and retry once
        if (err.message?.includes('429') || err.message?.includes('Too Many Requests')) {
            console.warn('[Classifier] ⏳ Gemini 429 — waiting 60s...');
            await new Promise(r => setTimeout(r, 60000));
            try {
                const dynamicPrompt = buildSystemPrompt(post.content);
                const userPrompt = buildUserPrompt(post);
                const prompt = dynamicPrompt + '\n\n' + userPrompt;
                const result = await geminiModel.generateContent(prompt);
                const text = result.response.text();
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (!jsonMatch) return null;
                return parseResult(JSON.parse(jsonMatch[0]));
            } catch { /* give up */ }
        }
        console.error('[Classifier] ❌ Gemini failed:', err.message);
        return null;
    }
}

function makeFallback() {
    return { isLead: false, score: 0, category: 'NotRelevant', summary: 'Lỗi phân tích', urgency: 'low' };
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// Main classify pipeline with memory integration
// ═══════════════════════════════════════════════════════
async function classifyPosts(posts) {
    console.log(`[Classifier] 🧠 Classifying ${posts.length} posts (Agent-powered)...`);
    console.log(`[Classifier] 🔄 Providers: ${PROVIDERS.map(p => p.name).join(' → ')}`);

    const toClassify = [];
    const preFiltered = [];

    // ── Load forbidden keywords from DB (cached per batch) ──
    let forbiddenKws = [];
    let knownProviderUrls = new Set();
    let knownProviderNames = new Set();
    try {
        const database = require('../../core/data_store/database');
        forbiddenKws = database.db.prepare('SELECT keyword FROM forbidden_keywords').all().map(r => r.keyword.toLowerCase());
        // ── ProviderGuard: build known-provider sets once per batch ──
        knownProviderUrls = buildKnownProviderSet(database);
        knownProviderNames = buildKnownProviderNameSet(database);
        if (knownProviderUrls.size > 0) {
            console.log(`[ProviderGuard] 🛡️ Loaded ${knownProviderUrls.size} known provider URLs from DB`);
        }
    } catch (e) { /* DB not available in test env */ }

    for (const post of posts) {
        const content = post.content || '';
        const bio = post.author_bio || post.bio || '';
        const authorLower = (post.author_name || '').toLowerCase();

        if (content.length < 10) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Nội dung quá ngắn', spamScore: 0, painScore: 0 });
            continue;
        }

        // ─ Compute scores early (used for both filtering and saving) ─
        const spamScore = computeSpamScore(content, bio);
        const painScore = computePainScore(content);

        // ── LAYER G0: ProviderGuard Orchestrator (runs FIRST, zero AI cost) ──
        const guardResult = runProviderGuard(post, knownProviderUrls, knownProviderNames, painScore, spamScore);
        if (guardResult) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: guardResult.reason, urgency: 'low', buyerSignals: '', spamScore, painScore: 0 });
            console.log(`[ProviderGuard] 🛡️ ${guardResult.layer} BLOCKED: ${guardResult.reason.substring(0, 80)} | ${content.substring(0, 50)}...`);
            continue;
        }

        // Blacklist: posts from competitor accounts → skip
        if (BLACKLIST_AUTHORS.some(b => authorLower.includes(b))) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: `Blacklisted: @${post.author_name}`, urgency: 'low', buyerSignals: '', spamScore, painScore: 0 });
            continue;
        }

        // ── LAYER 1: Hard regex (existing PROVIDER_REGEX) ──
        if (PROVIDER_REGEX.test(content)) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Provider regex match', urgency: 'low', buyerSignals: '', spamScore, painScore: 0 });
            continue;
        }

        // ── LAYER 1b: Service advertisement regex (safe — requires provider context) ──
        if (SERVICE_AD_REGEX.test(content)) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Service ad detected (provider context)', urgency: 'low', buyerSignals: '', spamScore, painScore: 0 });
            console.log(`[Sieve] 🚫 ServiceAd block: ${content.substring(0, 80)}...`);
            continue;
        }

        // ── LAYER 2a: Phone number in content → almost always provider ──
        if (PHONE_VN_REGEX.test(content) && !painScore) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Phone number detected — Provider', urgency: 'low', buyerSignals: '', spamScore, painScore });
            console.log(`[Sieve] 📵 Phone block: ${content.substring(0, 60)}...`);
            continue;
        }

        // ── LAYER 2b: DB forbidden keywords check ──
        const contentLower = content.toLowerCase();
        const hitKeyword = forbiddenKws.find(kw => contentLower.includes(kw));
        if (hitKeyword && spamScore >= 2) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: `Forbidden keyword: "${hitKeyword}"`, urgency: 'low', buyerSignals: '', spamScore, painScore: 0 });
            console.log(`[Sieve] 🚫 Forbidden kw "${hitKeyword}" (spamScore:${spamScore}): ${content.substring(0, 60)}...`);
            continue;
        }

        // ── LAYER 2c: High spam score + no pain points → DISCARD ──
        if (spamScore >= 4 && painScore === 0) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: `SpamScore ${spamScore} — Provider CTA detected`, urgency: 'low', buyerSignals: '', spamScore, painScore });
            console.log(`[Sieve] 🗑️ SpamScore ${spamScore} discard: ${content.substring(0, 60)}...`);
            continue;
        }

        // ── LAYER 2d: Bio provider check ──
        if (BIO_PROVIDER_REGEX.test(bio) && !painScore) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: `Bio provider: "${bio.substring(0, 40)}"`, urgency: 'low', buyerSignals: '', spamScore, painScore });
            continue;
        }

        if (IRRELEVANT_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Không liên quan', spamScore, painScore });
            continue;
        }
        if (MARKETING_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Marketing content (brand page)', spamScore, painScore });
            continue;
        }
        // Wrong-route filters: THG only serves VN/CN → US/World
        if (DOMESTIC_VN_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Nội địa VN — sai tuyến', spamScore, painScore });
            continue;
        }
        if (TQ_TO_VN_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Tuyến TQ→VN — sai tuyến', spamScore, painScore });
            continue;
        }
        if (US_TO_VN_REGEX.test(content) || WORLD_TO_CN_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Tuyến World→VN/CN — sai tuyến', spamScore, painScore });
            continue;
        }
        if (COMPANY_IN_CONTENT_REGEX.test(content)) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Company name detected (Provider)', urgency: 'low', buyerSignals: '', spamScore: 10, painScore: 0 });
            continue;
        }
        // Must-have: no business keywords at all → skip (saves AI)
        if (!MUST_HAVE_KEYWORDS.test(content) && content.length < 200) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'No business keywords', spamScore, painScore });
            continue;
        }
        // Pass scores through to AI classification
        post._spamScore = spamScore;
        post._painScore = painScore;
        toClassify.push(post);
    }

    // Tag posts with intent analysis BEFORE sending to AI
    for (const post of toClassify) {
        post._intent = analyzeLeadIntent(post.content);
    }
    const intentTagged = toClassify.filter(p => p._intent).length;

    console.log(`[Classifier] 🔍 Pre-filter: ${preFiltered.length} posts skipped locally, ${toClassify.length} posts → AI`);
    if (intentTagged > 0) console.log(`[Classifier] 🎯 Intent detected in ${intentTagged} posts (score boost active)`);

    const BATCH_SIZE = 5;
    const results = [...preFiltered];
    activeProviderIndex = 0;
    consecutiveErrors = 0;
    let stopEarly = false;

    for (let i = 0; i < toClassify.length && !stopEarly; i += BATCH_SIZE) {
        const batch = toClassify.slice(i, i + BATCH_SIZE);
        try {
            const batchResults = await classifyBatch(batch);
            if (consecutiveErrors >= 5) stopEarly = true;
            for (let j = 0; j < batch.length; j++) {
                const merged = { ...batch[j], ...(batchResults[j] || makeFallback()) };

                // ── BOOST GUARD: KHÔNG cộng điểm cho rác ──
                // Nếu AI trả về isLead=false hoặc score < 60 → đi thẳng vào results, KHÔNG boost
                if (!merged.isLead || merged.score < 60) {
                    merged.spamScore = batch[j]._spamScore || 0;
                    merged.painScore = batch[j]._painScore || 0;
                    delete merged._spamScore;
                    delete merged._painScore;
                    delete merged._intent;
                    results.push(merged);
                    continue;
                }

                // Apply intent-based score boost (CHỈ cho leads đã đạt base >= 60)
                const intent = batch[j]._intent;
                if (intent && merged.role === 'buyer') {
                    merged.score = Math.min(100, (merged.score || 0) + intent.boost);
                    merged.intentCategories = intent.categories;
                    merged.thgSolutions = intent.solutions;
                    merged.intentPriority = intent.priority;
                    if (intent.priority === 'HIGH' && merged.score < 65) merged.score = 65;
                    merged.buyerSignals = `${merged.buyerSignals || ''} [Intent: ${intent.categories.join('+')}]`.trim();
                }
                // US-route boost: THG's priority market (VN/CN → US)
                if (merged.role === 'buyer' && US_ROUTE_REGEX.test(batch[j].content || '')) {
                    merged.score = Math.min(100, (merged.score || 0) + US_ROUTE_BOOST);
                    merged.buyerSignals = `${merged.buyerSignals || ''} [US-Route +${US_ROUTE_BOOST}]`.trim();
                    merged.isUSRoute = true;
                }
                // EU route boost: UK/FR/DE = secondary market (same tier as US)
                if (merged.role === 'buyer' && !merged.isUSRoute && EU_ROUTE_REGEX.test(batch[j].content || '')) {
                    merged.score = Math.min(100, (merged.score || 0) + EU_ROUTE_BOOST);
                    merged.buyerSignals = `${merged.buyerSignals || ''} [EU-Route +${EU_ROUTE_BOOST}]`.trim();
                    merged.isEURoute = true;
                }
                // Other international route boost: JP/KR/AU/TW/UAE/etc.
                if (merged.role === 'buyer' && !merged.isUSRoute && !merged.isEURoute && INTL_ROUTE_REGEX.test(batch[j].content || '')) {
                    merged.score = Math.min(100, (merged.score || 0) + INTL_ROUTE_BOOST);
                    merged.buyerSignals = `${merged.buyerSignals || ''} [INTL-Route +${INTL_ROUTE_BOOST}]`.trim();
                }
                // Even if AI says irrelevant, strong intent override
                // BUT: block override if content matches PROVIDER_REGEX or SERVICE_AD_REGEX
                const isProviderContent = PROVIDER_REGEX.test(batch[j].content || '') || SERVICE_AD_REGEX.test(batch[j].content || '');
                if (intent && intent.priority === 'HIGH' && merged.role !== 'provider' && !isProviderContent) {
                    if (!merged.isLead) {
                        merged.isLead = true;
                        merged.role = 'buyer';
                        merged.score = Math.max(merged.score || 0, 65);
                        merged.intentCategories = intent.categories;
                        merged.thgSolutions = intent.solutions;
                        merged.buyerSignals = `[Intent Override: ${intent.categories.join('+')}]`;
                        console.log(`[Classifier] 🔥 Intent override → buyer (${intent.categories.join('+')}): ${(batch[j].content || '').substring(0, 60)}`);
                    }
                }

                // ── POST-BOOST SAFETY NET: catch service ads that slipped through AI ──
                if (merged.isLead && merged.spamScore >= 3 && SERVICE_AD_REGEX.test(batch[j].content || '')) {
                    merged.isLead = false;
                    merged.role = 'provider';
                    merged.score = 0;
                    merged.summary = 'Post-boost safety: service ad detected (spamScore=' + merged.spamScore + ')';
                    console.log(`[Classifier] 🛡️ Post-boost safety net caught service ad: ${(batch[j].content || '').substring(0, 60)}`);
                }
                delete merged._intent;

                // Carry spam/pain scores onto result
                merged.spamScore = batch[j]._spamScore || 0;
                merged.painScore = batch[j]._painScore || 0;
                delete merged._spamScore;
                delete merged._painScore;

                results.push(merged);

                // Save to Agent Memory
                try { saveClassification(batch[j], batchResults[j] || makeFallback()); } catch (e) { }
            }
        } catch (err) {
            for (const post of batch) results.push({ ...post, ...makeFallback() });
        }

        const done = Math.min(i + BATCH_SIZE, toClassify.length);
        console.log(`[Classifier]   → ${done}/${toClassify.length} classified (batch ${Math.ceil(done / BATCH_SIZE)}/${Math.ceil(toClassify.length / BATCH_SIZE)}, provider: ${PROVIDERS[activeProviderIndex]?.name || 'None'})`);

        if (i + BATCH_SIZE < toClassify.length && !stopEarly) await sleep(BATCH_DELAY_MS);
    }

    if (stopEarly) {
        const classifiedCount = results.length - preFiltered.length;
        for (const post of toClassify.slice(classifiedCount)) {
            results.push({ ...post, ...makeFallback() });
        }
    }

    const leads = results.filter(r => r.isLead && r.score >= config.LEAD_SCORE_THRESHOLD);
    console.log(`[Classifier] ✅ Done! ${leads.length} qualified leads (score ≥ ${config.LEAD_SCORE_THRESHOLD}) out of ${posts.length} total posts`);
    console.log(`[Classifier]    📊 Breakdown: ${preFiltered.length} pre-filtered, ${toClassify.length} sent to AI`);

    const buyerPosts = results.filter(r => r.role === 'buyer');
    if (buyerPosts.length > 0) {
        console.log(`[Classifier] 🎯 Buyer posts found: ${buyerPosts.length}`);
        buyerPosts.forEach(p => {
            const tag = p.score >= config.LEAD_SCORE_THRESHOLD ? '✅' : '⚠️';
            const intentTag = p.intentCategories ? ` [${p.intentCategories.join('+')}]` : '';
            console.log(`[Classifier]   ${tag} Score ${p.score}${intentTag} | ${(p.content || '').substring(0, 80)}`);
        });
    }

    return results;
}

module.exports = { classifyPost, classifyPosts };
