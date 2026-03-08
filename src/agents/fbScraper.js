/**
 * THG Lead Gen — Self-Hosted Facebook Scraper (Playwright Login)
 * 
 * Architecture: Playwright Stealth → www.facebook.com → Auto Login → Scrape Feed
 * 
 * Flow:
 * 1. Launch headless Chrome with stealth plugin
 * 2. Login with FB_EMAIL + FB_PASSWORD → save session cookies
 * 3. Reuse saved session for subsequent requests
 * 4. Extract posts via page.evaluate() on rendered React DOM
 * 5. Output format 100% compatible with SociaVault
 * 
 * @module agents/fbScraper
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pool } = require('../proxy/proxyPool');
const { generateFingerprint } = require('../proxy/fingerprint');

chromium.use(StealthPlugin());

const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 1500));
const FB_URL = 'https://www.facebook.com';
const COOKIES_PATH = path.join(__dirname, '..', '..', 'data', 'fb_session.json');

const FB_EMAIL = process.env.FB_EMAIL || '';
const FB_PASSWORD = process.env.FB_PASSWORD || '';

// ═══════════════════════════════════════════════════════
// Free Proxy Fetcher
// ═══════════════════════════════════════════════════════

async function fetchFreeProxies() {
    const sources = [
        {
            name: 'ProxyScrape',
            url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=elite',
            parse: (text) => text.trim().split('\n').filter(Boolean).map(line => `http://${line.trim()}`),
        },
    ];
    const all = [];
    for (const s of sources) {
        try {
            const r = await axios.get(s.url, { timeout: 10000, transformResponse: [d => d] });
            const p = s.parse(r.data);
            all.push(...p);
            console.log(`[FBScraper] 📡 ${s.name}: ${p.length} proxies`);
        } catch (e) {
            console.warn(`[FBScraper] ⚠️ ${s.name}: ${e.message}`);
        }
    }
    return [...new Set(all)];
}

async function loadFreeProxies() {
    if (!pool.loaded) await pool.load();
    if (pool.getActiveCount() >= 3) return;
    const urls = await fetchFreeProxies();
    if (urls.length > 0) {
        pool.addBulk(urls, 'free', 'US');
        await pool.save();
    }
}

// ═══════════════════════════════════════════════════════
// Browser + Session Manager
// ═══════════════════════════════════════════════════════

let activeBrowser = null;
let activeContext = null;
let isLoggedIn = false;
let sessionAge = 0;
const MAX_SESSION_AGE = 30;

/**
 * Save session cookies to file for reuse
 */
async function saveSession(context) {
    try {
        const cookies = await context.cookies();
        fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        console.log(`[FBScraper] 💾 Session saved (${cookies.length} cookies)`);
    } catch (e) {
        console.warn(`[FBScraper] ⚠️ Save session failed: ${e.message}`);
    }
}

/**
 * Load saved session cookies
 */
function loadSession() {
    try {
        if (fs.existsSync(COOKIES_PATH)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
            console.log(`[FBScraper] 📂 Loaded saved session (${cookies.length} cookies)`);
            return cookies;
        }
    } catch (e) {
        console.warn(`[FBScraper] ⚠️ Load session failed: ${e.message}`);
    }
    return null;
}

/**
 * Login to Facebook via Playwright
 */
async function loginToFacebook(page) {
    if (!FB_EMAIL || !FB_PASSWORD) {
        throw new Error('FB_EMAIL and FB_PASSWORD required for self-hosted mode');
    }

    console.log(`[FBScraper] 🔐 Logging in as ${FB_EMAIL}...`);

    await page.goto(`${FB_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);

    // Fill email
    const emailInput = await page.$('input[name="email"], input#email');
    if (emailInput) {
        await emailInput.click();
        await emailInput.fill(FB_EMAIL);
    } else {
        console.error('[FBScraper] ❌ Email input not found');
        return false;
    }
    await delay(800);

    // Fill password
    const passInput = await page.$('input[name="pass"], input#pass');
    if (passInput) {
        await passInput.click();
        await passInput.fill(FB_PASSWORD);
    } else {
        console.error('[FBScraper] ❌ Password input not found');
        return false;
    }
    await delay(800);

    // Submit via keyboard Enter (most reliable — works regardless of button visibility)
    await passInput.press('Enter');
    console.log('[FBScraper] ⏳ Waiting for login response...');
    await delay(8000);

    // Check result
    const currentUrl = page.url();
    console.log(`[FBScraper] 📍 Post-login URL: ${currentUrl}`);

    // Save debug screenshot
    try {
        const fs = require('fs');
        fs.mkdirSync(path.join(__dirname, '..', '..', 'data'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '..', '..', 'data', 'fb_login_debug.png') });
        console.log('[FBScraper] 📸 Debug screenshot saved to data/fb_login_debug.png');
    } catch { }

    // Handle checkpoint / 2FA
    if (currentUrl.includes('checkpoint') || currentUrl.includes('two_step')) {
        console.log(`[FBScraper] ⚠️ 2FA/Checkpoint at: ${currentUrl}`);

        // Try clicking approve/continue buttons
        for (const text of ['Continue', 'Tiếp tục', 'This was me', 'Tôi đã đăng nhập', 'Submit', 'Gửi']) {
            try {
                const btn = await page.$(`button:has-text("${text}"), input[value="${text}"]`);
                if (btn) {
                    await btn.click({ force: true });
                    console.log(`[FBScraper] 🔘 Clicked: "${text}"`);
                    await delay(5000);
                    break;
                }
            } catch { }
        }

        const newUrl = page.url();
        if (newUrl.includes('checkpoint') || newUrl.includes('login')) {
            console.error(`[FBScraper] ❌ Stuck at checkpoint: ${newUrl}`);
            console.error('[FBScraper] 💡 Tip: Try approving login from your phone Facebook app');
            return false;
        }
    }

    // Handle wrong password
    if (currentUrl.includes('/login') && !currentUrl.includes('checkpoint')) {
        const errorText = await page.evaluate(() => {
            const errDiv = document.querySelector('div[role="alert"], div._9ay7');
            return errDiv?.innerText || '';
        });
        if (errorText) {
            console.error(`[FBScraper] ❌ Login error: ${errorText}`);
            return false;
        }
    }

    // Success: if we're not on login page anymore
    if (!currentUrl.includes('/login')) {
        console.log(`[FBScraper] ✅ Login successful!`);
        isLoggedIn = true;

        // Wait for home page to load
        await delay(3000);
        return true;
    }

    console.error(`[FBScraper] ❌ Login failed — still on login page`);
    return false;
}

/**
 * Get or create an authenticated browser context
 */
async function getAuthContext() {
    sessionAge++;

    // Rotate browser session periodically
    if (activeBrowser && sessionAge > MAX_SESSION_AGE) {
        console.log('[FBScraper] 🔄 Rotating browser session...');
        if (activeContext) await saveSession(activeContext);
        try { await activeBrowser.close(); } catch { }
        activeBrowser = null;
        activeContext = null;
        isLoggedIn = false;
        sessionAge = 0;
    }

    if (activeContext && isLoggedIn) return activeContext;

    // Build launch options
    const launchOptions = { headless: true };

    // Proxy support
    if (pool.loaded && pool.hasProxies()) {
        const best = pool.getBestProxy();
        if (best) {
            try {
                const pUrl = new URL(best.proxyUrl);
                launchOptions.proxy = {
                    server: `${pUrl.protocol}//${pUrl.hostname}:${pUrl.port}`,
                };
                if (pUrl.username) {
                    launchOptions.proxy.username = decodeURIComponent(pUrl.username);
                    launchOptions.proxy.password = decodeURIComponent(pUrl.password);
                }
            } catch { }
        }
    }

    const fp = generateFingerprint({ region: 'US' });

    activeBrowser = await chromium.launch(launchOptions);
    activeContext = await activeBrowser.newContext({
        userAgent: fp.userAgent,
        viewport: fp.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Try loading saved session first
    const savedCookies = loadSession();
    if (savedCookies && savedCookies.length > 0) {
        await activeContext.addCookies(savedCookies);
        console.log(`[FBScraper] 🍪 Restored saved session`);

        // Verify session is still valid
        const page = await activeContext.newPage();
        await page.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(3000);

        const url = page.url();
        const hasNav = await page.$('div[role="navigation"], div[aria-label="Facebook"]');

        if (hasNav && !url.includes('/login')) {
            console.log(`[FBScraper] ✅ Saved session valid — skipping login`);
            isLoggedIn = true;
            await page.close();
            return activeContext;
        }

        console.log(`[FBScraper] ⚠️ Saved session expired, re-logging in...`);
        await page.close();
    }

    // Login with credentials
    const page = await activeContext.newPage();
    const success = await loginToFacebook(page);
    await page.close();

    if (success) {
        await saveSession(activeContext);
    } else {
        throw new Error('Facebook login failed');
    }

    return activeContext;
}

async function closeBrowser() {
    if (activeContext) await saveSession(activeContext);
    if (activeBrowser) try { await activeBrowser.close(); } catch { }
    activeBrowser = null;
    activeContext = null;
    isLoggedIn = false;
    sessionAge = 0;
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function extractGroupId(url) {
    const match = url.match(/groups\/([^/?]+)/);
    return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════
// GROUP POSTS SCRAPER — Playwright on www.facebook.com
// ═══════════════════════════════════════════════════════

/**
 * Get posts from a Facebook group.
 * Uses authenticated Playwright session on www.facebook.com.
 * Output format matches SociaVault fbGetGroupPosts.
 */
async function getGroupPosts(groupUrl, groupName) {
    const groupId = extractGroupId(groupUrl);
    if (!groupId) return [];

    let page = null;
    try {
        const context = await getAuthContext();
        page = await context.newPage();

        console.log(`[FBScraper] 📥 ${groupName}`);
        await page.goto(`${FB_URL}/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Wait for React to hydrate (12s proven to work in tests)
        await delay(10000);

        // Check for login redirect
        if (page.url().includes('/login')) {
            console.warn(`[FBScraper] 🔒 Session expired`);
            isLoggedIn = false;
            await page.close();
            return [];
        }

        // Wait for feed/articles to render
        try {
            await page.waitForSelector('div[role="feed"], div[role="article"]', { timeout: 10000 });
        } catch {
            // Diagnose why feed wasn't found
            const currentUrl = page.url();
            const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
            const isJoinPage = pageText.toLowerCase().includes('join group') || pageText.includes('Tham gia nhóm');
            const isDead = pageText.toLowerCase().includes('content isn\'t available') || pageText.includes('nội dung không');

            if (isDead) {
                console.warn(`[FBScraper] 💀 ${groupName}: DEAD GROUP — auto-deactivating`);
                // Auto-deactivate in DB so it's never scanned again
                try {
                    const gd = require('../agent/groupDiscovery');
                    if (gd.deactivateGroup) gd.deactivateGroup(groupUrl);
                } catch (_) { }
            } else if (isJoinPage) {
                console.warn(`[FBScraper] ⚠️ ${groupName}: NOT A MEMBER — need to join first`);
            } else {
                console.warn(`[FBScraper] ⚠️ Feed not found for ${groupName} (url: ${currentUrl.substring(0, 60)})`);
            }

            // Skip this group — no point scrolling an empty page
            await page.close();
            return [];
        }

        // Scroll aggressively to load more posts (8 scrolls = ~15 posts per group)
        for (let i = 0; i < 8; i++) {
            await page.evaluate(() => window.scrollBy(0, 2500));
            await delay(2000);
        }

        // DEBUG: Log DOM state before extraction
        const domDebug = await page.evaluate(() => {
            const articles = document.querySelectorAll('div[role="article"]').length;
            const feedChildren = document.querySelectorAll('div[role="feed"] > div').length;
            const hasFeed = !!document.querySelector('div[role="feed"]');
            const pageH = document.body.scrollHeight;
            const dirAutos = document.querySelectorAll('div[dir="auto"]').length;
            // Sample first dir=auto text
            const firstText = document.querySelector('div[dir="auto"]')?.innerText?.substring(0, 80) || 'none';
            return { articles, feedChildren, hasFeed, pageH, dirAutos, firstText };
        });
        console.log(`[FBScraper] 🔍 DOM: ${domDebug.articles} articles, ${domDebug.feedChildren} feed-children, feed=${domDebug.hasFeed}, height=${domDebug.pageH}, dirAutos=${domDebug.dirAutos}`);
        if (domDebug.articles === 0 && domDebug.feedChildren === 0) {
            console.log(`[FBScraper] 🔍 Sample text: ${domDebug.firstText}`);
        }

        // Extract posts from rendered DOM — using div[role="article"] (confirmed working)
        const posts = await page.evaluate((gUrl) => {
            const results = [];
            const seenTexts = new Set();

            // Primary: div[role="article"] — confirmed 6+ matches on FB group pages
            let units = document.querySelectorAll('div[role="article"]');

            // Fallback: all direct children of feed
            if (units.length === 0) {
                units = document.querySelectorAll('div[role="feed"] > div');
            }

            for (const unit of units) {
                try {
                    // Get post text — longest div[dir=auto]
                    let content = '';
                    const dirAutos = unit.querySelectorAll('div[dir="auto"]');
                    for (const da of dirAutos) {
                        const t = (da.innerText || '').trim();
                        // Skip short texts, menus, action labels
                        if (t.length > 15 && t.length > content.length && !t.includes('\n\n\n')) {
                            content = t;
                        }
                    }
                    if (!content || content.length < 15) continue;

                    // Dedup
                    const hash = content.substring(0, 80);
                    if (seenTexts.has(hash)) continue;
                    seenTexts.add(hash);

                    // Author — first <strong> in the unit (FB uses <strong> for author names)
                    let authorName = 'Unknown';
                    const strong = unit.querySelector('strong');
                    if (strong) authorName = strong.innerText?.trim() || 'Unknown';

                    // Post URL — link containing /posts/ or story_fbid or permalink
                    let postUrl = '';
                    const links = unit.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink"]');
                    if (links.length > 0) {
                        postUrl = links[0].href;
                    }

                    // Time — look for timestamp in various places
                    let createdAt = null;
                    // Find relative time text near author
                    const allSpans = unit.querySelectorAll('span');
                    for (const sp of allSpans) {
                        const t = sp.innerText?.trim();
                        if (!t || t.length > 30 || t.length < 1) continue;
                        const now = Date.now();
                        if (/^\d+h$/i.test(t) || /^\d+\s*hr/i.test(t) || /^\d+\s*giờ/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 3600000).toISOString();
                            break;
                        }
                        if (/^\d+m$/i.test(t) || /^\d+\s*min/i.test(t) || /^\d+\s*phút/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 60000).toISOString();
                            break;
                        }
                        if (/^\d+d$/i.test(t) || /^\d+\s*ngày/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 86400000).toISOString();
                            break;
                        }
                        if (/^just now/i.test(t) || /^vừa xong/i.test(t)) {
                            createdAt = new Date().toISOString();
                            break;
                        }
                    }
                    if (!createdAt) createdAt = new Date().toISOString();

                    // Comment count
                    let commentCount = 0;
                    allSpans.forEach(sp => {
                        const m = (sp.innerText || '').match(/(\d+)\s*(comment|bình luận)/i);
                        if (m) commentCount = Math.max(commentCount, parseInt(m[1]));
                    });

                    // Top comments (inline preview)
                    const topComments = [];
                    const comEls = unit.querySelectorAll('ul li div[dir="auto"], div[aria-label*="comment"] div[dir="auto"]');
                    let ci = 0;
                    for (const ce of comEls) {
                        if (ci >= 5) break;
                        const ct = (ce.innerText || '').trim();
                        if (ct.length > 5 && ct.length < 300 && ct !== content) {
                            topComments.push({
                                text: ct,
                                publishTime: new Date().toISOString(),
                                author_name: 'Unknown',
                                author_url: '',
                            });
                            ci++;
                        }
                    }

                    results.push({
                        url: postUrl || gUrl,
                        content: content.substring(0, 2000),
                        author_name: authorName,
                        created_at: createdAt,
                        commentCount,
                        topComments,
                    });
                } catch { }
            }
            return results;
        }, groupUrl);

        console.log(`[FBScraper] ✅ ${groupName}: ${posts.length} posts`);
        await page.close();
        await delay(2500);
        return posts;

    } catch (err) {
        console.error(`[FBScraper] ❌ ${groupName}: ${err.message}`);
        if (page) try { await page.close(); } catch { }
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// COMMENT SCRAPER
// ═══════════════════════════════════════════════════════

async function getPostComments(postUrl, source) {
    let page = null;
    try {
        const context = await getAuthContext();
        page = await context.newPage();

        console.log(`[FBScraper] 💬 Comments: ${postUrl.substring(0, 70)}...`);
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(4000);

        // Expand comments
        try {
            const moreBtn = await page.$('span:has-text("View more comments"), span:has-text("Xem thêm")');
            if (moreBtn) { await moreBtn.click(); await delay(2000); }
        } catch { }

        await page.evaluate(() => window.scrollBy(0, 2000));
        await delay(1500);

        const comments = await page.evaluate((pUrl, src) => {
            const results = [];
            const seen = new Set();
            const comEls = document.querySelectorAll('div[role="article"], ul li, div[aria-label*="comment"]');

            for (const el of comEls) {
                try {
                    let content = '';
                    el.querySelectorAll('div[dir="auto"]').forEach(da => {
                        const t = (da.innerText || '').trim();
                        if (t.length > 5 && t.length > content.length && t.length < 500) content = t;
                    });
                    if (!content || content.length < 5) continue;
                    if (seen.has(content)) continue;
                    seen.add(content);

                    const aEl = el.querySelector('a[role="link"] strong, a strong, strong');
                    const authorName = aEl?.innerText?.trim() || 'Unknown';
                    let authorUrl = '';
                    const aLink = el.querySelector('a[role="link"]');
                    if (aLink) authorUrl = (aLink.href || '').split('?')[0];

                    results.push({
                        platform: 'facebook',
                        post_url: pUrl,
                        author_name: authorName,
                        author_url: authorUrl,
                        content,
                        post_created_at: new Date().toISOString(),
                        scraped_at: new Date().toISOString(),
                        source: src,
                        likes: 0,
                        comments: 0,
                    });
                } catch { }
            }
            return results;
        }, postUrl, source);

        console.log(`[FBScraper] ✅ ${comments.length} comments`);
        await page.close();
        await delay(2500);
        return comments;

    } catch (err) {
        console.error(`[FBScraper] ❌ Comments: ${err.message}`);
        if (page) try { await page.close(); } catch { };
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// AUTO-JOIN GROUPS — Batch join all target groups
// ═══════════════════════════════════════════════════════

/**
 * Auto-join all target groups from config.
 * Navigates to each group and clicks "Join Group" button.
 * Handles: already joined, pending approval, answer questions.
 */
async function autoJoinGroups(groups = null) {
    const config = require('../config');
    const targetGroups = groups || config.FB_TARGET_GROUPS || [];

    if (targetGroups.length === 0) {
        console.log('[FBScraper] ⚠️ No target groups to join');
        return { joined: 0, already: 0, pending: 0, failed: 0 };
    }

    console.log(`[FBScraper] 🚀 Auto-joining ${targetGroups.length} groups...`);

    const stats = { joined: 0, already: 0, pending: 0, failed: 0 };
    let page = null;

    try {
        const context = await getAuthContext();
        page = await context.newPage();

        for (let i = 0; i < targetGroups.length; i++) {
            const group = targetGroups[i];
            const groupId = extractGroupId(group.url);
            if (!groupId) {
                console.warn(`[FBScraper] ⚠️ Bad URL: ${group.url}`);
                stats.failed++;
                continue;
            }

            try {
                console.log(`[FBScraper] [${i + 1}/${targetGroups.length}] ${group.name}`);
                await page.goto(`${FB_URL}/groups/${groupId}`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 25000,
                });
                await delay(2000);  // 2s page load (was 4s)

                // Check page status
                const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
                const hasFeed = await page.$('div[role="feed"], div[role="article"]');

                // Already a member → has Discussion/feed tab OR visible feed
                if (hasFeed || pageText.includes('Discussion') || pageText.includes('Thảo luận') ||
                    pageText.includes('Write something') || pageText.includes('Viết gì đó') ||
                    pageText.includes('What\'s on your mind') || pageText.includes('Bạn đang nghĩ gì') ||
                    pageText.includes('Create a post') || pageText.includes('Tạo bài viết') ||
                    pageText.includes('About') || pageText.includes('Members')) {
                    console.log(`  ✅ Already a member`);
                    stats.already++;
                    await delay(1000);
                    continue;
                }

                // Pending approval
                if (pageText.includes('Pending') || pageText.includes('Đang chờ') ||
                    pageText.includes('Cancel request') || pageText.includes('Hủy yêu cầu')) {
                    console.log(`  ⏳ Already pending approval`);
                    stats.pending++;
                    await delay(1000);
                    continue;
                }

                // Try to click "Join Group" / "Join group" button
                let joined = false;
                for (const label of ['Join group', 'Join Group', 'Tham gia nhóm', 'Tham gia', 'Join']) {
                    try {
                        const btn = await page.$(`div[role="button"]:has-text("${label}"), button:has-text("${label}")`);
                        if (btn) {
                            await btn.click({ force: true });
                            console.log(`  🔘 Clicked "${label}"`);
                            joined = true;
                            await delay(3000);
                            break;
                        }
                    } catch { }
                }

                if (!joined) {
                    // Fallback: try any visible join-like button
                    try {
                        const joinBtn = await page.$('div[aria-label*="Join"], div[aria-label*="Tham gia"]');
                        if (joinBtn) {
                            await joinBtn.click({ force: true });
                            console.log(`  🔘 Clicked join (aria-label)`);
                            joined = true;
                            await delay(3000);
                        }
                    } catch { }
                }

                if (joined) {
                    // Check if there are membership questions
                    const afterText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
                    if (afterText.includes('Answer') || afterText.includes('Trả lời') ||
                        afterText.includes('question') || afterText.includes('câu hỏi')) {
                        // Try to submit answers (fill text areas if any, then submit)
                        try {
                            const textareas = await page.$$('textarea');
                            for (const ta of textareas) {
                                await ta.fill('Tôi quan tâm đến vận chuyển hàng quốc tế VN-US. Xin cảm ơn!');
                            }
                            // Click submit
                            for (const submitLabel of ['Submit', 'Gửi', 'Done', 'Xong']) {
                                const submitBtn = await page.$(`button:has-text("${submitLabel}"), div[role="button"]:has-text("${submitLabel}")`);
                                if (submitBtn) {
                                    await submitBtn.click({ force: true });
                                    console.log(`  📝 Answered questions and submitted`);
                                    await delay(1000);
                                    break;
                                }
                            }
                        } catch { }
                    }

                    stats.joined++;
                    console.log(`  ✅ Join request sent!`);
                } else {
                    // Log what's actually on the page for diagnosis
                    const currentUrl = page.url();
                    const snippet = pageText.substring(0, 150).replace(/\n/g, ' ');
                    console.log(`  ℹ️ Public/viewable (no join button)`);
                    console.log(`    URL: ${currentUrl.substring(0, 70)}`);
                    console.log(`    Page: ${snippet.substring(0, 100)}...`);
                    stats.viewable = (stats.viewable || 0) + 1;
                }

            } catch (err) {
                console.error(`  ❌ Error: ${err.message}`);
                stats.failed++;
            }

            // Rate limit: 2s between groups (was 5s)
            await delay(2000);
        }

        await page.close();
    } catch (err) {
        console.error(`[FBScraper] ❌ Auto-join failed: ${err.message}`);
        if (page) try { await page.close(); } catch { }
    }

    // Save session after all joins
    if (activeContext) await saveSession(activeContext);

    console.log(`\n[FBScraper] 📊 Auto-Join Results:`);
    console.log(`  ✅ Joined: ${stats.joined}`);
    console.log(`  ✓ Already member: ${stats.already}`);
    console.log(`  ℹ️ Public/viewable: ${stats.viewable || 0}`);
    console.log(`  ⏳ Pending: ${stats.pending}`);
    console.log(`  ❌ Failed: ${stats.failed}`);

    return stats;
}

// ═══════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════

async function testScrape() {
    console.log('[FBScraper] 🧪 Testing login-based scraper...');
    await loadFreeProxies();

    const posts = await getGroupPosts(
        'https://www.facebook.com/groups/238061523539498',
        'Test: CĐ Người Việt tại Mỹ'
    );

    console.log(`\n📊 Results: ${posts.length} posts`);
    for (const p of posts.slice(0, 5)) {
        console.log(`  ${p.author_name}: ${p.content.substring(0, 80)}...`);
    }

    await closeBrowser();
    return posts;
}

// Compat exports
function setCookies() { }
function getCookies() { return ''; }

module.exports = {
    getGroupPosts,
    getPostComments,
    autoJoinGroups,
    setCookies,
    getCookies,
    fetchFreeProxies,
    loadFreeProxies,
    closeBrowser,
    testScrape,
    extractGroupId,
};
