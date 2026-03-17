/**
 * 🎯 Sniper Agent — Comment on lead posts
 * Navigates to target post, simulates reading, types a spintax comment.
 * 
 * @module squad/agents/sniperAgent
 */
const { humanDelay, humanType, humanScroll, humanClick } = require('../core/humanizer');
const { spinText, spinTemplate } = require('../core/spintax');
const squadDB = require('../core/squadDB');
const config = require('../squadConfig');
const fs = require('fs');
const path = require('path');

// Load templates
const TEMPLATES_PATH = path.join(__dirname, '..', 'templates', 'sniper.json');
let templates = {};
try {
    templates = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
} catch (e) {
    console.warn(`[Sniper] ⚠️ Cannot load templates: ${e.message}`);
}

/**
 * Execute a sniper mission — comment on a target post
 * @param {Page} page - Playwright page (already authenticated)
 * @param {string} postUrl - URL of the target post
 * @param {object} opts - { templateName, customTemplate, account }
 * @returns {boolean} success
 */
async function sniperComment(page, postUrl, opts = {}) {
    const { templateName = 'default', customTemplate = null, account = 'unknown' } = opts;

    console.log(`[Sniper] 🎯 Đang ngắm mục tiêu: ${postUrl.substring(0, 70)}`);

    try {
        // 1. Navigate to target post
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(2000, 5000); // Pretend to read

        // 2. Simulate reading — scroll through the post
        await humanScroll(page, 2);

        // 3. Find comment box (multi-selector for language stability)
        let commentBox = null;
        for (const sel of config.SELECTORS.COMMENT_BOX) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    commentBox = el;
                    break;
                }
            } catch { }
        }

        if (!commentBox) {
            console.warn(`[Sniper] ⚠️ Comment box không tìm thấy hoặc bị ẩn`);
            return false;
        }

        // 4. Click into comment box
        await commentBox.click();
        await humanDelay(800, 1500);

        // 5. Generate unique comment via Spintax
        let finalComment;
        if (customTemplate) {
            finalComment = spinText(customTemplate);
        } else {
            finalComment = spinTemplate(templateName, templates);
        }

        if (!finalComment) {
            finalComment = spinText(templates.default || 'Chào bạn, inbox mình nhé!');
        }

        console.log(`[Sniper] ⌨️ Đang gõ: "${finalComment.substring(0, 60)}..."`);

        // 6. Type comment like a human — NEVER use page.fill()
        await humanType(page, finalComment, config.SNIPER_TYPING_DELAY);

        // 7. Pause before sending (human hesitation)
        await humanDelay(1000, 2000);

        // 8. Submit comment
        await page.keyboard.press('Enter');
        console.log(`[Sniper] ✅ Bắn trúng đích! Comment đã được gửi.`);

        // 9. Wait for comment to appear
        await humanDelay(3000, 5000);

        // 10. Log action
        squadDB.logAction(account, 'comment', postUrl, true, finalComment);

        return true;

    } catch (e) {
        console.error(`[Sniper] ❌ Súng kẹt đạn: ${e.message}`);
        squadDB.logAction(account, 'comment', postUrl, false, '');
        return false;
    }
}

module.exports = { sniperComment };
