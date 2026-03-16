/**
 * Squad Config — Rate limits, account assignments, behavior settings
 * 
 * @module squad/squadConfig
 */

module.exports = {
    // ═══ Sniper (Comment Agent) ═══
    SNIPER_MAX_PER_DAY: 10,         // Max comments per account per day
    SNIPER_COOLDOWN_MINUTES: 30,     // Min minutes between comments
    SNIPER_TYPING_DELAY: { min: 100, max: 180 }, // Typing speed (ms/char)

    // ═══ Broadcaster (Post Agent) ═══
    BROADCASTER_MAX_PER_DAY: 2,      // Max posts per account per day
    BROADCASTER_COOLDOWN_MINUTES: 120, // Min minutes between posts
    BROADCASTER_TYPING_DELAY: { min: 50, max: 90 }, // Faster for long posts

    // ═══ Dispatcher ═══
    POLL_INTERVAL: 15 * 60 * 1000,  // Check queue every 15 min
    SEPARATION_RULE: true,           // Comment day ≠ Post day per account

    // ═══ Account Assignments ═══
    // Which accounts are assigned to which roles
    // If empty, dispatcher will auto-assign from AccountManager
    ACCOUNT_ROLES: {
        // 'manyhope0502@gmail.com': 'sniper',
        // 'mystictarot98@gmail.com': 'broadcaster',
    },

    // ═══ Lead Keywords — triggers Sniper queue ═══
    LEAD_KEYWORDS: [
        'tìm kho fulfill', 'chuyển hàng đi us', 'ship us', 'cần fulfill',
        'báo giá vận chuyển', 'tuyến vn-us', 'pod fulfillment',
        'tìm kho hàng', 'gửi hàng đi mỹ', 'ship hàng mỹ',
        'cần vận chuyển', 'fulfillment us', 'kho fulfill',
        'tìm đơn vị vận chuyển', 'tìm dịch vụ ship',
    ],

    // ═══ Facebook Selectors (updated for current FB DOM) ═══
    SELECTORS: {
        COMMENT_BOX: [
            'div[aria-label="Write a comment"]',
            'div[aria-label="Viết bình luận"]',
            'div[aria-label="Write a comment..."]',
            'div[contenteditable="true"][role="textbox"]',
        ],
        WRITE_POST_BUTTON: [
            'div[role="button"]:has-text("Write something")',
            'div[role="button"]:has-text("Bạn viết gì đi")',
            'div[role="button"]:has-text("What\'s on your mind")',
            'div[role="button"]:has-text("Bạn đang nghĩ gì")',
        ],
        POST_TEXTBOX: [
            'form[method="POST"] div[role="textbox"]',
            'div[role="dialog"] div[role="textbox"]',
        ],
        SUBMIT_POST: [
            'form[method="POST"] div[aria-label="Post"]',
            'form[method="POST"] div[aria-label="Đăng"]',
            'div[role="dialog"] div[aria-label="Post"]',
            'div[role="dialog"] div[aria-label="Đăng"]',
        ],
    },

    // ═══ Persona Agent (PASSIVE-ONLY camouflage) ═══
    PERSONA_CONFIG: {
        FEED_SCROLL_SECONDS: { min: 20, max: 45 },
        LIKE_CHANCE: 0.3,           // 30% chance to like 1 post during feed browse
        STORY_VIEW_CHANCE: 0.4,     // 40% chance to view a story
        PROFILE_VISIT_CHANCE: 0.1,  // 10% chance to visit a random profile (future)
        // ❌ NO STATUS_UPDATE — wastes Trust, looks fake
        // ❌ NO CASUAL_COMMENT — wastes Trust Score blood  
    },
};
