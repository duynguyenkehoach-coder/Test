require('dotenv').config();

module.exports = {
  // --- SociaVault (all scraping — FB, IG, TT) ---
  SOCIAVAULT_API_KEY: process.env.SOCIAVAULT_API_KEY,

  // --- AI (Groq — scan & classify) ---
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  AI_MODEL: 'llama-3.3-70b-versatile',

  // --- AI (Gemini — auto-sale responses) ---
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: 'gemini-2.0-flash',

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // --- Lead scoring ---
  LEAD_SCORE_THRESHOLD: 60,

  // --- Cron schedule ---
  CRON_KEYWORD_SCAN: '*/30 * * * *',  // TikTok + IG: mỗi 30 phút
  CRON_GROUP_SCAN: '0 8,20 * * *',     // FB Groups: 2 lần/ngày (8h sáng, 8h tối)

  // --- Server ---
  PORT: process.env.PORT || 3000,

  // --- Apify Actor IDs ---
  APIFY_ACTORS: {
    FB_GROUP: 'apify/facebook-groups-scraper',
    FB_PAGE_COMMENTS: 'apify/facebook-comments-scraper',
    IG_HASHTAG: 'apify/instagram-hashtag-scraper',
    TIKTOK_SEARCH: 'clockworks/tiktok-scraper',
  },

  // --- Platforms to enable ---
  ENABLED_PLATFORMS: ['facebook', 'tiktok', 'instagram'],

  // --- Facebook Groups to scrape (TOP 5 seller communities) ---
  FB_TARGET_GROUPS: [
    { name: 'THG Fulfill US', url: 'https://www.facebook.com/groups/thgfulfillus' },
    { name: 'Cộng đồng Etsy VN', url: 'https://www.facebook.com/groups/congdongetsyvietnam' },
    { name: 'TikTok Shop US Underground', url: 'https://www.facebook.com/groups/tiktokshopusunderground' },
    { name: 'Tìm Supplier Fulfill POD/Drop', url: 'https://www.facebook.com/groups/timsupplierfulfillpoddropvnusuk' },
    { name: 'MMO Darkness', url: 'https://www.facebook.com/groups/mmo.darkness' },
  ],

  // --- FB Competitor Pages (scrape comments = buyer leads) ---
  FB_COMPETITOR_PAGES: [
    { name: 'Weshop VN', url: 'https://www.facebook.com/weshopvn' },
    { name: 'SuperShip', url: 'https://www.facebook.com/supership.vn' },
    { name: 'Boxme Global', url: 'https://www.facebook.com/boxme.asia' },
  ],

  // --- Target accounts to scrape (SociaVault = profile-based) ---
  TT_TARGET_ACCOUNTS: [
    'fulfillmentvietnam',
    'podsellervn',
    'kinhdoanhus',
    'vietsellerus',
    'shiphangdimi',
    'tiktokshopsellervn',
  ],
  IG_TARGET_ACCOUNTS: [
    'sellertiktokus',
    'podvietnam',
    'dropshipvietnam',
    'kinhdoanhonlineus',
    'fulfillmentvn',
    'vncbiz',
  ],

  // --- Search keywords (kept for reference) ---
  SEARCH_KEYWORDS: {
    instagram: [
      'sellertiktokus',
      'podvietnam',
      'dropshipvietnam',
      'kinhdoanhonlineus',
    ],
    tiktok: [
      'POD Vietnam review',
      'ship hàng Mỹ như thế nào',
      'bán hàng TikTok US',
    ],
  },

  // --- THG business context for AI ---
  THG_CONTEXT: `
THG là công ty logistics, express, fulfillment và warehouse phục vụ seller e-commerce VẬN CHUYỂN TOÀN CẦU (không chỉ Mỹ).

Dịch vụ THG cung cấp:
1. THG Express: Vận chuyển hàng từ VN/CN đi TOÀN THẾ GIỚI (Mỹ, Úc, UK, UAE, Đài Loan, Saudi, Chile, Colombia, Mexico…) — tuyến bay riêng, giá rẻ, tracking real-time
2. THG Fulfill (POD): Seller gửi file thiết kế → THG in ấn tại xưởng VN/CN/US → đóng gói → ship tới khách hàng
3. THG Fulfill (Dropship): Seller gửi link sản phẩm → THG mua hộ → ship quốc tế
4. THG Warehouse/3PL: Kho kép tại Mỹ (Pennsylvania + Texas) — fulfill nội địa từ $1.2/đơn, giao 2-5 ngày toàn US, miễn phí lưu kho 90 ngày
5. E-packet lines: Chile, Colombia, Mexico, Saudi, UAE, Úc, Đài Loan...

Lợi thế THG:
- Xưởng in riêng ở VN, CN, Mỹ
- Tuyến bay riêng VN/CN → nhiều nước, giá rẻ hơn DHL/FedEx
- Kho fulfillment kép tại Mỹ (PA + TX) — phủ sóng toàn US
- Fulfill từ $1.2/đơn — cạnh tranh, không phí ẩn
- Miễn phí nhập kho & lưu kho 90 ngày
- Hệ thống OMS/WMS, tracking real-time
- Quay video đóng gói từng đơn
- Hỗ trợ Amazon FBA prep & FBM fulfill
- Hỗ trợ 24/7 bằng tiếng Việt

NỖI ĐAU SELLER (THG giải quyết):
- Vận chuyển: Ship VN→US 10-20 ngày → khách hủy đơn, mất review → THG: kho US, 2-5 ngày
- Chi phí: Phí kho cao, phí ẩn → THG: từ $1.2/đơn, free 90 ngày
- Hệ thống: Không có OMS → sai sót, chậm → THG: OMS/WMS real-time
- Kiểm soát: Đóng gói thủ công, không tracking → THG: video đóng gói, tracking real-time

MẪU BÀI VIẾT CỦA KHÁCH HÀNG TIỀM NĂNG (BUYER INTENT):
- "tìm đối tác POD/dropship giá tốt hơn Ali, có kho US càng tốt"
- "cần tìm đơn vị vận chuyển Trung Quốc - Saudi"
- "Tìm DVVC EPK VN-Đài Loan"
- "em tha thiết tìm bên dịch vụ 3PL"
- "tìm đơn vị vận chuyển sang UAE và Ai Cập"
- "cần tìm dịch vụ kho bên US"
- "cần tìm đơn vị vận chuyển từ VN-Úc"
- "cần Sup ff sản phẩm Car Air Freshener, ship đi US/UK"
- "đang cần tìm cho sp Bracelet"
- "Cần line E-packet: Chile, Colombia, Mexico"
- "Cần tìm kiếm đơn vị hợp tác ffm, vận chuyển"
- "cần vận chuyển hàng từ VN đi thế giới"
- "khách hủy đơn vì giao lâu quá, cần kho US"
- "phí fulfill đắt, tìm alternative rẻ hơn"

Khi gặp bài viết tương tự → BUYER (score cao). Nếu là bài quảng cáo dịch vụ → PROVIDER (bỏ qua).
  `.trim(),
};
