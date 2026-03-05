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
  ENABLED_PLATFORMS: ['facebook', 'tiktok'],

  // ════════════════════════════════════════════════════
  // SCAN SCHEDULE — "Bắn tỉa" strategy
  // Unified hourly scan 8:00-22:00 (14 scans/day)
  // TikTok + Facebook mỗi lần, max 30 posts
  // ════════════════════════════════════════════════════
  CRON_UNIFIED_SCAN: '0 8-22 * * *',     // Mỗi giờ từ 8h-22h
  MAX_POSTS_PER_SCAN: 30,

  // 5212 credits / 14 days = 372/day → budget 370/day
  SV_DAILY_LIMIT: parseInt(process.env.SV_DAILY_LIMIT || '370'),

  // ════════════════════════════════════════════════════
  // FACEBOOK GROUPS — logistics-focused (buyer intent)
  // ~4 credits/group × 4/scan × 2 lần/ngày = ~32 credits/ngày
  // ════════════════════════════════════════════════════
  FB_TARGET_GROUPS: [
    // Logistics / shipping / forwarder groups (high buyer intent)
    { name: 'Vận chuyển Quốc tế VN', url: 'https://www.facebook.com/groups/914341367037223' },
    { name: 'Cộng đồng Amazon VN', url: 'https://www.facebook.com/groups/congdongamazonvn' },
    { name: 'TikTok Shop US Underground', url: 'https://www.facebook.com/groups/1631859190422638' },
    { name: 'Tìm Supplier Fulfill POD/Drop', url: 'https://www.facebook.com/groups/timsupplierfulfillpoddropvnusuk' },
    // Fulfillment / 3PL / warehouse
    { name: 'Dropship & Fulfill VN', url: 'https://www.facebook.com/groups/646444174604027' },
    { name: 'Seller E-commerce VN', url: 'https://www.facebook.com/groups/494286704652111' },
  ],

  // ════════════════════════════════════════════════════
  // FACEBOOK COMPETITOR PAGES — disabled to save credits
  // Comments under competitor pages are 99% provider, not buyer
  // ════════════════════════════════════════════════════
  FB_COMPETITOR_PAGES: [],  // Disabled — waste credits

  // ════════════════════════════════════════════════════
  // TIKTOK — keyword queries (date_posted=this-week)
  // ~1 credit/query × 4 queries/scan = ~4 credits/scan
  // ════════════════════════════════════════════════════
  TT_SEARCH_QUERIES: [
    // Vietnamese buyer queries (sellers tìm dịch vụ)
    'cần ship hàng đi mỹ', 'tìm forwarder ship mỹ', 'ai có line us',
    'xin giá ship hàng đi mỹ', 'cần kho ở mỹ', 'tìm kho fulfillment',
    'cần xưởng in pod', 'ship hàng amazon fba', 'gửi hàng từ việt nam đi mỹ',
    // English buyer queries (more specific than generic logistics)
    'need fulfillment center us', 'looking for 3pl warehouse',
    'tiktok shop seller need fulfillment', 'amazon fba prep service review',
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
