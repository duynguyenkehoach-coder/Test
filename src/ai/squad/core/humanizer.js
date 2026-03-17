/**
 * Humanizer — Make bot actions look human
 * Typing effects, scrolling, random delays, mouse movements.
 * 
 * @module squad/core/humanizer
 */

/**
 * Random delay between min and max ms
 */
function humanDelay(min = 1000, max = 3000) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Type text like a human — character by character with random delay.
 * NEVER use page.fill() — Facebook detects instant paste.
 * 
 * @param {Page} page - Playwright page
 * @param {string} text - Text to type
 * @param {object} opts - { minDelay: 80, maxDelay: 180 }
 */
async function humanType(page, text, opts = {}) {
    const { minDelay = 80, maxDelay = 180 } = opts;

    for (const char of text) {
        await page.keyboard.type(char, { delay: 0 });
        // Random delay between keystrokes
        const d = minDelay + Math.random() * (maxDelay - minDelay);
        await new Promise(r => setTimeout(r, d));

        // Occasionally pause longer (simulates thinking/typo hesitation)
        if (Math.random() < 0.05) {
            await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
        }
    }
}

/**
 * Scroll page like a human reading content
 * @param {Page} page - Playwright page
 * @param {number} scrolls - Number of scroll actions (default 2-4)
 */
async function humanScroll(page, scrolls = null) {
    const n = scrolls || (2 + Math.floor(Math.random() * 3));

    for (let i = 0; i < n; i++) {
        const distance = 300 + Math.random() * 500;
        await page.mouse.wheel(0, distance);
        await humanDelay(1000, 3000);
    }
}

/**
 * Click with slight mouse movement (more human-like)
 * @param {Page} page - Playwright page
 * @param {string} selector - CSS selector to click
 */
async function humanClick(page, selector) {
    const element = await page.$(selector);
    if (!element) {
        console.warn(`[Humanizer] ⚠️ Element not found: ${selector}`);
        return false;
    }

    const box = await element.boundingBox();
    if (!box) return false;

    // Move mouse to element with slight random offset
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);

    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
    await humanDelay(200, 500);
    await page.mouse.click(x, y);

    return true;
}

/**
 * Wait for element and click it (with human-like behavior)
 * @param {Page} page - Playwright page
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait time in ms
 */
async function waitAndClick(page, selector, timeout = 10000) {
    try {
        await page.waitForSelector(selector, { timeout });
        await humanDelay(500, 1500);
        return await humanClick(page, selector);
    } catch (e) {
        console.warn(`[Humanizer] ⚠️ Wait+Click failed for ${selector}: ${e.message}`);
        return false;
    }
}

module.exports = { humanDelay, humanType, humanScroll, humanClick, waitAndClick };
