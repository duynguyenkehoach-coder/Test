require('dotenv').config();

module.exports = {
  // ════════════════════════════════════════════════════
  // API KEYS & AI PROVIDERS
  // ════════════════════════════════════════════════════
  // Ollama (self-hosted, PRIMARY — no rate limit)
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
  // Cloud fallbacks
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY,
  // Legacy (kept for reference, NOT used in cascade)
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // ════════════════════════════════════════════════════
  // SYSTEM CONFIG
  // ════════════════════════════════════════════════════
  LEAD_SCORE_THRESHOLD: 60,
  PORT: process.env.PORT || 3000,
  ENABLED_PLATFORMS: (process.env.ENABLED_PLATFORMS || 'facebook').split(',').map(s => s.trim()),  // FB-only — override via env var

  // ════════════════════════════════════════════════════
  // SCRAPE MODE — 'self-hosted' (FREE mbasic scraper) or 'sociavault' (paid API)
  // ════════════════════════════════════════════════════
  SCRAPE_MODE: process.env.SCRAPE_MODE || 'self-hosted',
  FB_COOKIES: process.env.FB_COOKIES || '',  // Facebook session cookies for self-hosted mode

  // ════════════════════════════════════════════════════
  // SCAN SCHEDULE — AGGRESSIVE FB-ONLY (200 leads by Mar 10)
  // Scan every 30 min 8:00-22:00 (28 scans/day)
  // All credits → Facebook only
  // ════════════════════════════════════════════════════
  CRON_UNIFIED_SCAN: '0,30 0-13,23 * * *',  // 23h-13h VN (7am-8pm ET) — giờ seller Việt Kiều Mỹ active
  MAX_POSTS_PER_SCAN: parseInt(process.env.MAX_POSTS_PER_SCAN || '200'),  // AGGRESSIVE: 200 max

  // Campaign: 200 leads by Mar 10 → 28 scans × ~40 credits = ~1120/day
  SV_DAILY_LIMIT: parseInt(process.env.SV_DAILY_LIMIT || '1200'),

  // ════════════════════════════════════════════════════
  // FACEBOOK GROUPS — 12 groups (rotation 4/scan)
  // Mix: logistics-focused + Việt Kiều/du học sinh communities
  // Việt Kiều ở Mỹ thường cần ship hàng VN/CN→US (mỏ vàng!)
  // ════════════════════════════════════════════════════
  FB_TARGET_GROUPS: [
    // === TIER 1: Đặt hàng TQ/VN ship US — BUYER INTENT CAO NHẤT ===
    { name: 'Đặt Hàng TQ Giao US/EU', url: 'https://www.facebook.com/groups/1157826901501932' },
    { name: 'Đặt Hàng TQ Ship ĐNA & US', url: 'https://www.facebook.com/groups/778601457112289' },
    { name: 'Order Hàng TQ - Vận Chuyển XNK', url: 'https://www.facebook.com/groups/1698840756986636' },
    { name: 'Tìm Supplier Fulfill POD/Drop', url: 'https://www.facebook.com/groups/1312868109620530' },
    { name: 'Dropship & Fulfill VN', url: 'https://www.facebook.com/groups/646444174604027' },

    // === TIER 2: Việt Kiều / Du học sinh tại Mỹ — MỎ VÀNG ===
    { name: 'Du học sinh VN tại Mỹ', url: 'https://www.facebook.com/groups/888744671201380' },
    { name: 'Cộng Đồng Người Việt tại Mỹ', url: 'https://www.facebook.com/groups/238061523539498' },
    { name: 'Người Việt NC USA', url: 'https://www.facebook.com/groups/696936451159951' },
    { name: 'Người Việt tại California', url: 'https://www.facebook.com/groups/746114972440757' },
    { name: 'Việt Kiều Khắp Nơi', url: 'https://www.facebook.com/groups/329985287029' },
    { name: 'Người Việt tại Texas', url: 'https://www.facebook.com/groups/1462647001235516' },
    { name: 'Vietnamese in America', url: 'https://www.facebook.com/groups/912111470098935' },

    // === TIER 3: E-commerce VN seller → US market ===
    { name: 'Cộng đồng Amazon VN', url: 'https://www.facebook.com/groups/congdongamazonvn' },
    { name: 'TikTok Shop US Underground', url: 'https://www.facebook.com/groups/1631859190422638' },
    { name: 'Seller E-commerce VN', url: 'https://www.facebook.com/groups/494286704652111' },
    { name: 'Vận chuyển Quốc tế VN', url: 'https://www.facebook.com/groups/914341367037223' },

    // === TIER 4: POD / Fulfillment searchers ===
    { name: 'POD Vietnam Sellers', url: 'https://www.facebook.com/groups/112253537621629' },
    { name: 'Amazon FBA Vietnam', url: 'https://www.facebook.com/groups/430998570008556' },
    { name: 'Shopify & Dropship VN', url: 'https://www.facebook.com/groups/514921692619278' },
  ],

  // ════════════════════════════════════════════════════
  // FACEBOOK COMPETITOR PAGES — disabled to save credits
  // Comments under competitor pages are 99% provider, not buyer
  // ════════════════════════════════════════════════════
  FB_COMPETITOR_PAGES: [],  // Disabled — waste credits

  // ════════════════════════════════════════════════════
  // TIKTOK KEYWORD QUERIES — 20 queries total, rotate 4/scan
  // Focus: Việt Kiều + seller VN/CN → US (mỏ vàng)
  // ════════════════════════════════════════════════════
  TT_SEARCH_QUERIES: [
    // === Việt Kiều + cộng đồng VN tại Mỹ (mỏ vàng mới) ===
    'mua hàng việt nam ship đi mỹ',      // VK muốn gửi hàng VN
    'hàng trung quốc ship đi mỹ',         // seller mua CN ship US
    'gửi hàng từ việt nam đi mỹ',         // VN→US (đúng tuyến THG)
    'người việt ở mỹ mua hàng',           // cộng đồng tìm hàng
    'dịch vụ ship hàng việt kiều',         // query trực tiếp VK
    // === Seller VN tìm dịch vụ (buyer intent cao) ===
    'cần ship hàng đi mỹ', 'tìm forwarder ship mỹ',
    'cần kho ở mỹ', 'tìm kho fulfillment',
    'cần xưởng in pod', 'ship hàng amazon fba',
    'xin giá ship hàng đi mỹ', 'ai có line us',
    // === Hashtag search (Việt Kiều community) ===
    '#nguoivietomy ship',                  // hashtag cộng đồng
    '#vietchieu mua hàng',
    '#cuocsongmy hàng việt',
    // === Specific logistics needs ===
    'source product china ship usa',       // EN: seller CN → US
    'cần forwarder trung quốc đi mỹ',     // import từ TQ
    'tìm kho fulfillment tiktok shop',    // TTS seller
    'need 3pl warehouse vietnam',          // EN buyer tìm VN logistics
  ],

  // ════════════════════════════════════════════════════
  // INSTAGRAM — 6 accounts (scraper dùng 4/scan)
  // ~4 credits × 4 account × 3 scan/ngày = ~48 credits/ngày
  // ════════════════════════════════════════════════════
  IG_TARGET_ACCOUNTS: [
    'boxme.global',    // đối thủ fulfillment SEA
    'merchize_pod',    // đối thủ POD
    'bestexpressvn',   // đối thủ logistics VN
    'printify',        // POD lớn — buyer hay than về giá/support
    'shiphype',        // fulfillment — buyer so sánh
    'zendrop',         // dropship — buyer tìm supplier VN
  ],

  // ════════════════════════════════════════════════════
  // TỔNG KẾT CREDIT/NGÀY
  //   FB Groups:      ~80 cr
  //   FB Competitors: ~60 cr
  //   TikTok:         ~20 cr
  //   Instagram:      ~24 cr
  //   TỔNG:          ~184 cr ✅ (< 200 cr/ngày budget)
  // ════════════════════════════════════════════════════

  THG_CONTEXT: `
THG là công ty logistics thương mại điện tử, chuyên phục vụ SELLER (POD, Dropship, Fulfillment, Amazon FBA).
Khách hàng mục tiêu: SELLER đang bán trên Amazon, TikTok Shop, Etsy, Shopify, eBay cần:
- In ấn sản phẩm (POD/Print on Demand)
- Tìm nguồn hàng từ Trung Quốc (1688, Taobao, xưởng TQ) để ship đi phương Tây
- Fulfillment/3PL tại Mỹ hoặc châu Âu
- Vận chuyển quốc tế VN/CN → Mỹ, Anh, Pháp, Đức

📍 TUYẾN PHỤC VỤ:
- TUYẾN CHÍNH: VN/CN → MỸ (US)
- TUYẾN PHỤ: VN/CN → Anh (UK), Pháp (France), Đức (Germany)
- TUYẾN MỞ RỘNG: Úc, UAE, Đài Loan, Chile, Colombia, Mexico

⛔ THG KHÔNG phục vụ: ship hàng VỀ Việt Nam, nhập hàng TQ→VN, vận chuyển nội địa VN.

🎯 DỊCH VỤ THG:
1. THG Fulfill (POD): Seller gửi thiết kế → THG in tại xưởng VN/CN/US → ship đi Mỹ/UK/EU
2. THG Fulfill (Dropship): Seller gửi link 1688/Taobao → THG mua hộ + ship QUỐC TẾ
3. THG Express: Vận chuyển VN/CN → Mỹ/UK/EU — tuyến bay riêng, rẻ hơn DHL/FedEx
4. THG Warehouse/3PL: Kho Mỹ (PA + TX) — fulfill $1.2/đơn, giao 2-5 ngày, free lưu kho 90 ngày
5. E-packet: Chile, Colombia, Mexico, Saudi, UAE, Úc, Đài Loan

🔥 LEAD CHUẨN (score cao) — ĐÚNG đối tượng THG phục vụ:
- Seller POD/Print on Demand đang tìm xưởng in, basecost rẻ, supplier fulfill
- Seller Dropship tìm nguồn hàng TQ (1688/Taobao) để ship đi Mỹ/EU
- Seller Amazon FBA cần kho US, FBA prep, 3PL
- Seller e-commerce cần ship hàng VN/CN → Mỹ/UK/FR/DE
- Seller đang phàn nàn dịch vụ hiện tại (giao chậm, mất hàng, phí đắt)
- Comment ngắn dưới post logistics: "xin giá", "inbox", "rate?", "có kho US không?"
- "tìm đối tác POD", "cần fulfillment center US", "ai biết ship VN→Mỹ"
- "tìm kho UK", "fulfillment châu Âu", "ship hàng đi Đức/Pháp/Anh"

❌ KHÔNG PHẢI LEAD (score = 0):
- Bài quảng cáo dịch vụ: "bên em nhận ship", "chúng tôi cung cấp", "lh em"
- Post chia sẻ kiến thức, hướng dẫn, khoe doanh số
- Bài tuyển dụng, tìm việc
- Bài nhập hàng TQ về VN (sai tuyến)
- Bài vận chuyển nội địa VN (sai tuyến)
- Bài gửi hàng từ Mỹ về VN (sai tuyến)
  `.trim(),
};
