/**
 * 👀 Profile Engager — Organic Retargeting Agent (FREE thay thế Facebook Ads)
 * 
 * Agent tương tác ngầm với lead profiles để tạo organic touchpoints:
 * 1. Vào profile lead → đọc vài post (dwell time)
 * 2. Like 1-2 bài post gần đây (lead nhận notification "ai đó like")
 * 3. React story nếu có (lead thấy ai đó react)
 * 4. Lặp lại 2-3 lần/tuần → lead quen mặt THG Sales
 * → Lead tò mò click vào profile THG → thấy page chuyên nghiệp → inbox
 * 
 * Anti-detection:
 * - Max 10-15 profiles/session
 * - Random delay 30s-2min giữa profiles
 * - Humanized scrolling, clicking
 * - Engagement probability (không like 100% — chỉ 40-60%)
 * - Active hours only
 * 
 * Tận dụng:
 * - humanizer.js → humanDelay, humanScroll, humanClick
 * - accountManager.js → getNextAccount
 * - database.js → log engagement
 * 
 * @module agent/strategies/profileEngager
 */
'use strict';

const { humanDelay, humanScroll, humanClick } = require('../../squad/core/humanizer');
const database = require('../../core/data_store/database');

// ─── Config ──────────────────────────────────────────────────────────────────
const MAX_PROFILES_PER_SESSION = 12;
const LIKE_PROBABILITY = 0.5;       // 50% chance to like a post
const STORY_REACT_PROBABILITY = 0.3; // 30% chance to react to story
const DELAY_BETWEEN_PROFILES = { min: 30000, max: 120000 }; // 30s - 2min
const SCROLL_DEPTH = { min: 2, max: 5 }; // scrolls on profile page
const DWELL_TIME = { min: 8000, max: 25000 }; // time spent reading profile

// ─── Main Engagement Flow ────────────────────────────────────────────────────

/**
 * Engage with a single lead's profile
 * @param {Page} page - Playwright page (authenticated)
 * @param {object} lead - Lead from DB (must have author_url)
 * @param {object} opts - { dryRun, sessionId }
 * @returns {{ success: boolean, actions: string[], error?: string }}
 */
async function engageProfile(page, lead, opts = {}) {
    const { dryRun = false, sessionId = '' } = opts;
    const actions = [];

    if (!lead.author_url) {
        return { success: false, actions: [], error: 'No author_url' };
    }

    const profileUrl = lead.author_url;
    console.log(`[ProfileEngager] 👀 Visiting: ${lead.author_name || 'Unknown'} (score: ${lead.score})`);

    try {
        // ── Step 1: Navigate to profile ──
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(3000, 6000);
        actions.push('visited_profile');

        // ── Step 2: Scroll down — read profile (dwell time) ──
        const scrollCount = randomInt(SCROLL_DEPTH.min, SCROLL_DEPTH.max);
        await humanScroll(page, scrollCount);
        const dwellMs = randomInt(DWELL_TIME.min, DWELL_TIME.max);
        await humanDelay(dwellMs, dwellMs + 3000);
        actions.push(`scrolled_${scrollCount}x`);
        actions.push(`dwell_${Math.round(dwellMs / 1000)}s`);

        // ── Step 3: Maybe like a post (50% chance) ──
        if (Math.random() < LIKE_PROBABILITY && !dryRun) {
            const liked = await tryLikeRecentPost(page);
            if (liked) {
                actions.push('liked_post');
                console.log(`[ProfileEngager] ❤️ Liked a post on ${lead.author_name}'s profile`);
            }
        }

        // ── Step 4: Maybe react to story (30% chance) ──
        if (Math.random() < STORY_REACT_PROBABILITY && !dryRun) {
            const reacted = await tryReactStory(page);
            if (reacted) {
                actions.push('reacted_story');
                console.log(`[ProfileEngager] 🌟 Reacted to ${lead.author_name}'s story`);
            }
        }

        // ── Step 5: Linger a bit more (natural ending) ──
        await humanDelay(2000, 5000);

        // ── Log engagement ──
        logEngagement(lead.id, actions, sessionId);

        console.log(`[ProfileEngager] ✅ ${lead.author_name}: [${actions.join(', ')}]`);
        return { success: true, actions };

    } catch (e) {
        console.error(`[ProfileEngager] ❌ Error on ${lead.author_name}: ${e.message}`);
        return { success: false, actions, error: e.message };
    }
}

/**
 * Run a full engagement session — visit multiple lead profiles
 * @param {Page} page - Playwright page
 * @param {object[]} leads - Array of leads to engage with
 * @param {object} opts
 * @returns {{ total: number, engaged: number, results: object[] }}
 */
async function runEngagementSession(page, leads, opts = {}) {
    const sessionId = `engage_${Date.now()}`;
    const toEngage = leads
        .filter(l => l.author_url && l.score >= 70)
        .slice(0, MAX_PROFILES_PER_SESSION);

    console.log(`[ProfileEngager] 🚀 Session start: ${toEngage.length} profiles (session: ${sessionId})`);

    const results = [];
    for (let i = 0; i < toEngage.length; i++) {
        const result = await engageProfile(page, toEngage[i], { ...opts, sessionId });
        results.push({ leadId: toEngage[i].id, authorName: toEngage[i].author_name, ...result });

        // Delay between profiles (30s - 2min)
        if (i < toEngage.length - 1) {
            const delay = randomInt(DELAY_BETWEEN_PROFILES.min, DELAY_BETWEEN_PROFILES.max);
            console.log(`[ProfileEngager] ⏳ Next profile in ${Math.round(delay / 1000)}s...`);
            await humanDelay(delay, delay + 5000);
        }
    }

    const engaged = results.filter(r => r.success).length;
    console.log(`[ProfileEngager] 🏁 Session done: ${engaged}/${toEngage.length} profiles engaged`);

    // Log session summary
    try {
        database.logSocialActivity('', 'profile_engagement_session', JSON.stringify({
            total: toEngage.length,
            engaged,
            liked: results.filter(r => r.actions?.includes('liked_post')).length,
            storyReacted: results.filter(r => r.actions?.includes('reacted_story')).length,
        }), sessionId);
    } catch { }

    return { total: toEngage.length, engaged, results };
}

/**
 * Get un-engaged leads (never visited or visited > 3 days ago)
 * @param {object} opts - { minScore, limit }
 * @returns {object[]}
 */
function getUnengagedLeads(opts = {}) {
    const { minScore = 70, limit = 15 } = opts;
    try {
        return database.db.prepare(`
            SELECT l.* FROM leads l
            LEFT JOIN (
                SELECT lead_id, MAX(created_at) as last_engaged
                FROM outreach_log WHERE channel = 'profile_engage'
                GROUP BY lead_id
            ) ol ON l.id = ol.lead_id
            WHERE l.score >= ? AND l.role = 'buyer' AND l.status NOT IN ('ignored', 'converted')
            AND l.author_url IS NOT NULL AND l.author_url != ''
            AND (ol.last_engaged IS NULL OR ol.last_engaged < datetime('now', '-3 days'))
            ORDER BY l.score DESC LIMIT ?
        `).all(minScore, limit);
    } catch {
        // Fallback if outreach_log doesn't have the columns yet
        return database.db.prepare(`
            SELECT * FROM leads WHERE score >= ? AND role = 'buyer'
            AND status NOT IN ('ignored', 'converted')
            AND author_url IS NOT NULL AND author_url != ''
            ORDER BY score DESC LIMIT ?
        `).all(minScore, limit);
    }
}

// ─── Content Filters (chọn lọc — KHÔNG bão like rẻ tiền) ────────────────────

// Posts chứa từ khóa này → KHÔNG LIKE
const BLACKLIST_PATTERNS = [
    // Quảng cáo / spam
    /(?:giảm giá|khuyến mãi|sale off|flash sale|mua ngay|đặt hàng|order now|inbox giá|dm for price)/i,
    // Chính trị / nhạy cảm
    /(?:chính trị|bầu cử|biểu tình|đảng|chính phủ|trump|biden|election|protest)/i,
    // Buồn / tang / tiêu cực
    /(?:rip|ra đi|qua đời|mất rồi|chia tay|tang lễ|buồn quá|tuyệt vọng|condolence|passed away)/i,
    // Scam / đa cấp
    /(?:đa cấp|mlm|thu nhập thụ động|passive income|forex signal|crypto.*x\d|ponzi|binance signal)/i,
    // Đối thủ trực tiếp
    /(?:anex|yanwen|vnpost express|ghn us|shipment.*competitor)/i,
    // Religious / gây tranh cãi
    /(?:kinh thánh|phật|chúa|nhà thờ|đền|church|pray for)/i,
];

// Posts chứa từ khóa này → ƯU TIÊN LIKE (liên quan đến business/logistics)
const WHITELIST_PATTERNS = [
    /(?:ship|vận chuyển|fulfillment|kho hàng|warehouse|ecommerce|e-commerce|etsy|amazon|tiktok shop)/i,
    /(?:kinh doanh|business|startup|doanh thu|khởi nghiệp|seller|dropship|pod|print on demand)/i,
    /(?:review|chia sẻ kinh nghiệm|tips|hướng dẫn|tutorial|milestone|thành công|success)/i,
    /(?:hàng mỹ|ship mỹ|order mỹ|us warehouse|ship to us|gửi hàng)/i,
];

/**
 * Check if a post's content is worth liking
 * @param {string} text - Post text content
 * @returns {'like' | 'skip' | 'neutral'}
 */
function evaluatePostContent(text) {
    if (!text || text.length < 10) return 'skip';

    // Check blacklist first — any match → skip
    for (const pattern of BLACKLIST_PATTERNS) {
        if (pattern.test(text)) return 'skip';
    }

    // Check whitelist — any match → like
    for (const pattern of WHITELIST_PATTERNS) {
        if (pattern.test(text)) return 'like';
    }

    // Neutral content — like only if post is positive/casual (photos, life updates)
    // Skip if too short (just a link/share) or too long (article/rant)
    if (text.length < 30 || text.length > 2000) return 'skip';

    return 'neutral';
}

// ─── Browser Interaction Helpers ─────────────────────────────────────────────

/**
 * Try to like a SELECTED post on the profile page
 * Reads post content first → evaluates → only likes if worth it
 * Max 1 like per profile visit
 */
async function tryLikeRecentPost(page) {
    try {
        // Get all visible post containers
        const postSelectors = [
            'div[data-pagelet^="ProfileTimeline"] div[role="article"]',
            'div[role="article"]',
        ];

        let posts = [];
        for (const sel of postSelectors) {
            posts = await page.$$(sel);
            if (posts.length > 0) break;
        }

        if (posts.length === 0) return false;

        // Scan up to 5 posts, find the first one worth liking
        const maxScan = Math.min(posts.length, 5);
        for (let i = 0; i < maxScan; i++) {
            const post = posts[i];
            try {
                // Read post content
                const postText = await post.innerText().catch(() => '');
                const verdict = evaluatePostContent(postText);

                if (verdict === 'skip') {
                    console.log(`[ProfileEngager] ⏭️ Skip post #${i + 1} (blacklisted/irrelevant)`);
                    continue;
                }

                // For 'neutral' posts — only 30% chance to like (selective)
                if (verdict === 'neutral' && Math.random() > 0.3) {
                    console.log(`[ProfileEngager] 🤷 Neutral post #${i + 1} — skip this time`);
                    continue;
                }

                // Found a good post → find its Like button
                const likeSelectors = [
                    '[aria-label="Like"]', '[aria-label="Thích"]',
                    '[aria-label="Like"][role="button"]',
                ];

                for (const sel of likeSelectors) {
                    const btn = await post.$(sel);
                    if (btn && await btn.isVisible()) {
                        const pressed = await btn.getAttribute('aria-pressed');
                        if (pressed === 'true') continue; // Already liked

                        console.log(`[ProfileEngager] 🎯 Selected post #${i + 1} to like (verdict: ${verdict})`);
                        await humanClick(page, btn);
                        await humanDelay(1000, 2000);
                        return true;
                    }
                }
            } catch { continue; }
        }

        console.log(`[ProfileEngager] 🚫 No post worth liking — skipped all`);
        return false;
    } catch {
        return false;
    }
}

/**
 * Try to react to a profile story
 */
async function tryReactStory(page) {
    try {
        // Story circle selectors
        const storySelectors = [
            '[aria-label="Story"]',
            '[aria-label="Tin"]',
            'div[data-pagelet="ProfileTimeline"] [role="img"]',
        ];

        for (const sel of storySelectors) {
            const storyEl = await page.$(sel);
            if (storyEl && await storyEl.isVisible()) {
                await humanClick(page, storyEl);
                await humanDelay(3000, 8000); // Watch story

                // Try to react
                const reactSelectors = ['[aria-label="React"]', '[aria-label="Phản hồi"]'];
                for (const rSel of reactSelectors) {
                    const reactBtn = await page.$(rSel);
                    if (reactBtn && await reactBtn.isVisible()) {
                        await humanClick(page, reactBtn);
                        await humanDelay(500, 1000);

                        // Pick a reaction (❤️ most common)
                        const heartSel = '[aria-label="Love"], [aria-label="Yêu thích"]';
                        const heartBtn = await page.$(heartSel);
                        if (heartBtn) {
                            await humanClick(page, heartBtn);
                            await humanDelay(1000, 2000);
                        }
                        break;
                    }
                }

                // Close story
                try { await page.keyboard.press('Escape'); } catch { }
                await humanDelay(1000, 2000);
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * humanClick wrapper that finds element position and clicks near center
 */
async function humanClick(page, element) {
    try {
        const box = await element.boundingBox();
        if (!box) { await element.click(); return; }
        // Click near center with random offset
        const x = box.x + box.width / 2 + (Math.random() - 0.5) * 6;
        const y = box.y + box.height / 2 + (Math.random() - 0.5) * 4;
        await page.mouse.click(x, y, { delay: randomInt(50, 150) });
    } catch {
        await element.click();
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function logEngagement(leadId, actions, sessionId) {
    try {
        database.db.prepare(`
            INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status, sent_at)
            VALUES (?, 'agent', 'profile_engage', ?, 0, 'engaged', datetime('now'))
        `).run(leadId, actions.join(', '));
    } catch { }
}

module.exports = {
    engageProfile,
    runEngagementSession,
    getUnengagedLeads,
    MAX_PROFILES_PER_SESSION,
};
