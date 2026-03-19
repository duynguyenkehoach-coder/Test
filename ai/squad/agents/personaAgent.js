/**
 * 🎭 PERSONA AGENT — THẾ THÂN HOÀN HẢO (PASSIVE-ONLY)
 * 
 * Triết lý: "Chỉ Tiêu Thụ - Không Sản Xuất Dư Thừa"
 * Chỉ thực hiện hành động thụ động (Lướt, Like, Xem Story).
 * Tuyệt đối KHÔNG tạo vết xước dữ liệu (Không comment/post status).
 * Trust Score được dành 100% cho Sniper (comment lead) và Broadcaster (post PR).
 * 
 * Chống DOM Fingerprinting:
 *   - Dùng page.mouse.wheel() thay vì window.scrollTo (mô phỏng vật lý)
 *   - Dùng aria-label selectors thay vì CSS classes (kháng FB DOM changes)
 *   - Random delay không có quy luật (không bao giờ lặp lại timing)
 * 
 * @module squad/agents/personaAgent
 */

const squadDB = require('../core/squadDB');

// ═══════════════════════════════════════════════════════
// Random Delay — Tạo khoảng dừng phi quy luật
// ═══════════════════════════════════════════════════════

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function wait(page, min, max) {
    await page.waitForTimeout(randomDelay(min, max));
}

// ═══════════════════════════════════════════════════════
// Human Scroll — Cuộn chuột bằng "Vật lý"
// Dùng mouse.wheel() thay vì scrollTo — chống nhận diện
// ═══════════════════════════════════════════════════════

async function humanScroll(page, scrolls = 3) {
    for (let i = 0; i < scrolls; i++) {
        const scrollDistance = randomDelay(300, 700);
        await page.mouse.wheel(0, scrollDistance);
        await wait(page, 1500, 4000); // Dừng lại "đọc bài"
    }
}

// ═══════════════════════════════════════════════════════
// 🏠 1. LƯỚT FEED (Feed Browsing)
// Hành vi cơ bản nhất — tăng Trust cực nhanh, rủi ro = 0
// ═══════════════════════════════════════════════════════

async function browseNewsfeed(page, tag, durationSec = 30) {
    console.log(`[Persona:${tag}] 🏠 Đang lướt Newsfeed hóng biến...`);
    try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await wait(page, 2000, 5000); // Mở app ra phải ngó nghiêng vài giây

        const scrolls = Math.floor(durationSec / 4);
        await humanScroll(page, scrolls);
        console.log(`[Persona:${tag}] 🏠 Đã lướt xong (${scrolls} scrolls, ~${durationSec}s)`);
    } catch (e) {
        console.warn(`[Persona:${tag}] ⚠️ Lỗi lướt Feed: ${e.message.substring(0, 60)}`);
    }
}

// ═══════════════════════════════════════════════════════
// 👍 2. LIKE DẠO (React Randomly)
// Like 1-2 bài trên feed bằng aria-label (kháng CSS change)
// ═══════════════════════════════════════════════════════

async function reactToRandomPosts(page, tag) {
    console.log(`[Persona:${tag}] 👍 Chuẩn bị thả Like dạo...`);
    try {
        // Tìm nút Like chưa bấm — dùng aria-label (kháng CSS class thay đổi)
        const likeButtons = page.locator(
            'div[aria-label="Thích"], div[aria-label="Like"]'
        );

        const count = await likeButtons.count();
        if (count > 0) {
            // Chọn ngẫu nhiên 1 bài trong 3 bài đầu tiên
            const randomIndex = Math.floor(Math.random() * Math.min(count, 3));
            const targetButton = likeButtons.nth(randomIndex);

            if (await targetButton.isVisible()) {
                // Kiểm tra chưa like (aria-pressed)
                const pressed = await targetButton.getAttribute('aria-pressed').catch(() => null);
                if (pressed === 'true') {
                    console.log(`[Persona:${tag}] 🤷 Bài này đã Like rồi, bỏ qua.`);
                    return;
                }

                await targetButton.hover(); // Di chuột vào trước
                await wait(page, 500, 1500);
                await targetButton.click();
                console.log(`[Persona:${tag}] ❤️ Đã thả 1 Like tự nhiên.`);

                squadDB.logAction(tag, 'like', 'newsfeed', true, '');
                await wait(page, 2000, 4000); // Bấm xong phải nhìn thành quả
            }
        } else {
            console.log(`[Persona:${tag}] 🤷 Không thấy bài nào hợp nhãn để Like.`);
        }
    } catch (e) {
        console.warn(`[Persona:${tag}] ⚠️ Lỗi khi thả Like: Bỏ qua để an toàn.`);
    }
}

// ═══════════════════════════════════════════════════════
// 👀 3. XEM STORY (View Stories)
// Click story, xem 5-8s, đóng — đa dạng touchpoint
// ═══════════════════════════════════════════════════════

async function viewStories(page, tag) {
    console.log(`[Persona:${tag}] 👀 Đang bấm vào xem Story...`);
    try {
        // Nhận diện Story dựa trên aria-label (kháng DOM change)
        const storyCard = page.locator(
            'div[aria-label*="Story"], div[aria-label*="Tin"]'
        ).first();

        if (await storyCard.isVisible({ timeout: 3000 }).catch(() => false)) {
            await storyCard.click();
            console.log(`[Persona:${tag}] 🍿 Đang xem Story (5-8s)...`);
            await wait(page, 5000, 8000);

            // Tìm nút đóng Story
            const closeButton = page.locator(
                'div[aria-label="Đóng"], div[aria-label="Close"]'
            ).first();

            if (await closeButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                await closeButton.click();
            } else {
                // Nếu kẹt thì navigate về home
                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
            }

            console.log(`[Persona:${tag}] 👀 Đã xem xong Story.`);
            squadDB.logAction(tag, 'story_view', 'stories', true, '');
        } else {
            console.log(`[Persona:${tag}] 🤷 Không tìm thấy Story nào.`);
        }
    } catch (e) {
        console.warn(`[Persona:${tag}] ⚠️ Story lỗi — bỏ qua an toàn.`);
        // Navigate về home nếu bị kẹt trong story viewer
        try { await page.goto('https://www.facebook.com/', { timeout: 10000 }); } catch { }
    }
}

// ═══════════════════════════════════════════════════════
// 🎼 ORCHESTRATOR — Chạy kịch bản Persona
// ═══════════════════════════════════════════════════════

/**
 * Run a Persona camouflage session.
 * 
 * @param {Page} page - Playwright page (same context as scraper)
 * @param {string} tag - Account identifier for logging
 * @param {'light'|'medium'} intensity
 *   - light: before scan → feed browse + 30% chance like
 *   - medium: after scan → browse + 40% story + 50% like
 */
async function runPersonaSession(page, tag, intensity = 'light') {
    console.log(`\n[Persona:${tag}] ═══ NGUỴ TRANG [${intensity.toUpperCase()}] ═══`);

    try {
        // Luôn lướt Feed trước (hành vi cơ bản nhất)
        const browseTime = intensity === 'light' ? randomDelay(20, 35) : randomDelay(30, 45);
        await browseNewsfeed(page, tag, browseTime);

        if (intensity === 'light') {
            // LIGHT: Trước scan → Chỉ lướt + 30% chance like
            if (Math.random() < 0.3) {
                await reactToRandomPosts(page, tag);
            }
        } else if (intensity === 'medium') {
            // MEDIUM: Sau scan → Thư giãn
            if (Math.random() < 0.4) {
                await viewStories(page, tag);
            }
            await humanScroll(page, 2); // Cuộn thêm
            if (Math.random() < 0.5) {
                await reactToRandomPosts(page, tag);
            }
        }

        console.log(`[Persona:${tag}] ═══ Nguỵ trang hoàn tất ═══\n`);
    } catch (e) {
        console.warn(`[Persona:${tag}] ⚠️ Persona error (safe): ${e.message.substring(0, 60)}`);
    }
}

module.exports = { runPersonaSession, browseNewsfeed, reactToRandomPosts, viewStories };
