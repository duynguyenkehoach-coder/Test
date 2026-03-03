require('dotenv').config();

module.exports = {
  // --- Apify (fallback only) ---
  APIFY_TOKEN: process.env.APIFY_TOKEN,

  // --- RapidAPI (primary scraping) ---
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY,

  // --- AI (Groq — scan & classify) ---
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  AI_MODEL: 'llama-3.3-70b-versatile',

  // --- AI (Gemini — auto-sale responses) ---
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: 'gemini-1.5-flash',

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // --- Lead scoring ---
  LEAD_SCORE_THRESHOLD: 60,

  // --- Cron schedule (every 30 minutes) ---
  CRON_SCHEDULE: '*/30 * * * *',

  // --- Server ---
  PORT: process.env.PORT || 3000,

  // --- Apify Actor IDs ---
  APIFY_ACTORS: {
    // Facebook
    FB_SEARCH: 'apify/facebook-search-scraper',
    // Instagram
    IG_HASHTAG: 'apify/instagram-hashtag-scraper',
    // Reddit
    REDDIT_SEARCH: 'trudax/reddit-scraper',
    // Twitter / X
    TWITTER_SEARCH: 'apidojo/tweet-scraper',
    // TikTok
    TIKTOK_SEARCH: 'clockworks/tiktok-scraper',
  },

  // --- Facebook Groups to scrape directly (high-priority) ---
  FB_TARGET_GROUPS: [
    { name: 'THG Fulfill US', id: 'thgfulfillus' },
    { name: 'Ship hàng Mỹ', id: '1312868109620530' },
    { name: 'Cộng đồng Etsy VN', id: 'congdongetsyvietnam' },
    { name: 'TikTok Shop US Underground', id: 'tiktokshopusunderground' },
    { name: 'Fulfillment Group 1', id: '699960295544009' },
    { name: 'Fulfillment Group 2', id: '1046936722421696' },
    { name: 'Seller Group 1', id: '514921692619278' },
    { name: 'Seller Group 2', id: '4345407472191763' },
    { name: 'Etsy To Go', id: 'etsytogo' },
    { name: 'Ecommerce Group', id: '3043290549049105' },
    { name: 'Cộng đồng Amazon VN', id: 'congdongamazonvn' },
    { name: 'Seller Group 3', id: '245963281899537' },
    { name: 'eBay Group', id: 'httpswww.facebook.ebay' },
    { name: 'Logistics Group', id: '504508125465530' },
  ],

  // --- Platforms to enable (toggle on/off) ---
  // All 5 platforms work within Apify free $5/month budget
  ENABLED_PLATFORMS: ['facebook', 'tiktok', 'instagram'],

  // --- Search keywords per platform ---
  // QUAN TRỌNG: Keywords phải tập trung vào BUYER INTENT (người ĐANG TÌM dịch vụ)
  // KHÔNG phải keywords của người CUNG CẤP dịch vụ (đối thủ)
  SEARCH_KEYWORDS: {
    facebook: [
      // Top Vietnamese buyer-intent queries (trimmed to save API credits)
      'cần ship hàng sang Mỹ',
      'tìm đơn vị vận chuyển sang Mỹ',
      'tìm kho Mỹ cho seller',
      'cần kho fulfillment ở Mỹ',
      'tìm dịch vụ in POD ship nội địa Mỹ',
      // Top English buyer-intent queries
      'need help shipping from China to USA',
      'need fulfillment center in USA',
      'looking for 3PL in United States',
    ],
    instagram: [
      // Top 5 hashtags (trimmed to save API credits)
      'shiphangsangmy',
      'vanchuyenquocte',
      'guihangdimi',
      'fulfillmentusa',
      'shippingfromchina',
    ],
    reddit: [
      // Top 5 buyer queries (trimmed — Reddit is free so less urgent)
      'looking for fulfillment from China',
      'need shipping from Vietnam to US',
      'cheap shipping China to USA',
      'anyone use 3PL for products from Asia',
      'warehouse in US for imported goods',
    ],
    twitter: [
      // Top 4 (trimmed to save credits)
      'need shipping from China to US',
      'looking for fulfillment USA',
      'need 3PL for ecommerce USA',
      'anyone know good freight forwarder China US',
    ],
    tiktok: [
      // Top 3 (each keyword = 3 video searches + 3x10 comment fetches)
      'ship hàng sang Mỹ',
      'tìm kho Mỹ',
      'shipping from China to US',
    ],
  },

  // --- Reddit subreddits where BUYERS ask questions ---
  REDDIT_SUBREDDITS: [
    // Top 5 (Reddit is free but still want to keep AI classify volume low)
    'ecommerce',
    'FulfillmentByAmazon',
    'shopify',
    'Entrepreneur',
    'smallbusiness',
  ],

  // --- THG business context for AI ---
  THG_CONTEXT: `
THG là công ty logistics và fulfillment chuyên phục vụ seller e-commerce bán hàng sang thị trường Mỹ.

Dịch vụ THG cung cấp:
1. THG Fulfill (POD): Seller gửi file thiết kế → THG in ấn tại xưởng VN/CN/US → đóng gói → ship tới khách Mỹ
2. THG Fulfill (Dropship): Seller gửi link sản phẩm Taobao/1688 → THG mua hộ → ship sang Mỹ
3. THG Express: Seller có hàng sẵn ở VN/CN → THG vận chuyển sang Mỹ bằng tuyến bay riêng, giá rẻ, tracking rõ ràng
4. THG Warehouse: Seller nhập hàng trước vào kho THG ở Pennsylvania/North Carolina → khi có đơn ship nội địa Mỹ 2-5 ngày

Lợi thế THG:
- Có xưởng in riêng ở VN, CN, Mỹ
- Tuyến bay riêng VN/CN → Mỹ, giá rẻ hơn DHL/FedEx
- Kho fulfillment tại Pennsylvania và North Carolina
- Hệ thống OMS/WMS, tracking real-time
- Hỗ trợ 24/7
  `.trim(),
};
