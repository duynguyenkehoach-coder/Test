/**
 * THG Lead Gen — SociaVault API v3 + Self-Hosted Scraper
 * 
 * SCRAPE_MODE: 'sociavault' (paid API) or 'self-hosted' (free mbasic scraper)
 * 
 * ENDPOINT PATHS ĐÃ XÁC NHẬN:
 *   Facebook:  facebook/post/comments  → data.comments = {"0":{text, author:{name}}, "1":...}
 *   Instagram: instagram/comments      → data.comments = {"0":{text, user:{username}}, ...}
 *   TikTok:    tiktok/comments         → data.comments = null (nhiều video không có comment)
 *   TikTok:    tiktok/search/hashtag   → cần test thêm
 */

const axios = require('axios');
const config = require('../config');
const rotation = require('./rotation');

// Self-hosted scraper (mbasic.facebook.com)
const fbScraper = require('../agents/fbScraper');
const SCRAPE_MODE = process.env.SCRAPE_MODE || config.SCRAPE_MODE || 'sociavault';

const SV_API = 'https://api.sociavault.com/v1/scrape';
const SV_KEY = process.env.SOCIAVAULT_API_KEY || config.SOCIAVAULT_API_KEY || '';

const headers = () => ({ 'X-API-Key': SV_KEY });
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const database = require('../data_store/database');

// Credit tracking (monitoring + logging for dashboard)
const DAILY_LIMIT = config.SV_DAILY_LIMIT || 370;

function canSpend() {
    const stats = database.getCreditStats();
    if (stats.today >= DAILY_LIMIT) {
        console.warn(`[SV] 🔄 DAILY LIMIT REACHED: ${stats.today}/${DAILY_LIMIT} credits → auto-failover to self-hosted Playwright`);
        return false;
    }
    return true;
}
function getBudgetInfo() {
    const stats = database.getCreditStats();
    return {
        used: stats.today,
        limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - stats.today),
        pct: Math.round((stats.today / DAILY_LIMIT) * 100),
    };
}
function logCredit(endpoint, platform, source) {
    database.logCreditUsage(endpoint, platform || 'unknown', source || '');
    const budget = getBudgetInfo();
    console.log(`[SV] 💳 Credits: ${budget.used}/${budget.limit} (${budget.pct}%) — ${endpoint}`);
}
function spend() { logCredit('unknown', 'unknown', ''); }

async function svGet(endpoint, params = {}) {
    if (!SV_KEY) throw new Error('SOCIAVAULT_API_KEY not set');
    const resp = await axios.get(`${SV_API}/${endpoint}`, {
        headers: headers(), params, timeout: 60000,
    });
    if (!resp.data?.success) throw new Error(resp.data?.error || `SV ${endpoint} failed`);
    return resp.data?.data || resp.data;
}

// Convert object {"0":{...}, "1":{...}} hoặc array thành array
function toArr(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return Object.values(raw);
    return [];
}

// ════════════════════════════════════════════════════════
// ROTATION BATCH SIZES — ALWAYS scan ALL groups
// Auto-failover ensures: SociaVault → credits exhaust mid-scan → Playwright continues
// No group is ever skipped. Cost is handled automatically.
// ════════════════════════════════════════════════════════
const FB_GROUPS_PER_SCAN = 999;  // ALL groups — failover handles cost
const FB_COMPETITORS_PER_SCAN = 1;
const TT_HASHTAGS_PER_SCAN = 4;
const IG_ACCOUNTS_PER_SCAN = 3;

// ════════════════════════════════════════════════════════
// SIGNAL GATING — buyer vs provider detection
// PERSONA CLASSIFIER — enhanced dual-agent filtering
// ════════════════════════════════════════════════════════

// Provider signals (sale/advertising) — EXPANDED with log evidence
const PROVIDER_SIGNALS = [
    'bên em', 'bên mình', 'bên em chuyên', 'chúng tôi', 'nhận vận chuyển', 'nhận ship', 'nhận gửi',
    'dịch vụ', 'cam kết', 'giá rẻ', 'giá rẻ nhất', 'uy tín', 'hotline', 'liên hệ', 'lh',
    'zalo', 'call', 'inbox em', 'inb e', 'inb tư vấn', 'inbox tư vấn', 'ib tư', 'check ib',
    'chuyên cung cấp', 'chuyên nhận', 'nhận order', 'gom order',
    'liên hệ số', 'sđt', 'liên hệ hotline', 'chào hàng', 'bảng giá', 'giảm giá',
    'nhận sll', 'bao thuế', 'tuyến bay riêng', 'chiết khấu', 'hỗ trợ 24/7',
    'fullfillment giá tốt', 'kho em có sẵn', 'liên hệ ngay', 'hỗ trợ chi tiết',
    'đội ngũ', 'kinh nghiệm', 'năm kinh nghiệm', 'chuyên nghiệp',
    'zalo em', 'zl em', 'ib em', 'inbox mình', 'ib mình',
    // NEW: from real log evidence
    'nhà làm', 'sản xuất', 'manufacturing', 'new product', 'new products',
    'ib me', 'dm me', 'dm for', 'order now', 'mua ngay', 'đặt ngay',
    'cont hàng', 'hàng tiểu ngạch', 'hàng chính ngạch', 'approved dùm',
    'chương trình ưu đãi', 'ưu đãi', 'khuyến mãi', 'flash sale',
    'nhà phân phối', 'đại lý', 'reseller', 'wholesale', 'sỉ lẻ',
    'gate', 'happpy', 'happy international', 'sunnie bay',
    '0903', '0909', '0912', '0918', '0938', '0968', '0978',  // Vietnamese phone patterns
];

// Buyer/seeker signals (people looking for services) — EXPANDED
const SEEKER_SIGNALS = [
    'cần tìm', 'có ai nhận', 'bên nào đi được', 'xin giá', 'báo giá giúp',
    'hỏi về', 'có kho nào', 'tư vấn giúp', 'tìm đơn vị', 'ai biết',
    'cần', 'tìm', 'xin', 'nhờ', 'hỏi', 'recommend', 'review',
    'báo giá', 'rate', 'quote', 'giá bao nhiêu', 'bao lâu', 'ship mấy ngày',
    'ddp', 'door to door', 'line us', 'ship to us', 'ship mỹ', 'kho', '3pl', 'fulfillment',
    'fba', 'ship to amazon', 'prep',
    'cước bao nhiêu', 'giá cước', 'phí vận chuyển', 'mất mấy ngày', 'transit time',
    'có nhận hàng', 'ai ship được', 'ai gửi được', 'cần gửi', 'muốn gửi'
];

// Comment-level sale signals (LOẠI BỎ comments quảng cáo)
const COMMENT_SALE_SIGNALS = [
    'check inbox', 'check ib', 'inbox mình', 'ib mình', 'inbox em', 'ib em',
    'bên mình có', 'bên em có', 'bên mình nhận', 'bên em nhận',
    'liên hệ', 'lh:', 'zalo:', 'hotline:', 'sđt:', 'call:',
    'đã nhắn tin', 'đã ib', 'check tin nhắn'
];

function isProviderText(s) {
    const count = PROVIDER_SIGNALS.filter(x => s.includes(x)).length;
    if (count >= 2) return true;  // ≥2 provider signals = definitely provider
    if (count === 1) {
        // 1 provider signal: check if has phone/URL as confirmation
        if (/\b(0\d{8,10})\b/.test(s)) return true;
        if (/(https?:\/\/|\.com|\.vn|wa\.me)/.test(s)) return true;
    }
    return false;
}

function isBuyerText(s) {
    if (SEEKER_SIGNALS.some(x => s.includes(x))) return true;
    if (/\?\s*$/.test(s)) return true; // ends with question mark
    return false;
}

/**
 * PERSONA CLASSIFIER — isRealCustomer (Post Scout filter)
 * Returns true if the post is from a real customer/buyer, not a provider/sale ad.
 * Provider-logistics posts return false but are tagged separately by signalScores.
 */
function isRealCustomer(text) {
    const s = text.toLowerCase();

    // Step 1: Count provider signals — ≥2 means definitely provider
    const providerScore = PROVIDER_SIGNALS.filter(w => s.includes(w)).length;
    if (providerScore >= 2) return false;

    // Step 2: Check if seeker/buyer
    const isSeeking = SEEKER_SIGNALS.some(w => s.includes(w));

    // Step 3: Icon density — providers spam emojis, buyers write naturally
    const iconCount = (text.match(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g) || []).length;
    if (iconCount >= 5 && !isSeeking) return false; // emoji-heavy + no seeker signal = ad

    // Step 4: If clearly seeking services → real customer
    if (isSeeking && iconCount < 5) return true;

    // Step 5: If has question marks and isn't provider → likely buyer
    if (/\?/.test(text) && providerScore === 0) return true;

    // Step 6: No strong signal either way — keep for AI to classify later
    return providerScore === 0;
}

/**
 * COMMENT SCOUT — isRealCustomerComment
 * Filters comments: keeps buyer-intent comments, removes sale/advertising comments.
 */
function isRealCustomerComment(text) {
    const s = text.toLowerCase();

    // Sale comment → reject
    const saleScore = COMMENT_SALE_SIGNALS.filter(w => s.includes(w)).length;
    if (saleScore >= 1) return false;

    // Phone number in comment → probably provider responding
    if (/\b(0\d{8,10})\b/.test(s)) return false;

    // Buyer-intent comment → keep
    if (SEEKER_SIGNALS.some(w => s.includes(w))) return true;
    if (/\?/.test(text)) return true;  // has question mark

    // Short generic comment without signal → keep (might be buyer)
    return true;
}

function signalScores(text = '') {
    const s = text.toLowerCase();

    // Hard negatives — noise, wrong-route, personal, irrelevant content
    const neg = [
        // Job/hiring
        'tuyển dụng', 'job', 'hiring', 'intern', 'tuyển nhân viên',
        // Promo noise
        'giveaway', 'minigame', 'bốc thăm', 'trúng thưởng', 'quay số',
        // Tech/craft noise
        'order walmart', 'jammed kitchen', 'printer', 'labels', 'canvas', 'thêu', 'embroidery',
        'coaching', 'coach', 'site down', 'support no response',
        // Real estate / housing — NOT shipping customers
        'bất động sản', 'real estate', 'mua nhà', 'bán nhà', 'phòng share', 'room for rent',
        'cho thuê phòng', 'rent room', 'mortgage', 'refinance', 'condo', 'townhouse',
        'metro village', 'discount up to', 'incentive', 'down payment',
        // Insurance / finance
        'bảo hiểm', 'insurance', 'obamacare', 'medicare', 'tax return', 'thuế',
        // Religion / personal
        'nam mô', 'lạy chúa', 'phật', 'kinh thánh', 'cầu nguyện', 'chúa', 'amen',
        // Beauty/nail services (local, not shipping)
        'lông mi', 'nối mi', 'lash', 'nails hiring', 'tiệm nail', 'brow',
        // Politics / news
        'tổng thống', 'trump', 'biden', 'quốc hội', 'election', 'congress',
        // Car sales
        'bán xe', 'bán honda', 'bán toyota', 'bán camry', 'bán civic',
        // Travel
        'du lịch', 'tour', 'vé máy bay', 'booking',
        // Community events
        'vui xuân', 'tết', 'lễ hội', 'picnic', 'hội ngộ', 'gala dinner'
    ];
    if (neg.some(x => s.includes(x))) return { express: 0, wh: 0, any: 0, buyer: 0, provider: 0 };

    // Food/perishable filter — personal shipping, NOT business customers
    const foodSignals = [
        'đồ ăn', 'thực phẩm', 'thức ăn', 'food', 'bánh', 'bánh tráng', 'bánh tét', 'bánh chưng',
        'chả giò', 'nem', 'mắm', 'nước mắm', 'mắm tôm', 'mắm ruốc',
        'khô', 'khô bò', 'khô mực', 'khô cá', 'trái cây', 'hoa quả',
        'hải sản', 'tôm', 'cua', 'cá', 'đông lạnh', 'frozen',
        'gia vị', 'bột', 'bún', 'phở', 'mì', 'nui', 'gạo',
        'trà', 'cà phê', 'coffee', 'snack', 'kẹo', 'mứt',
        'rau', 'củ', 'nấm', 'gửi đồ ăn', 'ship đồ ăn',
        'gửi thức ăn', 'gửi bánh', 'gửi khô', 'gửi mắm'
    ];
    const foodCount = foodSignals.filter(x => s.includes(x)).length;
    if (foodCount >= 2) return { express: 0, wh: 0, any: 0, buyer: 0, provider: 0 };

    // Wrong-route filter: TQ→VN, domestic VN, US→VN = no signal (save credits)
    const wrongRoute = [
        'giao hàng tiết kiệm', 'giao hàng nhanh j&t', 'viettel post nội',
        'ship cod toàn quốc', 'chuyển phát nội tỉnh', 'giao tận nơi trong nước',
        'nhập hàng trung quốc về', 'order taobao về vn', 'hàng tq về việt nam',
        'ship tq về vn', 'vận chuyển tq về vn', 'hàng trung quốc về việt nam',
        'gửi đồ về việt nam từ mỹ', 'gửi hàng về quê từ mỹ', 'gửi quà về vn',
        'ship hàng về việt nam', 'chuyển hàng về vn từ mỹ'
    ];
    if (wrongRoute.some(x => s.includes(x))) return { express: 0, wh: 0, any: 0, buyer: 0, provider: 0 };

    const provider = isProviderText(s) ? 1 : 0;
    const buyer = isBuyerText(s) ? 1 : 0;
    const persona = isRealCustomer(text) ? 'buyer' : 'provider';

    // Provider post about logistics → STILL hydrate comments (buyers reply to these!)
    const logisticsTerms = ['ship', 'vận chuyển', 'ddp', 'fba', 'fulfillment', 'kho', 'warehouse',
        '3pl', 'line us', 'gửi hàng', 'freight', 'lcl', 'fcl', 'thông quan', 'prep'];
    const isLogisticsPost = logisticsTerms.some(t => s.includes(t));

    // Provider without buyer intent AND not about logistics → noise, skip
    if (provider && !buyer && !isLogisticsPost) return { express: 0, wh: 0, any: 0, buyer: 0, provider: 1, providerLogistics: false, persona };

    // Provider post about logistics: we want comments but lower priority
    const providerLogistics = (provider && !buyer && isLogisticsPost) ? 1 : 0;

    // Express triggers
    const expressTerms = [
        'ddp', 'line us', 'ship mỹ', 'ship to us', 'đi mỹ', 'báo giá', 'rate', 'quote',
        'air', 'sea', 'lcl', 'fcl', 'thông quan', 'custom', 'isf', 'hs code',
        'gửi hàng', 'xuất hàng', 'battery', 'liquid', 'magnet', 'epacket',
        'ship quốc tế', 'vận chuyển', 'door to door', 'forwarder'
    ];

    // Warehouse triggers (POD/dropship removed — too noisy)
    const whTerms = [
        '3pl', 'warehouse', 'kho pa', 'kho tx', 'pick pack', 'prep', 'fba prep', 'fba',
        'ship to amazon', 'returns', 'cross-dock', 'tiktok shop us', 'shopify', 'wms', 'oms',
        'kho mỹ', 'kho us', 'lưu kho', 'fulfill', 'fulfillment'
    ];

    let express = expressTerms.filter(t => s.includes(t)).length * 12;
    let wh = whTerms.filter(t => s.includes(t)).length * 12;

    // Volume boost (meaningful for express)
    if (/\b(\d+(\.\d+)?)\s?(kg|cbm|m3|pallet|carton|container)\b/.test(s)) express += 20;

    // Short buyer signals — only if NOT provider
    const shortBuyer = ['xin giá', 'báo giá', 'rate', 'quote', 'giá bao nhiêu', 'bao lâu',
        'ship mấy ngày', 'có kho', 'có line'];
    if (!provider && shortBuyer.some(x => s.includes(x))) {
        express = Math.max(express, 25);
        wh = Math.max(wh, 25);
    }

    const any = Math.max(express, wh);
    // If no buyer signal, reduce — but provider logistics posts get minimum score for comment hydration
    let anyFinal;
    if (providerLogistics) {
        anyFinal = Math.max(any, 20); // provider logistics = buyers in comments!
    } else if (buyer) {
        anyFinal = any;
    } else {
        anyFinal = Math.max(0, any - 15);
    }

    return { express, wh, any: anyFinal, buyer, provider, providerLogistics, persona };
}

// ════════════════════════════════════════════════════════
// DEEP SCOUT — Sentiment Analysis + Service Classification
// Tìm khách đang "bực bội" với đơn vị cũ = CƠ HỘI VÀNG
// ════════════════════════════════════════════════════════

/**
 * Analyze sentiment: detect frustrated customers vs normal inquiries.
 * FRUSTRATED = đang gặp vấn đề với đơn vị cũ → cơ hội vàng cho THG.
 */
function analyzeSentiment(text) {
    const s = text.toLowerCase();

    const frustrationKeywords = [
        'chậm', 'tắc biên', 'mất hàng', 'đắt', 'đắt quá', 'không hỗ trợ', 'lâu quá',
        'bực', 'thất vọng', 'đơn vị cũ', 'chán', 'hàng bị giữ', 'hàng bị trả',
        'trễ hẹn', 'trễ', 'giao chậm', 'delay', 'lost', 'late', 'expensive',
        'hư hỏng', 'bể', 'vỡ', 'thiếu', 'mất kiện', 'không liên lạc được',
        'không trả lời', 'phản hồi chậm', 'không chuyên nghiệp', 'thái độ tệ',
        'lừa đảo', 'bị lừa', 'đền bù', 'khiếu nại', 'hoàn tiền',
        'gặp vấn đề', 'complaint', 'damaged', 'broken', 'issue', 'problem'
    ];

    const urgentKeywords = [
        'gấp', 'urgent', 'asap', 'khẩn', 'càng sớm càng tốt', 'cần ngay',
        'hôm nay', 'ngày mai', 'tuần này', 'deadline', 'rush'
    ];

    const frustrationCount = frustrationKeywords.filter(kw => s.includes(kw)).length;
    const isUrgent = urgentKeywords.some(kw => s.includes(kw));

    if (frustrationCount >= 2) return { sentiment: 'FRUSTRATED', frustrationCount, urgent: isUrgent };
    if (frustrationCount === 1) return { sentiment: 'FRUSTRATED', frustrationCount, urgent: isUrgent };
    if (isUrgent) return { sentiment: 'URGENT', frustrationCount: 0, urgent: true };
    return { sentiment: 'INQUIRY', frustrationCount: 0, urgent: isUrgent };
}

/**
 * Parse what service the customer needs.
 * Returns null if wrong-route (VN/TQ import = skip).
 */
function parseServiceType(text) {
    const s = text.toLowerCase();

    // Wrong-route: hàng VỀ VN/TQ → skip (not THG's market)
    if (['về vn', 'về tq', 'về việt nam', 'nhập từ', 'nhập hàng về'].some(kw => s.includes(kw))) {
        return null;
    }

    let service = 'SHIPPING_GENERAL';
    if (s.includes('fulfillment') || s.includes('ff ') || s.includes(' ff')) service = 'FULFILLMENT';
    if (s.includes('warehouse') || s.includes('kho mỹ') || s.includes('kho us') || s.includes('3pl')) service = 'WAREHOUSE';
    if (s.includes('pod') || s.includes('dropship') || s.includes('print on demand')) service = 'POD/DROPSHIP';
    if (s.includes('fba') || s.includes('ship to amazon') || s.includes('fba prep')) service = 'FBA_PREP';
    if (s.includes('express') || s.includes('air') || s.includes('đường bay')) service = 'EXPRESS_AIR';
    if (s.includes('sea') || s.includes('đường biển') || s.includes('lcl') || s.includes('fcl')) service = 'SEA_FREIGHT';

    const destination = (s.includes('mỹ') || s.includes('us') || s.includes('usa') || s.includes('america'))
        ? 'USA'
        : (s.includes('eu') || s.includes('châu âu') || s.includes('europe'))
            ? 'EU'
            : (s.includes('úc') || s.includes('australia'))
                ? 'AUSTRALIA'
                : 'GLOBAL';

    return { service, destination };
}

/**
 * DEEP SCOUT: Enrich a scraped item with full intelligence.
 * Combines: persona + sentiment + service type + urgency score.
 */
function deepScoutEnrich(item) {
    const text = item.content || '';
    const sig = signalScores(text);
    const sentimentInfo = analyzeSentiment(text);
    const serviceInfo = parseServiceType(text);

    // Urgency scoring (0-10 scale)
    let urgencyScore = 5; // baseline

    // Sentiment boost
    if (sentimentInfo.sentiment === 'FRUSTRATED') urgencyScore += 3;
    if (sentimentInfo.frustrationCount >= 2) urgencyScore += 2; // very frustrated
    if (sentimentInfo.urgent) urgencyScore += 2;

    // Service specificity boost
    if (serviceInfo && serviceInfo.service !== 'SHIPPING_GENERAL') urgencyScore += 1;
    if (serviceInfo?.service === 'FBA_PREP' || serviceInfo?.service === 'FULFILLMENT') urgencyScore += 1;

    // Buyer persona boost
    if (sig.persona === 'buyer') urgencyScore += 1;

    // Cap at 10
    urgencyScore = Math.min(10, urgencyScore);

    // Map urgency score to label
    const urgencyLabel = urgencyScore >= 8 ? 'critical' : urgencyScore >= 6 ? 'high' : urgencyScore >= 4 ? 'medium' : 'low';

    return {
        ...item,
        persona: sig.persona,
        sentiment: sentimentInfo.sentiment,
        service_needed: serviceInfo?.service || 'UNKNOWN',
        destination: serviceInfo?.destination || 'UNKNOWN',
        urgency_score: urgencyScore,
        urgency: urgencyLabel,
        pain_point: sentimentInfo.sentiment === 'FRUSTRATED'
            ? text.substring(0, 200)
            : '',
    };
}

// ════════════════════════════════════════════════════════
// FRESHNESS CHECK — filter BEFORE hydrating comments
// ════════════════════════════════════════════════════════
function isFresh(isoOrNull, maxDays = 10) {
    if (!isoOrNull) return false;
    const t = new Date(isoOrNull).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) <= maxDays * 24 * 60 * 60 * 1000;
}

// ════════════════════════════════════════════════════════
// FACEBOOK
// ════════════════════════════════════════════════════════

// Response verified: data.comments.{0..n}.{text, created_at, author:{name, id}}
async function fbGetPostComments(postUrl, source) {
    // ═══ SELF-HOSTED MODE: use fbScraper (FREE) ═══
    if (SCRAPE_MODE === 'self-hosted') {
        try {
            return await fbScraper.getPostComments(postUrl, source);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ Self-hosted comment scrape failed: ${err.message}`);
            return [];
        }
    }

    // ═══ SOCIAVAULT MODE: paid API (auto-failover to self-hosted when credits exhausted) ═══
    if (!canSpend()) {
        console.log(`[SV:FB] 🔄 Credits exhausted → auto-failover to self-hosted Playwright`);
        try {
            return await fbScraper.getPostComments(postUrl, source);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ Failover comment scrape failed: ${err.message}`);
            return [];
        }
    }

    try {
        const data = await svGet('facebook/post/comments', { url: postUrl });
        logCredit('facebook/post/comments', 'facebook', source);

        return toArr(data.comments).map(item => ({
            platform: 'facebook',
            post_url: postUrl,
            author_name: item.author?.name || 'Unknown',
            author_url: item.author?.id ? `https://www.facebook.com/${item.author.id}` : '',
            content: (item.text || '').trim(),
            post_created_at: item.created_at || new Date().toISOString(),
            scraped_at: new Date().toISOString(),
            source,
            likes: item.reaction_count || 0,
            comments: item.reply_count || 0,
        })).filter(p => p.content.length > 5);
    } catch (apiErr) {
        // API error → auto-failover to self-hosted
        console.warn(`[SV:FB] ⚠️ SociaVault API error: ${apiErr.message} → failover to self-hosted`);
        try {
            return await fbScraper.getPostComments(postUrl, source);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ Failover comment scrape also failed: ${err.message}`);
            return [];
        }
    }
}

async function fbGetGroupPosts(groupUrl, groupName) {
    // ═══ SELF-HOSTED MODE: use fbScraper (FREE) ═══
    if (SCRAPE_MODE === 'self-hosted') {
        try {
            return await fbScraper.getGroupPosts(groupUrl, groupName);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ Self-hosted group scrape failed: ${err.message}`);
            return [];
        }
    }

    // ═══ SOCIAVAULT MODE: paid API (auto-failover to self-hosted when credits exhausted) ═══
    if (!canSpend()) {
        console.log(`[SV:FB] 🔄 Credits exhausted → auto-failover to self-hosted Playwright`);
        try {
            return await fbScraper.getGroupPosts(groupUrl, groupName);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ Failover group scrape failed: ${err.message}`);
            return [];
        }
    }

    try {
        const data = await svGet('facebook/group/posts', { url: groupUrl, sort_by: 'CHRONOLOGICAL', count: 20 });
        logCredit('facebook/group/posts', 'facebook', groupName);

        const postsArr = toArr(data.posts || data);
        return postsArr.map(item => ({
            url: item.url || item.post_url || '',
            content: (item.text || item.message || '').trim(),
            author_name: item.author?.name || item.author?.short_name || 'Unknown',
            created_at: item.publishTime ? new Date(item.publishTime * 1000).toISOString() : null,
            commentCount: item.commentCount || 0,
            topComments: toArr(item.topComments).map(c => ({
                text: (c.text || '').trim(),
                publishTime: c.publishTime ? new Date(c.publishTime * 1000).toISOString() : null,
                author_name: c.author?.name || 'Unknown',
                author_url: c.author?.url || '',
            })),
        })).filter(p => p.content.length > 15);
    } catch (apiErr) {
        // API error → auto-failover to self-hosted
        console.warn(`[SV:FB] ⚠️ SociaVault API error: ${apiErr.message} → failover to self-hosted`);
        try {
            return await fbScraper.getGroupPosts(groupUrl, groupName);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ Failover group scrape also failed: ${err.message}`);
            return [];
        }
    }
}

async function scrapeFacebookGroups(maxPosts = 500) {
    // ─── Load groups from DB (GroupDiscovery Agent) ───
    // Falls back to config if DB empty
    let allGroups;
    try {
        const groupDiscovery = require('../agent/groupDiscovery');
        allGroups = groupDiscovery.getScanRotationList(999); // ALL groups — max volume
        if (!allGroups.length) throw new Error('DB empty');
    } catch (e) {
        allGroups = config.FB_TARGET_GROUPS || [];
        console.log('[SV:FB] ⚠️ GroupDB unavailable, using config fallback');
    }
    if (!allGroups.length) return [];

    // Rotation: lấy batch tiếp theo từ DB list
    const groups = rotation.getNextBatch('fb_groups', allGroups, FB_GROUPS_PER_SCAN);
    console.log(`[SV:FB] 📘 ${groups.length}/${allGroups.length} groups this scan (DB-driven rotation)...`);

    const all = [];
    let svGroupCount = 0, pwGroupCount = 0;

    for (const group of groups) {
        try {
            // Track which engine will be used (before calling)
            const willUseSV = SCRAPE_MODE !== 'self-hosted' && canSpend();
            const engineTag = willUseSV ? '🔵 SV' : '🟢 PW';
            console.log(`[SV:FB] 📌 [${engineTag}] ${group.name}`);

            const posts = await fbGetGroupPosts(group.url, group.name);
            console.log(`[SV:FB]   ${posts.length} posts (CHRONOLOGICAL)`);

            if (willUseSV) svGroupCount++; else pwGroupCount++;

            // Mark scanned in DB so rotation prioritizes unscanned groups
            try { require('../agent/groupDiscovery').markScanned(group.url); } catch (_) { }
            await delay(1500);

            let postKept = 0, postSkipped = 0, commentKept = 0, commentSkipped = 0;

            for (const post of posts) { // ALL posts — free mode = max yield
                // ═══ POST SCOUT — PersonaClassifier pre-filter ═══
                const sig = signalScores(post.content || '');
                const postIsCustomer = isRealCustomer(post.content || '');

                // Add post itself (ONLY if real customer OR provider-logistics for comment mining)
                if (post.content) {
                    if (postIsCustomer || sig.providerLogistics) {
                        all.push({
                            platform: 'facebook',
                            item_type: 'post',
                            post_url: post.url,
                            author_name: post.author_name,
                            author_url: '',
                            content: post.content,
                            post_created_at: post.created_at || new Date().toISOString(),
                            scraped_at: new Date().toISOString(),
                            source: `sv:fb:group:${group.name}`,
                            persona: sig.persona,
                        });
                        postKept++;
                    } else {
                        postSkipped++;
                    }
                }

                // ═══ COMMENT SCOUT — Filter topComments ═══
                for (const tc of (post.topComments || []).slice(0, 5)) {
                    if (tc.text && tc.text.length > 3) {
                        // Comment Scout: reject sale-type comments
                        if (isRealCustomerComment(tc.text)) {
                            all.push({
                                platform: 'facebook',
                                item_type: 'comment',
                                post_url: post.url,
                                author_name: tc.author_name,
                                author_url: tc.author_url,
                                content: tc.text,
                                post_created_at: tc.publishTime || new Date().toISOString(),
                                parent_created_at: post.created_at,
                                parent_excerpt: (post.content || '').slice(0, 300),
                                scraped_at: new Date().toISOString(),
                                source: `sv:fb:topComments:${group.name}`,
                                persona: 'buyer',
                            });
                            commentKept++;
                        } else {
                            commentSkipped++;
                        }
                    }
                }

                // PAID comments — different rules for buyer vs provider posts
                const shouldHydrate = sig.providerLogistics
                    // Provider logistics: only if very fresh (≤7d) + high engagement (≥5 comments)
                    ? (post.url && post.commentCount >= 5 && isFresh(post.created_at, 7))
                    // Buyer posts: lower threshold for FB-only (more aggressive hydration)
                    : (post.url && post.commentCount > 0 && sig.any >= 15 && isFresh(post.created_at, 14));

                if (shouldHydrate) {
                    try {
                        await delay(1500);
                        const comments = await fbGetPostComments(post.url, `sv:fb:comments:${group.name}`);
                        // Comment Scout: filter paid comments too
                        const filtered = comments.slice(0, 8).filter(c => isRealCustomerComment(c.content || ''));
                        all.push(...filtered.map(c => ({
                            ...c,
                            item_type: 'comment',
                            parent_excerpt: (post.content || '').slice(0, 300),
                            parent_created_at: post.created_at || null,
                            persona: 'buyer',
                        })));
                        commentKept += filtered.length;
                        commentSkipped += (comments.slice(0, 8).length - filtered.length);
                        const type = sig.providerLogistics ? 'provider-logistics' : 'buyer';
                        console.log(`[SV:FB]   ↳ ${filtered.length}/${comments.length} paid comments kept (${type}, signal=${sig.any})`);
                    } catch (e) {
                        console.warn(`[SV:FB]   ↳ comments err: ${e.message}`);
                    }
                } else if (post.url) {
                    const reasons = [];
                    if (post.commentCount === 0) reasons.push('0 comments');
                    if (!sig.providerLogistics && sig.any < 25) reasons.push('weak signal');
                    if (sig.providerLogistics && post.commentCount < 5) reasons.push(`low engagement(${post.commentCount})`);
                    if (!isFresh(post.created_at, sig.providerLogistics ? 7 : 14)) reasons.push('old');
                    console.log(`[SV:FB]   ↳ skip paid comments (${reasons.join(', ')})`);
                }
            }

            // Post Scout + Comment Scout stats for this group
            console.log(`[SV:FB]   📊 Persona: ${postKept} posts kept, ${postSkipped} provider-ads filtered | ${commentKept} comments kept, ${commentSkipped} sale-comments filtered`);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ ${group.name}: ${err.message}`);
        }
        await delay(2000);
    }

    // Competitor page comments
    const compComments = await scrapeFBCompetitorComments();
    all.push(...compComments);

    const result = all.filter(p => p.content?.length > 5)
        .map(p => deepScoutEnrich(p))
        .slice(0, maxPosts);

    // Deep Scout stats
    const frustrated = result.filter(p => p.sentiment === 'FRUSTRATED').length;
    const urgent = result.filter(p => p.sentiment === 'URGENT').length;
    const critical = result.filter(p => p.urgency === 'critical').length;
    console.log(`[SV:FB] 📊 Total: ${result.length} | 🔥 Frustrated: ${frustrated} | ⚡ Urgent: ${urgent} | 🚨 Critical: ${critical}`);
    console.log(`[SV:FB] 🔄 Engine: 🔵 SociaVault=${svGroupCount} groups | 🟢 Playwright=${pwGroupCount} groups`);
    return result;
}

async function scrapeFBCompetitorComments() {
    const allPages = config.FB_COMPETITOR_PAGES || [];
    if (!allPages.length) return [];

    // Rotation: 3 pages/scan thay vì tất cả
    const pages = rotation.getNextBatch('fb_competitors', allPages, FB_COMPETITORS_PER_SCAN);
    console.log(`[SV:FB] 🏢 ${pages.length}/${allPages.length} competitor pages this scan (rotation)...`);

    const all = [];
    for (const page of pages) {
        try {
            if (!canSpend()) break;
            const data = await svGet('facebook/profile/posts', { url: page.url });
            logCredit('facebook/profile/posts', 'facebook', page.name);
            await delay(1500);

            const posts = toArr(data.posts || data).slice(0, 2);
            for (const post of posts) {
                const postUrl = post.url || post.post_url;
                if (!postUrl) continue;
                try {
                    await delay(1500);
                    const postContent = post.text || post.message || '';
                    const comments = await fbGetPostComments(postUrl, `sv:fb:competitor:${page.name}`);
                    // Only keep comments that match trigger signals
                    const filtered = comments.filter(c => signalScores(c.content).any >= 10);
                    all.push(...filtered.slice(0, 8).map(c => ({
                        ...c,
                        item_type: 'comment',
                        parent_excerpt: postContent.slice(0, 300) || `[${page.name} post]`,
                    })));
                    console.log(`[SV:FB]   🏢 ${page.name}: ${comments.length} comments, ${filtered.length} w/ signal`);
                } catch (e) {
                    console.warn(`[SV:FB]   🏢 ${page.name} err: ${e.message}`);
                }
            }
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ ${page.name}: ${err.message}`);
        }
        await delay(2000);
    }
    return all;
}

// ════════════════════════════════════════════════════════
// TIKTOK
// ════════════════════════════════════════════════════════

async function ttGetVideoComments(videoUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('tiktok/comments', { url: videoUrl });
    logCredit('tiktok/comments', 'tiktok', source);

    const comments = toArr(data.comments);
    if (comments.length === 0) return [];

    return comments.map(item => ({
        platform: 'tiktok',
        post_url: videoUrl,
        author_name: item.user?.unique_id || item.user?.nickname || item.author || 'Unknown',
        author_url: item.user?.unique_id ? `https://www.tiktok.com/@${item.user.unique_id}` : '',
        content: (item.text || item.comment || '').trim(),
        post_created_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : new Date().toISOString(),
        scraped_at: new Date().toISOString(),
        source,
    })).filter(p => p.content.length > 3);
}

// Helper: safe nested property access
function pick(obj, paths) {
    for (const p of paths) {
        const v = p.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
        if (v !== undefined && v !== null) return v;
    }
    return null;
}

function buildTiktokWebUrl(uniqueId, awemeId) {
    if (!uniqueId || !awemeId) return '';
    return `https://www.tiktok.com/@${uniqueId}/video/${awemeId}`;
}

async function ttSearchKeyword(query) {
    if (!canSpend()) return [];
    const data = await svGet('tiktok/search/keyword', {
        query,
        date_posted: 'this-week',
        sort_by: 'date-posted',
        trim: true,
    });
    logCredit('tiktok/search/keyword', 'tiktok', query);

    // SociaVault keyword search uses search_item_list[].aweme_info
    const rawList =
        data?.search_item_list ||
        data?.data?.search_item_list ||
        data?.videos || data?.items || data?.aweme_list ||
        null;

    const items = toArr(rawList).filter(Boolean);

    const videos = [];
    for (const it of items) {
        // search_item_list wraps in aweme_info; direct items don't
        const aweme = it?.aweme_info || it?.awemeInfo || it;

        const awemeId = pick(aweme, ['aweme_id', 'awemeId', 'id']);
        const desc = pick(aweme, ['desc', 'description', 'caption']) || '';
        const createTime = pick(aweme, ['create_time', 'createTime']);
        const authorUnique = pick(aweme, ['author.unique_id', 'author.uniqueId', 'author.username']);
        const authorNick = pick(aweme, ['author.nickname', 'author.nickName']) || authorUnique || 'Unknown';

        // Build URL: prefer share_url, fallback to constructed URL
        const url = pick(aweme, ['share_url', 'url']) || buildTiktokWebUrl(authorUnique, awemeId);
        if (!url) continue;

        videos.push({
            url,
            content: String(desc).trim(),
            author_name: authorNick,
            author_url: authorUnique ? `https://www.tiktok.com/@${authorUnique}` : '',
            created_at: createTime ? new Date(createTime * 1000).toISOString() : null,
        });
    }

    console.log(`[SV:TT]   parsed ${videos.length}/${items.length} videos from response`);
    return videos;
}

async function scrapeTikTok(maxPosts = 30) {
    const allQueries = config.TT_SEARCH_QUERIES || [];
    if (!allQueries.length) {
        console.log('[SV:TT] ⚠️ No TT_SEARCH_QUERIES configured');
        return [];
    }

    // Rotation: 4 queries/scan
    const queries = rotation.getNextBatch('tt_queries', allQueries, TT_HASHTAGS_PER_SCAN);
    console.log(`[SV:TT] 🔎 ${queries.length}/${allQueries.length} queries this scan (rotation)...`);

    const all = [];

    for (const q of queries) {
        try {
            console.log(`[SV:TT] q="${q}"`);
            const videos = await ttSearchKeyword(q);
            console.log(`[SV:TT]   ${videos.length} videos`);
            await delay(1500);

            // Filter: skip noise AND provider ads (Chinese forwarder ads dominate TikTok)
            const relevant = videos.filter(v => {
                if (!v.content || v.content.length < 20) return false; // too short / emoji
                const s = (v.content || '').toLowerCase();
                // Skip provider/forwarder ads (they have noise comments)
                if (isProviderText(s)) return false;
                // Skip obvious Chinese forwarder ads in English
                if (/shipping agent|freight forwarder|we ship|we offer|contact us|whatsapp/i.test(v.content)) return false;
                const sig = signalScores(v.content);
                return sig.any > 0 || sig.buyer;
            });
            console.log(`[SV:TT]   ${relevant.length}/${videos.length} relevant (non-provider) after filter`);

            for (const video of relevant.slice(0, 5)) {
                all.push({
                    platform: 'tiktok',
                    item_type: 'post',
                    post_url: video.url,
                    author_name: video.author_name,
                    author_url: video.author_url,
                    content: video.content,
                    post_created_at: video.created_at || new Date().toISOString(),
                    scraped_at: new Date().toISOString(),
                    source: `sv:tt:kw:${q}`,
                });

                // Hydrate comments — only for buyer-signal videos (provider video comments = noise)
                const sig = signalScores(video.content || '');
                if (video.url && sig.buyer && sig.any >= 20 && isFresh(video.created_at, 10)) {
                    try {
                        await delay(1500);
                        const comments = await ttGetVideoComments(video.url, `sv:tt:comments:${q}`);
                        if (comments.length > 0) {
                            all.push(...comments.slice(0, 8).map(c => ({
                                ...c,
                                item_type: 'comment',
                                parent_excerpt: (video.content || '').slice(0, 300),
                                parent_created_at: video.created_at || null,
                            })));
                            console.log(`[SV:TT]   ↳ ${comments.length} comments (signal=${sig.any}, buyer=${sig.buyer})`);
                        }
                    } catch (e) {
                        console.warn(`[SV:TT]   ↳ comments err: ${e.message}`);
                    }
                } else if (video.url) {
                    console.log(`[SV:TT]   ↳ skip comments (${!sig.buyer ? 'not buyer' : sig.any < 20 ? 'weak signal' : 'old video'})`);
                }
                await delay(1000);
            }
        } catch (err) {
            console.warn(`[SV:TT] ⚠️ q="${q}": ${err.message}`);
        }
        await delay(2000);
    }

    const result = all.filter(p => p.content?.length > 3).slice(0, maxPosts);
    console.log(`[SV:TT] 📊 Total: ${result.length}`);
    return result;
}

// ════════════════════════════════════════════════════════
// INSTAGRAM
// ════════════════════════════════════════════════════════

async function igGetPostComments(postUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('instagram/comments', { url: postUrl });
    logCredit('instagram/comments', 'instagram', source);

    return toArr(data.comments).map(item => ({
        platform: 'instagram',
        post_url: postUrl,
        author_name: item.user?.username || 'Unknown',
        author_url: item.user?.username ? `https://www.instagram.com/${item.user.username}/` : '',
        content: (item.text || '').trim(),
        post_created_at: item.created_at || new Date().toISOString(),
        scraped_at: new Date().toISOString(),
        source,
    })).filter(p => p.content.length > 5);
}

async function igGetAccountPosts(handle) {
    if (!canSpend()) return [];
    const data = await svGet('instagram/posts', { handle });
    logCredit('instagram/posts', 'instagram', handle);

    const postsRaw = toArr(data.posts || data.items || data.edges || data);
    return postsRaw.map(item => {
        const node = item.node || item;
        const rawCap = node.caption;
        const content = (typeof rawCap === 'string' ? rawCap : rawCap?.text)
            || node.text || node.description || '';
        return {
            url: (node.code || node.shortcode)
                ? `https://www.instagram.com/p/${node.code || node.shortcode}/`
                : (node.url || ''),
            content: String(content).trim(),
        };
    }).filter(p => p.url);
}

async function scrapeInstagram(maxPosts = 30) {
    const allAccounts = config.IG_TARGET_ACCOUNTS || [];
    if (!allAccounts.length) {
        console.log('[SV:IG] ⚠️ No IG_TARGET_ACCOUNTS configured');
        return [];
    }

    // Rotation: 3 accounts/scan, xoay vòng
    const accounts = rotation.getNextBatch('ig_accounts', allAccounts, IG_ACCOUNTS_PER_SCAN);
    console.log(`[SV:IG] 📷 ${accounts.length}/${allAccounts.length} accounts this scan (rotation)...`);

    const all = [];

    for (const handle of accounts) {
        try {
            console.log(`[SV:IG] @${handle}`);
            const posts = await igGetAccountPosts(handle);
            console.log(`[SV:IG]   ${posts.length} posts`);
            await delay(1500);

            for (const post of posts.slice(0, 3)) {
                if (!post.url) continue;
                const sig = signalScores(post.content || '');
                if (sig.any < 20 || !isFresh(post.created_at, 10)) {
                    console.log(`[SV:IG]   ↳ skip comments (${sig.any < 20 ? 'weak signal' : 'old post'})`);
                    continue;
                }
                try {
                    await delay(1500);
                    const comments = await igGetPostComments(post.url, `sv:ig:comments:@${handle}`);
                    all.push(...comments.slice(0, 8).map(c => ({
                        ...c,
                        item_type: 'comment',
                        parent_excerpt: post.content?.slice(0, 300) || '',
                        parent_created_at: post.created_at || null,
                    })));
                    console.log(`[SV:IG]   ↳ @${handle}: ${comments.length} comments (signal=${sig.any})`);
                } catch (e) {
                    console.warn(`[SV:IG]   ↳ @${handle} err: ${e.message}`);
                }
            }
        } catch (err) {
            console.warn(`[SV:IG] ⚠️ @${handle}: ${err.message}`);
        }
        await delay(2000);
    }

    const result = all.filter(p => p.content?.length > 5).slice(0, maxPosts);
    console.log(`[SV:IG] 📊 Total: ${result.length}`);
    return result;
}

async function testConnection() {
    if (!SV_KEY) return { ok: false, error: 'No SOCIAVAULT_API_KEY' };
    try {
        const resp = await axios.get(`${SV_API}/tiktok/profile`, {
            headers: headers(), params: { handle: 'tiktok' }, timeout: 15000,
        });
        return { ok: resp.data?.success === true };
    } catch (err) {
        return { ok: false, error: err.response?.data?.error || err.message };
    }
}

module.exports = {
    scrapeFacebookGroups,
    scrapeInstagram,
    scrapeTikTok,
    isProviderText,
    isBuyerText,
    isRealCustomer,
    isRealCustomerComment,
    signalScores,
    analyzeSentiment,
    parseServiceType,
    deepScoutEnrich,
    testConnection,
    svGet,
    getCreditsUsed: () => database.getCreditStats().today,
    getBudgetInfo,
    getCreditLog: database.getCreditLog,
    getCreditStats: database.getCreditStats,
};
