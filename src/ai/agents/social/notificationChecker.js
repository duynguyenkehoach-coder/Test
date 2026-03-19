/**
 * 🔔 Notification Checker — Read Facebook Notifications
 * 
 * Checks the notification bell naturally:
 * - Click bell icon
 * - Scroll notification list
 * - Click 1-2 random notifications to "read"
 * - Log new notification types
 * 
 * @module agent/social/notificationChecker
 */
const { humanDelay, humanScroll, humanClick } = require('../../ai/squad/core/humanizer');
const { randInt } = require('./sessionManager');

// ─── Selectors ───────────────────────────────────────────────────────────────
const SEL = {
    // Bell icon — notifications
    BELL: [
        '[aria-label="Notifications"], [aria-label="Thông báo"]',
        'a[href*="/notifications"]',
    ],
    // Notification items in dropdown
    NOTIF_ITEM: '[role="listitem"] a, [data-pagelet*="Notification"] a',
    // Back button / close
    BACK: '[aria-label="Back"], [aria-label="Quay lại"]',
    // Unread indicator (dot/badge)
    UNREAD_BADGE: '[aria-label*="notification"] [data-visualcompletion="ignore"]',
};

/**
 * Check notifications bell
 * @param {Page} page - Playwright page (on facebook.com)
 * @returns {{ checked: boolean, newCount: number, clickedItems: number }}
 */
async function checkNotifications(page) {
    console.log(`[NotifChecker] 🔔 Checking notifications...`);

    const result = { checked: false, newCount: 0, clickedItems: 0 };

    try {
        // 1. Find and click the bell icon
        let bellClicked = false;
        for (const sel of SEL.BELL) {
            try {
                const bell = await page.$(sel);
                if (bell && await bell.isVisible()) {
                    // Scroll into view first
                    await bell.scrollIntoViewIfNeeded();
                    await humanDelay(300, 800);

                    // Human-like click
                    const box = await bell.boundingBox();
                    if (box) {
                        const x = box.x + box.width * (0.3 + Math.random() * 0.4);
                        const y = box.y + box.height * (0.3 + Math.random() * 0.4);
                        await page.mouse.move(x, y, { steps: randInt(5, 10) });
                        await humanDelay(200, 500);
                        await page.mouse.click(x, y);
                        bellClicked = true;
                        break;
                    }
                }
            } catch { /* try next selector */ }
        }

        if (!bellClicked) {
            // Fallback: navigate to notifications page
            console.log(`[NotifChecker] 🔔 Bell not found, navigating to /notifications`);
            await page.goto('https://www.facebook.com/notifications', {
                waitUntil: 'domcontentloaded', timeout: 20000,
            });
        }

        await humanDelay(2000, 4000);
        result.checked = true;

        // 2. Scroll through notifications (2-4 scrolls)
        const scrollCount = randInt(2, 4);
        for (let i = 0; i < scrollCount; i++) {
            await page.mouse.wheel(0, 200 + Math.random() * 300);
            await humanDelay(1500, 3500);
        }

        // 3. Click 0-2 random notification items to "read"
        const clickCount = randInt(0, 2);
        if (clickCount > 0) {
            const items = await page.$$(SEL.NOTIF_ITEM);
            if (items.length > 0) {
                const toClick = Math.min(clickCount, items.length);
                const indices = [];
                while (indices.length < toClick) {
                    const idx = randInt(0, Math.min(items.length - 1, 8));
                    if (!indices.includes(idx)) indices.push(idx);
                }

                for (const idx of indices) {
                    try {
                        const item = items[idx];
                        await item.scrollIntoViewIfNeeded();
                        await humanDelay(500, 1500);
                        await item.click();
                        result.clickedItems++;

                        console.log(`[NotifChecker]   📧 Opened notification #${idx + 1}`);

                        // "Read" the notification content (3-8 seconds)
                        await humanDelay(3000, 8000);

                        // Go back to notifications
                        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
                        await humanDelay(1500, 3000);
                    } catch {
                        // Navigation might fail — that's okay
                        try {
                            await page.goto('https://www.facebook.com/notifications', {
                                waitUntil: 'domcontentloaded', timeout: 15000,
                            });
                            await humanDelay(1500, 2500);
                        } catch { break; }
                    }
                }
            }
        }

        console.log(`[NotifChecker] ✅ Notifications checked (clicked: ${result.clickedItems})`);

    } catch (e) {
        console.error(`[NotifChecker] ❌ Error: ${e.message}`);
    }

    return result;
}

module.exports = { checkNotifications };
