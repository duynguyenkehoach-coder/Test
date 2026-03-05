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
  ENABLED_PLATFORMS: ['facebook', 'tiktok', 'instagram'],
  CRON_KEYWORD_SCAN: '*/30 * * * *',   // TikTok + IG
  CRON_GROUP_SCAN: '0 8,20 * * *',     // FB Groups: 8h sáng + 8h tối

  // 6000 credits / 30 ngày = 200 credits/ngày
  SV_DAILY_LIMIT: parseInt(process.env.SV_DAILY_LIMIT || '200'),

  // ════════════════════════════════════════════════════
  // FACEBOOK GROUPS — 10 groups
  // ~4 credits/group × 10 × 2 lần/ngày = ~80 credits/ngày
  // ════════════════════════════════════════════════════
  FB_TARGET_GROUPS: [
    { name: 'Cộng đồng Etsy VN', url: 'https://www.facebook.com/groups/congdongetsyvietnam' },
    { name: 'TikTok Shop US Underground', url: 'https://www.facebook.com/groups/1631859190422638' },
    { name: 'Tìm Supplier Fulfill POD/Drop', url: 'https://www.facebook.com/groups/timsupplierfulfillpoddropvnusuk' },
    { name: 'Dropship & Fulfill VN', url: 'https://www.facebook.com/groups/646444174604027' },
    { name: 'Seller E-commerce VN', url: 'https://www.facebook.com/groups/494286704652111' },
    { name: 'E-commerce Sellers VN', url: 'https://www.facebook.com/groups/437505323460908' },
    { name: 'Cộng đồng Amazon VN', url: 'https://www.facebook.com/groups/congdongamazonvn' },
    { name: 'Vận chuyển Quốc tế VN', url: 'https://www.facebook.com/groups/914341367037223' },
    { name: 'POD & Print on Demand VN', url: 'https://www.facebook.com/groups/podvietnam' },
    { name: 'Dropship Vietnam', url: 'https://www.facebook.com/groups/dropshipvietnam' },
  ],

  // ════════════════════════════════════════════════════
  // FACEBOOK COMPETITOR PAGES — 6 pages
  // ~5 credits/page × 6 × 2 lần/ngày = ~60 credits/ngày
  // ════════════════════════════════════════════════════
  FB_COMPETITOR_PAGES: [
    { name: 'Boxme Global', url: 'https://www.facebook.com/boxme.asia' },
    { name: 'SuperShip', url: 'https://www.facebook.com/supership.vn' },
    { name: 'Weshop VN', url: 'https://www.facebook.com/weshopvn' },
    { name: 'Merchize', url: 'https://www.facebook.com/merchize' },
    { name: 'Bestexpress VN', url: 'https://www.facebook.com/bestexpressvn' },
    { name: 'Ninja Van Vietnam', url: 'https://www.facebook.com/ninjavan.vn' },
  ],

  // ════════════════════════════════════════════════════
  // TIKTOK — 10 hashtags (scraper xoay vòng 4/scan)
  // ~4 credits × 4 hashtag × vài scan/ngày = ~16-20 credits/ngày
  // ════════════════════════════════════════════════════
  TT_SEARCH_HASHTAGS: [
    'podvietnam',
    'dropshipvietnam',
    'fulfillvietnam',
    'shiphangmy',
    'tiktokshopus',
    'ddptous',
    'forwarder',
    'fbaprep',
    'warehouseus',
    'shiphangtrungquoc',
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
