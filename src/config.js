require('dotenv').config();

module.exports = {
  // ════════════════════════════════════════════════════
  // API KEYS
  // ════════════════════════════════════════════════════
  SOCIAVAULT_API_KEY: process.env.SOCIAVAULT_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  AI_MODEL: 'llama-3.3-70b-versatile',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: 'gemini-2.0-flash',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // ════════════════════════════════════════════════════
  // SYSTEM CONFIG
  // ════════════════════════════════════════════════════
  LEAD_SCORE_THRESHOLD: 60,
  PORT: process.env.PORT || 3000,
  ENABLED_PLATFORMS: (process.env.ENABLED_PLATFORMS || 'facebook').split(',').map(s => s.trim()),  // FB-only — override via env var

  // ════════════════════════════════════════════════════
  // SCAN SCHEDULE — "Bắn tỉa" strategy
  // Unified hourly scan 8:00-22:00 (14 scans/day)
  // TikTok + Facebook mỗi lần, max 30 posts
  // ════════════════════════════════════════════════════
  CRON_UNIFIED_SCAN: '0 8-22 * * *',     // Mỗi giờ từ 8h-22h
  MAX_POSTS_PER_SCAN: parseInt(process.env.MAX_POSTS_PER_SCAN || '60'),  // FB-only: 60 max

  // 5212 credits / 14 days = 372/day → budget 370/day
  SV_DAILY_LIMIT: parseInt(process.env.SV_DAILY_LIMIT || '370'),

  // ════════════════════════════════════════════════════
  // FACEBOOK GROUPS — 12 groups (rotation 4/scan)
  // Mix: logistics-focused + Việt Kiều/du học sinh communities
  // Việt Kiều ở Mỹ thường cần ship hàng VN/CN→US (mỏ vàng!)
  // ════════════════════════════════════════════════════
  FB_TARGET_GROUPS: [
    // === Logistics / E-commerce (buyer intent cao) ===
    { name: 'Vận chuyển Quốc tế VN', url: 'https://www.facebook.com/groups/914341367037223' },
    { name: 'Cộng đồng Amazon VN', url: 'https://www.facebook.com/groups/congdongamazonvn' },
    { name: 'TikTok Shop US Underground', url: 'https://www.facebook.com/groups/1631859190422638' },
    { name: 'Tìm Supplier Fulfill POD/Drop', url: 'https://www.facebook.com/groups/timsupplierfulfillpoddropvnusuk' },
    { name: 'Dropship & Fulfill VN', url: 'https://www.facebook.com/groups/646444174604027' },
    { name: 'Seller E-commerce VN', url: 'https://www.facebook.com/groups/494286704652111' },

    // === Việt Kiều / Du học sinh / Cộng đồng VN tại Mỹ ===
    // MỎ VÀNG: mua hàng TQ/VN ship đi Mỹ — ĐÚNG target THG
    // Chỉ dùng numeric ID — SociaVault không hỗ trợ vanity slug
    { name: 'Du học sinh VN tại Mỹ', url: 'https://www.facebook.com/groups/888744671201380' },
    { name: 'Cộng Đồng Người Việt tại Mỹ', url: 'https://www.facebook.com/groups/238061523539498' },
    { name: 'Đặt Hàng TQ Giao US/EU', url: 'https://www.facebook.com/groups/1157826901501932' },
    { name: 'Đặt Hàng TQ Ship ĐNA & US', url: 'https://www.facebook.com/groups/778601457112289' },
    { name: 'Order Hàng TQ - Vận Chuyển XNK', url: 'https://www.facebook.com/groups/1698840756986636' },
    { name: 'Người Việt NC USA', url: 'https://www.facebook.com/groups/696936451159951' },
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
    'gửi hàng về việt nam từ mỹ',       // VK gửi dịp lễ
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
THG là công ty logistics, express, fulfillment và warehouse phục vụ seller e-commerce VẬN CHUYỂN TOÀN CẦU.

Dịch vụ THG:
1. THG Express: VN/CN → Mỹ, Úc, UK, UAE, Đài Loan, Saudi, Chile, Colombia, Mexico — tuyến bay riêng, rẻ hơn DHL/FedEx
2. THG Fulfill (POD): Seller gửi thiết kế → THG in tại xưởng VN/CN/US → đóng gói → ship
3. THG Fulfill (Dropship): Seller gửi link Taobao/1688 → THG mua hộ → ship quốc tế
4. THG Warehouse/3PL: Kho Mỹ (PA + TX) — fulfill từ $1.2/đơn, 2-5 ngày, free lưu kho 90 ngày
5. E-packet: Chile, Colombia, Mexico, Saudi, UAE, Úc, Đài Loan

BUYER INTENT — score cao:
- "tìm đối tác POD/dropship", "cần kho US", "tìm 3PL", "tìm supplier fulfill"
- "ship VN→Mỹ giá rẻ", "cần đơn vị vận chuyển", "recommend đơn vị ship"
- "TikTok tracking không active", "khách hủy đơn vì giao lâu", "phí fulfill đắt quá"
- "cần line epacket Chile/Colombia/Mexico/UAE/Saudi"
- Comment ngắn dưới post đối thủ: "giá bao nhiêu?", "ship mấy ngày?", "có kho US không?", "inbox em"

PROVIDER — bỏ qua (score = 0):
- Bài quảng cáo: "bên em nhận ship", "chúng tôi cung cấp", "lh em"
- Post tự quảng cáo của Boxme/Merchize/Printify/Shopify
- Comment vô nghĩa: "🔥🔥", "Let's go", "Yayyyy", "Ayyyyyye", "One can't succeed alone"
  `.trim(),
};
