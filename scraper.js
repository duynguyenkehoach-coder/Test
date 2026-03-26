/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  FACEBOOK GROUP SCRAPER — Playwright Headless              ║
 * ║  Quét bài viết từ Facebook Groups, trả về mảng posts       ║
 * ╚═══════════════════════════════════════════════════════════╝
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Tiện ích ─────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 500));

function extractGroupId(url) {
    // Trường hợp 1: groups/123456
    let match = url.match(/groups\/([^/?]+)/);
    if (match) return match[1];
    
    // Trường hợp 2: share/g/ABCDEF
    match = url.match(/share\/g\/([^/?]+)/);
    if (match) return match[1];
    
    return null;
}

/**
 * Chuyển đổi link Google Drive share thành link tải trực tiếp
 */
function convertDriveLink(url) {
    if (url && url.includes('drive.google.com')) {
        const match = url.match(/[-\w]{25,}/);
        if (match) return `https://drive.google.com/uc?export=download&id=${match[0]}`;
    }
    return url;
}

// ── File JSON chống gửi trùng lặp ───────────────────────────────────────────
const SEEN_PATH = path.join(__dirname, 'seen_posts.json');

function loadSeenPosts() {
    try {
        if (fs.existsSync(SEEN_PATH)) {
            const data = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
            return new Set(data);
        }
    } catch { }
    return new Set();
}

function saveSeenPosts(seenSet) {
    try {
        // Chỉ giữ lại 5000 ID gần nhất để file không phình
        const arr = [...seenSet];
        const trimmed = arr.slice(-5000);
        fs.writeFileSync(SEEN_PATH, JSON.stringify(trimmed, null, 2));
    } catch (e) {
        console.error(`[Scraper] ⚠️ Lưu seen_posts thất bại: ${e.message}`);
    }
}

/**
 * Phân lọc và chuẩn hóa mảng cookies thành định dạng Playwright
 */
function normalizeCookies(rawArray) {
    if (!Array.isArray(rawArray)) return [];
    return rawArray
        .filter(c => c.name && c.value && (c.domain || c.host))
        .map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain || c.host || '.facebook.com',
            path: c.path || '/',
            httpOnly: !!c.httpOnly,
            secure: c.secure !== false,
            sameSite: c.sameSite === 'no_restriction' ? 'None'
                : c.sameSite === 'lax' ? 'Lax'
                : c.sameSite === 'strict' ? 'Strict' : 'None',
            ...(c.expirationDate ? { expires: c.expirationDate || c.expires } : {}),
        }));
}

/**
 * Load cookies từ file cookies.json hoặc .env FB_COOKIES
 * @returns {Array} Mảng cookies Playwright-compatible
 */
function loadCookies() {
    // Ưu tiên 1: File cookies.json (export từ extension)
    const cookieFile = path.join(__dirname, 'cookies.json');
    if (fs.existsSync(cookieFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
            const cookies = normalizeCookies(raw);
            if (cookies.length > 0) {
                console.log(`[Scraper] 🍪 Cookies từ cookies.json (${cookies.length} cookies)`);
                return cookies;
            }
        } catch (e) {
            console.error(`[Scraper] ❌ Đọc cookies.json thất bại: ${e.message}`);
        }
    }

    // Ưu tiên 2: Chuỗi cookie từ .env / GitHub Secrets
    if (config.FB_COOKIES) {
        const val = config.FB_COOKIES.trim();
        
        // Trường hợp 2.1: JSON Array
        if (val.startsWith('[') && val.endsWith(']')) {
            try {
                const raw = JSON.parse(val);
                const cookies = normalizeCookies(raw);
                if (cookies.length > 0) {
                    console.log(`[Scraper] 🍪 Cookies từ JSON string (${cookies.length} cookies)`);
                    return cookies;
                }
            } catch (e) {
                console.error(`[Scraper] ❌ Parse JSON từ FB_COOKIES thất bại: ${e.message}`);
            }
        }

        // Trường hợp 2.2: Định dạng chuỗi key=value
        if (val.includes('=')) {
            const cookies = val.split(';')
                .map(s => s.trim())
                .filter(Boolean)
                .map(pair => {
                    const [n, ...r] = pair.split('=');
                    return {
                        name: n.trim(),
                        value: r.join('=').trim(),
                        domain: '.facebook.com',
                        path: '/',
                        httpOnly: true,
                        secure: true,
                        sameSite: 'None',
                    };
                });
            if (cookies.length > 0) {
                console.log(`[Scraper] 🍪 Cookies từ String format (${cookies.length} cookies)`);
                return cookies;
            }
        }
    }

    console.error('[Scraper] ❌ Không tìm thấy cookies! Hãy tạo cookies.json hoặc điền FB_COOKIES trong .env');
    return [];
}

// ══════════════════════════════════════════════════════════════════════════════
// HÀM CHÍNH — Quét tất cả groups
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Quét tất cả Facebook Groups trong danh sách
 * @param {Array} groups - Mảng {name, url}
 * @param {Function} onNewPost - Callback gọi khi có bài mới (post, browser) => Promise
 * @returns {Array} Mảng bài viết mới (đã lọc trùng)
 */
async function scrapeGroups(groups, onNewPost = null) {
    if (!groups || groups.length === 0) {
        console.log('[Scraper] ⚠️ Không có group nào để quét');
        return [];
    }

    const cookies = loadCookies();
    if (cookies.length === 0) return [];

    const seenPosts = loadSeenPosts();
    const allPosts = [];
    let browser = null;

    try {
        // Launch browser — tối ưu RAM
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--js-flags=--max-old-space-size=400',
            ],
        });
        console.log('[Scraper] 🌐 Trình duyệt đã khởi động');

        // Tạo context với cookies
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'vi-VN',
            timezoneId: 'Asia/Ho_Chi_Minh',
        });
        await context.addCookies(cookies);

        // Block hình ảnh, CSS, fonts để tiết kiệm RAM & băng thông
        await context.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                return route.abort();
            }
            return route.continue();
        });

        // Validate session
        const testPage = await context.newPage();
        let sessionValid = false;
        try {
            await testPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
            const hasNav = await testPage.waitForSelector(
                'div[role="navigation"], div[aria-label="Facebook"], a[aria-label="Facebook"]',
                { timeout: 10000 }
            ).catch(() => null);
            const testUrl = testPage.url();
            sessionValid = hasNav && !testUrl.includes('/login') && !testUrl.includes('checkpoint');
        } catch (e) {
            console.error(`[Scraper] ⚠️ Kiểm tra session lỗi: ${e.message}`);
        }
        await testPage.close();

        if (!sessionValid) {
            console.error('[Scraper] ❌ Session Facebook không hợp lệ! Hãy cập nhật cookies.');
            await browser.close();
            return [];
        }
        console.log('[Scraper] ✅ Session Facebook hợp lệ!');

        // Auto-renew cookies sau khi validate
        try {
            const freshCookies = await context.cookies();
            const fbCookies = freshCookies.filter(c => c.domain?.includes('facebook'));
            if (fbCookies.length > 0) {
                const cookieFile = path.join(__dirname, 'cookies.json');
                if (fs.existsSync(cookieFile)) {
                    fs.writeFileSync(cookieFile, JSON.stringify(fbCookies, null, 2));
                    console.log(`[Scraper] 🔄 Cookies tự động làm mới (${fbCookies.length})`);
                }
            }
        } catch { }

        // Quét từng group
        const page = await context.newPage();
        const MAX_AGE_DAYS = config.MAX_POST_AGE_DAYS;

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const groupId = extractGroupId(group.url);
            if (!groupId) {
                console.warn(`[Scraper] ⚠️ URL không hợp lệ: ${group.url}`);
                continue;
            }

            try {
                // Delay giữa các groups (giả lập người thật)
                if (i > 0) {
                    const jitter = 8000 + Math.random() * 12000;
                    console.log(`[Scraper] 😴 Chờ ${(jitter / 1000).toFixed(1)}s...`);
                    await delay(jitter);
                    // Nghỉ dài hơn mỗi 5 groups
                    if (i % 5 === 0) {
                        const breakTime = 20000 + Math.random() * 15000;
                        console.log(`[Scraper] ☕ Nghỉ giải lao: ${(breakTime / 1000).toFixed(0)}s`);
                        await delay(breakTime);
                    }
                }

                console.log(`[Scraper] [${i + 1}/${groups.length}] 📥 ${group.name}`);
                
                // Nếu là link share, ta phải truy cập link share trước để FB redirect
                let targetUrl = group.url;
                const isShareLink = group.url.includes('/share/g/');
                
                if (!isShareLink) {
                    const groupId = extractGroupId(group.url);
                    if (groupId) {
                        targetUrl = `https://www.facebook.com/groups/${groupId}?sorting_setting=CHRONOLOGICAL`;
                    }
                }

                console.log(`[Scraper] 🔗 URL mục tiêu: ${targetUrl}`);
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                await delay(3000 + Math.random() * 2000);

                // Nếu là link share, sau khi load xong ta thử ép sorting bằng URL hiện tại
                if (isShareLink) {
                    const currentUrl = page.url();
                    if (currentUrl.includes('/groups/') && !currentUrl.includes('sorting_setting')) {
                        const sortedUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL';
                        console.log(`[Scraper] 🔄 Chuyển hướng sang link đã ép sorting: ${sortedUrl}`);
                        await page.goto(sortedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                        await delay(2000);
                    }
                }

                // Kiểm tra checkpoint / login
                const url = page.url();
                if (url.includes('checkpoint')) {
                    console.error(`[Scraper] 🚨 ${group.name}: CHECKPOINT! Dừng quét.`);
                    break;
                }
                if (url.includes('/login')) {
                    console.warn(`[Scraper] 🔒 ${group.name}: Bị chuyển về trang login — bỏ qua`);
                    continue;
                }

                // Chờ feed hiện ra
                let hasFeed = false;
                try {
                    await page.waitForSelector('div[role="feed"]', { timeout: 12000 });
                    hasFeed = true;
                } catch {
                    console.warn(`[Scraper] ⚠️ ${group.name}: Không thấy feed — bỏ qua`);
                }
                if (!hasFeed) continue;

                // ═══ CUỘN TRANG THÔNG MINH ═══
                let noGrowth = 0, prevCnt = 0;

                for (let s = 0; s < 25; s++) {
                    // Click "Xem thêm" / "See more"
                    try {
                        await page.evaluate(() => {
                            const els = Array.from(document.querySelectorAll('div[role="button"], span'));
                            for (const el of els) {
                                const t = el.innerText?.trim()?.toLowerCase();
                                if (t === 'see more' || t === 'xem thêm') {
                                    try { el.click(); } catch {}
                                }
                            }
                        });
                    } catch { }

                    // Cuộn xuống
                    await page.evaluate(() => window.scrollBy(0, 1000 + Math.random() * 500));
                    await delay(1200 + Math.random() * 800);

                    // Kiểm tra số bài + bài quá cũ
                    const scrollStatus = await page.evaluate((maxDays) => {
                        const feed = document.querySelector('div[role="feed"]');
                        if (!feed) return { cnt: 0, stopEarly: false };
                        const articles = feed.querySelectorAll(':scope > div');
                        let cnt = 0, lastTime = '';

                        // Duyệt ngược để tìm bài cuối cùng có mốc thời gian
                        for (let i = articles.length - 1; i >= 0; i--) {
                            const txt = articles[i].innerText || '';
                            if (txt.length > 20) {
                                cnt++;
                                if (!lastTime) {
                                    // Ưu tiên tìm trong thẻ aria-label trước
                                    const timeEl = articles[i].querySelector('span[aria-labelledby], span[aria-label]');
                                    if (timeEl) {
                                        const label = timeEl.getAttribute('aria-label') || '';
                                        if (label.match(/\d+/) && (label.includes('phút') || label.includes('giờ') || label.includes('ngày') || label.includes('m') || label.includes('h'))) {
                                            lastTime = label;
                                        }
                                    }
                                    if (!lastTime) {
                                        for (const sp of articles[i].querySelectorAll('span')) {
                                            const t = sp.textContent?.trim();
                                            if (t && t.match(/^\d+[mhdw]$|^just now$|^yesterday$|^hôm qua$|^\d+\s*(phút|giờ|ngày|tuần|năm|tháng)/i)) {
                                                lastTime = t; break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let stopEarly = false;
                        if (lastTime) {
                            const s = lastTime.toLowerCase();
                            // Chỉ dừng nếu thấy dấu hiệu của bài cực cũ (tuần, tháng, năm) hoặc quá ngày config
                            if (s.match(/w\b|wk|week|tuần|tháng|month|năm|year/)) stopEarly = true;
                            const dayMatch = s.match(/(\d+)\s*(d\b|day|ngày)/);
                            if (dayMatch && parseInt(dayMatch[1]) > maxDays) stopEarly = true;
                        }
                        return { cnt, stopEarly, lastTime };
                    }, MAX_AGE_DAYS);

                    if (scrollStatus.cnt >= config.MAX_POSTS_PER_GROUP) break;
                    if (scrollStatus.stopEarly) {
                        console.log(`[Scraper] 🛑 ${group.name}: Bài cũ [${scrollStatus.lastTime}] — dừng cuộn`);
                        break;
                    }
                    if (scrollStatus.cnt === prevCnt) {
                        noGrowth++;
                        if (noGrowth >= 3) break;
                    } else { noGrowth = 0; }
                    prevCnt = scrollStatus.cnt;
                }

                // Click nốt "See more" trước khi extract
                try {
                    await page.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('div[role="button"], span'));
                        for (const el of els) {
                            const t = el.innerText?.trim()?.toLowerCase();
                            if (t === 'see more' || t === 'xem thêm') {
                                try { el.click(); } catch {}
                            }
                        }
                    });
                    await delay(500);
                } catch { }

                // ═══ TRÍCH XUẤT BÀI VIẾT TỪ DOM ═══
                const gPosts = await page.evaluate(({ gName, gUrl, maxAgeDays }) => {
                    const feed = document.querySelector('div[role="feed"]');
                    if (!feed) return [];

                    function parseRelativeTime(timeStr) {
                        if (!timeStr) return null;
                        const s = timeStr.trim().toLowerCase();
                        if (s.includes('just now') || s.includes('vừa xong') || s.includes('1 phút')) return 0.01;
                        let m = s.match(/(\d+)\s*(m\b|min|phút)/); if (m) return parseInt(m[1]) / 60;
                        m = s.match(/(\d+)\s*(h\b|hr|giờ)/); if (m) return parseInt(m[1]);
                        m = s.match(/(\d+)\s*(d\b|day|ngày)/); if (m) return parseInt(m[1]) * 24;
                        m = s.match(/(\d+)\s*(w\b|wk|tuần)/); if (m) return parseInt(m[1]) * 24 * 7;
                        m = s.match(/(\d+)\s*(tháng|month)/); if (m) return parseInt(m[1]) * 24 * 30;
                        if (s.includes('yesterday') || s.includes('hôm qua')) return 24;
                        return null;
                    }

                    const articles = feed.querySelectorAll(':scope > div');
                    const res = [];
                    const seenUrls = new Set();
                    const now = Date.now();

                    articles.forEach(a => {
                        const txt = a.innerText || '';
                        if (txt.length < 20) return; // Giảm xuống 20 để không bỏ sót bài ngắn

                        // Lấy URL bài viết
                        const links = Array.from(a.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]'));
                        let rawUrl = links[0]?.href || '';
                        if (!rawUrl) {
                            for (const al of a.querySelectorAll('a[href]')) {
                                const h = al.href || '';
                                if (h.includes('facebook.com') && (h.includes('/posts/') || h.includes('story_fbid') || h.includes('/permalink/'))) {
                                    rawUrl = h; break;
                                }
                            }
                        }
                        const postUrl = rawUrl.split('?')[0];
                        if (postUrl && seenUrls.has(postUrl)) return;
                        if (postUrl) seenUrls.add(postUrl);

                        // Lấy thời gian chuẩn hơn (ưu tiên các thẻ aria-label hoặc các text đặc thù)
                        let timeStr = '';
                        // Thử tìm trong các thẻ có aria-label chứa thời gian
                        const timeEl = a.querySelector('span[aria-labelledby], span[aria-label]');
                        if (timeEl) {
                            const label = timeEl.getAttribute('aria-label') || '';
                            if (label.match(/\d+/) && (label.includes('phút') || label.includes('giờ') || label.includes('ngày') || label.includes('m') || label.includes('h'))) {
                                timeStr = label;
                            }
                        }

                        if (!timeStr) {
                            for (const sp of a.querySelectorAll('span, a')) {
                                const t = sp.textContent?.trim();
                                if (t && t.match(/^\d+[mhdw]$|^just now$|^yesterday$|^hôm qua$|^\d+\s*(phút|giờ|ngày|tuần)/i)) {
                                    timeStr = t; break;
                                }
                            }
                        }
                        if (!timeStr) {
                            const abbr = a.querySelector('abbr');
                            if (abbr) timeStr = abbr.textContent?.trim() || '';
                        }

                        // Lọc bài quá cũ
                        const ageHours = parseRelativeTime(timeStr);
                        if (ageHours !== null && ageHours / 24 > maxAgeDays) return;

                        // Lấy tên tác giả
                        let author = '';
                        const profileImg = a.querySelector('image, img[src*="scontent"]');
                        if (profileImg) {
                            const alt = profileImg.getAttribute('alt') || '';
                            if (alt.length > 1 && alt.length < 80 && !alt.match(/photo|hình|image|like/i)) {
                                author = alt.replace(/'s profile.*/i, '').trim();
                            }
                        }
                        if (!author) {
                            const headerEl = a.querySelector('a strong, h2 a, h3 a, strong');
                            if (headerEl) {
                                const name = headerEl.innerText?.trim();
                                if (name && name.length > 1 && name.length < 60) author = name;
                            }
                        }

                        // Lấy nội dung chính (div[dir="auto"] dài nhất)
                        let content = '';
                        const dirAutos = Array.from(a.querySelectorAll('div[dir="auto"]'));
                        
                        // Lấy các khối text thực sự
                        const textBlocks = dirAutos
                            .map(da => (da.innerText || '').trim())
                            .filter(t => t.length > 0 && !t.match(/^facebook$/i));
                        
                        // Ghép lại và lọc các chuỗi rác
                        if (textBlocks.length > 0) {
                            content = textBlocks.join('\n');
                        } else {
                            // Fallback nếu không có dir="auto"
                            content = (a.innerText || '').split('\n')
                                .filter(line => line.trim().length > 10 && !line.includes('Facebook'))
                                .slice(0, 10)
                                .join('\n');
                        }

                        // Làm sạch content: Bỏ qua các dòng lặp lại "Facebook" hoặc link rác
                        content = content.split('\n')
                            .filter(line => {
                                const l = line.trim();
                                if (l.toLowerCase() === 'facebook') return false;
                                if (l.match(/^(like|comment|share|bình luận|chia sẻ|thích)$/i)) return false;
                                return true;
                            })
                            .join('\n')
                            .substring(0, 1500);

                        res.push({
                            group_name: gName,
                            group_url: gUrl,
                            post_url: postUrl || gUrl,
                            author_name: author || 'Ẩn danh',
                            content: content.trim() || 'Không có nội dung văn bản',
                            time_raw: timeStr,
                            age_hours: ageHours,
                            scraped_at: new Date().toISOString(),
                        });
                    });
                    return res;
                }, { gName: group.name, gUrl: group.url, maxAgeDays: MAX_AGE_DAYS });

                // Lọc trùng bằng seen_posts
                const newPosts = gPosts.filter(p => {
                    const id = p.post_url || p.content.substring(0, 100);
                    if (seenPosts.has(id)) return false;
                    seenPosts.add(id);
                    return true;
                });

                // Xử lý bài mới ngay lập tức (ví dụ: bình luận)
                if (onNewPost && newPosts.length > 0) {
                    for (const p of newPosts) {
                        try {
                            await onNewPost(p, browser);
                        } catch (err) {
                            console.error(`[Scraper] ❌ Lỗi callback bài mới: ${err.message}`);
                        }
                    }
                }

                allPosts.push(...newPosts);
                console.log(`[Scraper] ✅ ${group.name}: ${gPosts.length} bài (${newPosts.length} mới)`);

            } catch (err) {
                console.error(`[Scraper] ❌ ${group.name}: ${err.message.substring(0, 80)}`);
            }

            // Log RAM mỗi 5 groups
            if (i > 0 && i % 5 === 0) {
                const m = process.memoryUsage();
                console.log(`[Scraper] 💾 RAM: ${Math.round(m.rss / 1024 / 1024)}MB`);
            }
        }

        await page.close();
        await context.close();
    } catch (err) {
        console.error(`[Scraper] 💥 Lỗi nghiêm trọng: ${err.message}`);
    } finally {
        try { if (browser) await browser.close(); } catch { }
    }

    // Lưu danh sách đã quét
    saveSeenPosts(seenPosts);

    console.log(`[Scraper] 🏁 Hoàn tất: ${allPosts.length} bài viết mới từ ${groups.length} groups`);
    return allPosts;
}

/**
 * Thực hiện bình luận vào một bài viết
 * @param {Object} browser - Browser instance
 * @param {string} postUrl - URL bài viết
 * @param {string} commentText - Nội dung bình luận
 * @returns {Promise<boolean>} Thành công hay thất bại
 */
async function commentOnPost(browser, postUrl, commentText, imagePath = null) {
    if (!commentText && !imagePath) return false;

    let page = null;
    let downloadedTempFile = null;
    try {
        const cookies = loadCookies();
        const context = await browser.newContext();
        await context.addCookies(cookies);
        
        page = await context.newPage();
        console.log(`[Scraper] 💬 Đang vào bài viết để bình luận: ${postUrl}`);
        
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await delay(5000);
        
        // Cuộn xuống để đảm bảo thành phần được load
        await page.mouse.wheel(0, 400);
        await delay(2000);

        // Tìm ô bình luận (thử nhiều selector phổ biến)
        const commentSelectors = [
            'div[aria-label="Write a comment"]',
            'div[aria-label="Viết bình luận…"]',
            'div[aria-label="Viết bình luận"]',
            'div[role="textbox"]'
        ];

        let commentBox = null;
        for (const selector of commentSelectors) {
            commentBox = await page.waitForSelector(selector, { timeout: 15000, state: 'visible' }).catch(() => null);
            if (commentBox) {
                await commentBox.scrollIntoViewIfNeeded();
                break;
            }
        }

        if (!commentBox) {
            console.warn(`[Scraper] ⚠️ Không tìm thấy ô bình luận cho bài: ${postUrl}`);
            await context.close();
            return false;
        }

        // Xử lý upload ảnh nếu có
        if (imagePath) {
            try {
                let fullPath = '';
                // Thử tải xuống nếu là URL (http:// hoặc https://)
                if (imagePath.startsWith('http')) {
                    const axios = require('axios');
                    const os = require('os');
                    
                    const directUrl = convertDriveLink(imagePath);
                    console.log(`[Scraper] 📥 Đang tải ảnh từ URL: ${directUrl}`);
                    
                    const response = await axios({
                        url: directUrl,
                        method: 'GET',
                        responseType: 'stream',
                        timeout: 15000
                    });
                    
                    const ext = path.extname(new URL(imagePath).pathname) || '.jpg';
                    downloadedTempFile = path.join(os.tmpdir(), `fb_comment_img_${Date.now()}${ext}`);
                    
                    const writer = fs.createWriteStream(downloadedTempFile);
                    response.data.pipe(writer);
                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });
                    fullPath = downloadedTempFile;
                } else {
                    // Giải quyết đường dẫn tuyệt đối cho file cục bộ
                    fullPath = path.isAbsolute(imagePath) ? imagePath : path.resolve(__dirname, imagePath);
                }
                
                if (fs.existsSync(fullPath)) {
                    console.log(`[Scraper] 📸 Đang tải lên ảnh: ${path.basename(fullPath)}`);
                    
                    // Click vào ô bình luận bằng JS để chắc chắn (vượt qua lỗi not visible)
                    await page.evaluate(el => el.click(), commentBox).catch(() => {});
                    await delay(1500);

                    // Thử tìm file input
                    let fileInput = await page.$('input[type="file"][accept*="image"]');
                    
                    if (!fileInput) {
                        // Nếu không thấy, thử tìm nút "Đính kèm ảnh" để kích hoạt nó hiện ra
                        const photoBtnSelectors = [
                            'div[aria-label="Attach a photo or video"]',
                            'div[aria-label="Đính kèm ảnh hoặc video"]',
                            'div[aria-label="Đính kèm ảnh"]',
                            'div[aria-label="Chọn ảnh/video"]',
                            'i[class*="camera"]'
                        ];
                        for (const sel of photoBtnSelectors) {
                            const btn = await page.$(sel);
                            if (btn) {
                                await btn.click({ force: true });
                                await delay(1500);
                                fileInput = await page.$('input[type="file"][accept*="image"]');
                                if (fileInput) break;
                            }
                        }
                    }
                    
                    if (fileInput) {
                        await fileInput.setInputFiles(fullPath);
                        // Chờ một chút để ảnh upload và hiện preview
                        await delay(3000 + Math.random() * 2000);
                    } else {
                        console.warn('[Scraper] ⚠️ Không tìm thấy nút tải ảnh (input file)');
                    }
                } else {
                    console.warn(`[Scraper] ⚠️ File ảnh không tồn tại: ${fullPath}`);
                }
            } catch (err) {
                console.error(`[Scraper] ⚠️ Lỗi khi xử lý tải/upload ảnh: ${err.message}`);
            }
        }

        // Nhập bình luận
        if (commentText) {
            await page.evaluate(el => el.click(), commentBox).catch(() => {});
            await delay(1000);
            await page.keyboard.type(commentText, { delay: 80 });
            await delay(1000);
        }

        await page.keyboard.press('Enter');
        // Chờ lâu hơn một chút nếu có ảnh để đảm bảo gửi xong
        await delay(imagePath ? 6000 : 4000);

        console.log(`[Scraper] ✅ Đã gửi bình luận${imagePath ? ' kèm ảnh' : ''}: "${(commentText || '').substring(0, 30)}..."`);
        await context.close();
        if (downloadedTempFile && fs.existsSync(downloadedTempFile)) {
            try { fs.unlinkSync(downloadedTempFile); } catch (e) {}
        }
        return true;
    } catch (err) {
        console.error(`[Scraper] ❌ Lỗi khi bình luận: ${err.message}`);
        if (page) await page.context().close();
        if (downloadedTempFile && fs.existsSync(downloadedTempFile)) {
            try { fs.unlinkSync(downloadedTempFile); } catch (e) {}
        }
        return false;
    }
}

module.exports = { scrapeGroups, commentOnPost };
