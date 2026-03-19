/**
 * 🏄 Feed Browser — Warm-up & Cool-down Behavior
 * 
 * Simulates natural Facebook browsing:
 * - Scroll news feed
 * - Read posts (pause on them)
 * - Occasionally like a post
 * - Watch a story
 * 
 * @module agent/social/feedBrowser
 */
const { humanDelay, humanScroll, humanClick } = require('../../ai/squad/core/humanizer');
const { randInt } = require('./sessionManager');

// ─── Selectors (Facebook 2024+) ──────────────────────────────────────────────
const SEL = {
    // Feed posts — generic containers
    FEED_POST: '[role="article"], [data-pagelet*="FeedUnit"]',
    // Like button — multiple variants
    LIKE_BTN: [
        '[aria-label="Like"], [aria-label="Thích"]',
        '[aria-label="Thả tim"], [aria-label="Love"]',
    ],
    // Story tray
    STORY_TRAY: '[aria-label="Stories"], [data-pagelet*="Stories"]',
    STORY_ITEM: '[aria-roledescription="story"]',
    // Close story overlay
    STORY_CLOSE: '[aria-label="Close"], [aria-label="Đóng"]',
};

/**
 * Scroll feed naturally — read 3-8 posts
 * @param {Page} page - Playwright page
 * @param {string} intensity - 'light' | 'medium' | 'heavy'
 * @returns {number} posts "read"
 */
async function scrollFeed(page, intensity = 'medium') {
    const scrollCounts = { light: randInt(2, 4), medium: randInt(4, 7), heavy: randInt(6, 10) };
    const count = scrollCounts[intensity] || scrollCounts.medium;

    console.log(`[FeedBrowser] 📜 Scrolling feed (${intensity}, ~${count} scrolls)...`);

    let postsRead = 0;
    for (let i = 0; i < count; i++) {
        // Scroll down
        const distance = 300 + Math.random() * 600;
        await page.mouse.wheel(0, distance);

        // Pause to "read" — variable timing simulates attention
        const readTime = 2000 + Math.random() * 8000; // 2-10 seconds
        await humanDelay(readTime * 0.8, readTime * 1.2);
        postsRead++;

        // Occasionally pause longer (reading a long post)
        if (Math.random() < 0.15) {
            console.log(`[FeedBrowser]   📖 Reading an interesting post...`);
            await humanDelay(5000, 15000);
        }
    }

    console.log(`[FeedBrowser] ✅ Scrolled feed, ~${postsRead} posts seen`);
    return postsRead;
}

/**
 * Like a random visible post (30% chance per call)
 * @param {Page} page
 * @returns {boolean} true if liked
 */
async function maybeLikePost(page) {
    if (Math.random() > 0.30) {
        console.log(`[FeedBrowser] 👍 Skipping like this time (random)`);
        return false;
    }

    try {
        // Find all like buttons on visible posts
        for (const selector of SEL.LIKE_BTN) {
            const buttons = await page.$$(selector);
            if (buttons.length === 0) continue;

            // Pick a random one (not the first — too predictable)
            const idx = randInt(0, Math.min(buttons.length - 1, 4));
            const btn = buttons[idx];

            // Check if already liked (aria-pressed)
            const pressed = await btn.getAttribute('aria-pressed');
            if (pressed === 'true') continue;

            // Scroll to it first
            await btn.scrollIntoViewIfNeeded();
            await humanDelay(500, 1500);

            // Click with human behavior
            const box = await btn.boundingBox();
            if (!box) continue;

            const x = box.x + box.width * (0.3 + Math.random() * 0.4);
            const y = box.y + box.height * (0.3 + Math.random() * 0.4);
            await page.mouse.move(x, y, { steps: randInt(5, 12) });
            await humanDelay(200, 600);
            await page.mouse.click(x, y);

            console.log(`[FeedBrowser] ❤️ Liked a post`);
            await humanDelay(1000, 3000);
            return true;
        }
    } catch (e) {
        // Silent — liking is optional
    }

    return false;
}

/**
 * Maybe watch a story (20% chance)
 * @param {Page} page
 * @returns {boolean}
 */
async function maybeWatchStory(page) {
    if (Math.random() > 0.20) return false;

    try {
        const stories = await page.$$(SEL.STORY_ITEM);
        if (stories.length === 0) return false;

        const idx = randInt(0, Math.min(stories.length - 1, 3));
        const story = stories[idx];
        await story.scrollIntoViewIfNeeded();
        await humanDelay(500, 1500);
        await story.click();

        console.log(`[FeedBrowser] 📱 Watching a story...`);
        await humanDelay(3000, 8000); // Watch for 3-8 seconds

        // Try to close story
        try {
            const closeBtn = await page.$(SEL.STORY_CLOSE);
            if (closeBtn) await closeBtn.click();
            else await page.keyboard.press('Escape');
        } catch {
            await page.keyboard.press('Escape');
        }

        await humanDelay(1000, 2000);
        console.log(`[FeedBrowser] ✅ Story watched`);
        return true;

    } catch (e) {
        try { await page.keyboard.press('Escape'); } catch { }
        return false;
    }
}

/**
 * Full warm-up routine — run before any "work"
 * @param {Page} page
 * @returns {{ postsRead: number, liked: boolean, storyWatched: boolean }}
 */
async function warmUp(page) {
    console.log(`[FeedBrowser] 🌅 Starting warm-up...`);

    const postsRead = await scrollFeed(page, 'light');
    const liked = await maybeLikePost(page);
    const storyWatched = await maybeWatchStory(page);

    console.log(`[FeedBrowser] ✅ Warm-up complete (read: ${postsRead}, liked: ${liked}, story: ${storyWatched})`);
    return { postsRead, liked, storyWatched };
}

/**
 * Cool-down routine — run after "work" before closing
 * @param {Page} page
 * @returns {{ postsRead: number, liked: boolean }}
 */
async function coolDown(page) {
    console.log(`[FeedBrowser] 🌙 Starting cool-down...`);

    // Navigate back to feed if not already there
    const url = page.url();
    if (!url.includes('facebook.com') || url.includes('messages') || url.includes('notifications')) {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await humanDelay(2000, 4000);
    }

    const postsRead = await scrollFeed(page, 'light');
    const liked = await maybeLikePost(page);

    console.log(`[FeedBrowser] ✅ Cool-down complete`);
    return { postsRead, liked };
}

module.exports = {
    scrollFeed,
    maybeLikePost,
    maybeWatchStory,
    warmUp,
    coolDown,
};
