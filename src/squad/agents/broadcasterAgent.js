/**
 * 📻 Broadcaster Agent — Post PR content to Facebook groups
 * Navigates to group, creates post with spintax content.
 * 
 * @module squad/agents/broadcasterAgent
 */
const { humanDelay, humanType, humanScroll, waitAndClick } = require('../core/humanizer');
const { spinText, spinTemplate } = require('../core/spintax');
const squadDB = require('../core/squadDB');
const config = require('../squadConfig');
const fs = require('fs');
const path = require('path');

// Load templates
const TEMPLATES_PATH = path.join(__dirname, '..', 'templates', 'broadcaster.json');
let templates = {};
try {
    templates = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
} catch (e) {
    console.warn(`[Broadcaster] ⚠️ Cannot load templates: ${e.message}`);
}

/**
 * Execute a broadcast mission — post PR content to a group
 * @param {Page} page - Playwright page (already authenticated)
 * @param {string} groupId - Facebook Group ID or URL
 * @param {object} opts - { templateName, customTemplate, account }
 * @returns {boolean} success
 */
async function broadcastPost(page, groupId, opts = {}) {
    const { templateName = 'promo', customTemplate = null, account = 'unknown' } = opts;
    const groupUrl = groupId.startsWith('http')
        ? groupId
        : `https://www.facebook.com/groups/${groupId}`;

    console.log(`[Broadcaster] 📻 Chuẩn bị phát sóng vào Group: ${groupId}`);

    try {
        // 1. Navigate to group
        await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(3000, 6000); // Wait like reading

        // 2. Browse group briefly (simulate normal user)
        await humanScroll(page, 2);

        // 3. Find "Write something" button
        let writeButton = null;
        for (const sel of config.SELECTORS.WRITE_POST_BUTTON) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    writeButton = el;
                    break;
                }
            } catch { }
        }

        if (!writeButton) {
            console.warn(`[Broadcaster] ⚠️ Không tìm thấy nút tạo bài viết — group có thể cấm đăng`);
            return false;
        }

        // 4. Click to open post creation dialog
        await writeButton.click();
        console.log(`[Broadcaster] 📝 Đã mở khung tạo bài viết`);
        await humanDelay(2000, 4000); // Wait for dialog

        // 5. Find post textbox inside dialog
        let postBox = null;
        for (const sel of config.SELECTORS.POST_TEXTBOX) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    postBox = el;
                    break;
                }
            } catch { }
        }

        if (!postBox) {
            console.warn(`[Broadcaster] ⚠️ Không tìm thấy khung nhập nội dung bài viết`);
            return false;
        }

        await postBox.click();
        await humanDelay(500, 1000);

        // 6. Generate unique post content via Spintax
        let finalPost = '';
        let imagePath = null;

        let tplObj;
        if (templates.templates && templates.templates.length > 0) {
            // New format: { "templates": [ { "text": "...", "image": "..." } ] }
            tplObj = templates.templates[Math.floor(Math.random() * templates.templates.length)];
        } else if (templates[templateName]) {
            // Old format: { "promo": [ "..." ] }
            tplObj = templates[templateName];
            if (Array.isArray(tplObj)) tplObj = tplObj[Math.floor(Math.random() * tplObj.length)];
        }

        if (typeof tplObj === 'string') {
            finalPost = spinText(tplObj);
        } else if (tplObj && tplObj.text) {
            finalPost = spinText(tplObj.text);
            imagePath = tplObj.image;
        } else {
            finalPost = 'Chào mọi người, inbox mình nhé!';
        }

        if (customTemplate) {
            finalPost = spinText(customTemplate);
            imagePath = null; // Custom text overrides template image
        }

        console.log(`[Broadcaster] ⌨️ Đang soạn bài PR...`);

        // 7. Type post content (faster than comment but still human-like)
        await humanType(page, finalPost, config.BROADCASTER_TYPING_DELAY);

        // 7.5 Upload Image if present
        if (imagePath) {
            const absImagePath = path.resolve(__dirname, '..', '..', '..', imagePath);
            if (fs.existsSync(absImagePath)) {
                console.log(`[Broadcaster] 🖼️ Đang đính kèm ảnh: ${imagePath}`);
                try {
                    // Cố gắng tìm input type="file" bị ẩn của Facebook
                    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });

                    // Nhấp vào nút "Thêm ảnh/video" (aria-label="Photo/video" hoặc tương tự)
                    const photoBtnSelectors = [
                        'div[aria-label="Photo/video"]',
                        'div[aria-label="Ảnh/video"]',
                        'i[data-visualcompletion="css-img"][style*="background-position"]', // Icon ảnh
                        'div[role="button"]:has-text("Photo/Video")',
                        'div[role="button"]:has-text("Ảnh/video")'
                    ];

                    let clicked = false;
                    for (const sel of photoBtnSelectors) {
                        try {
                            const btn = await page.$(sel);
                            if (btn && await btn.isVisible()) {
                                await btn.click();
                                clicked = true;
                                break;
                            }
                        } catch { }
                    }

                    if (clicked) {
                        const fileChooser = await fileChooserPromise;
                        await fileChooser.setFiles(absImagePath);
                        console.log(`[Broadcaster] ✅ Upload ảnh thành công`);
                        await humanDelay(3000, 5000); // Wait for upload to process
                    } else {
                        console.warn(`[Broadcaster] ⚠️ Không tìm thấy nút tải ảnh`);
                    }
                } catch (err) {
                    console.warn(`[Broadcaster] ⚠️ Lỗi khi upload ảnh: ${err.message}`);
                }
            } else {
                console.warn(`[Broadcaster] ⚠️ Không tìm thấy file ảnh tại: ${absImagePath}`);
            }
        }

        // 8. Pause to "review" before posting
        await humanDelay(1500, 3000);

        // 9. Click Post/Đăng button
        let posted = false;
        for (const sel of config.SELECTORS.SUBMIT_POST) {
            try {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    posted = true;
                    break;
                }
            } catch { }
        }

        if (!posted) {
            console.warn(`[Broadcaster] ⚠️ Không tìm thấy nút Đăng/Post`);
            // Fallback: try keyboard shortcut
            try {
                await page.keyboard.press('Control+Enter');
                posted = true;
            } catch { }
        }

        if (posted) {
            console.log(`[Broadcaster] 🚀 ĐÃ LÊN SÓNG! Bài PR đã được đăng.`);
            await humanDelay(5000, 8000); // Wait for post to appear
            squadDB.logAction(account, 'post', groupUrl, true, finalPost.substring(0, 200));
            return true;
        }

        console.warn(`[Broadcaster] ❌ Không thể đăng bài`);
        return false;

    } catch (e) {
        console.error(`[Broadcaster] ❌ Gặp sự cố: ${e.message}`);
        squadDB.logAction(account, 'post', groupUrl, false, '');
        return false;
    }
}

module.exports = { broadcastPost };
