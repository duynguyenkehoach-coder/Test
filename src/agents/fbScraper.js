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
const accountManager = require('../agent/accountManager');

chromium.use(StealthPlugin());

const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 600));
const FB_URL = 'https://www.facebook.com';
// Legacy single-account session path (fallback)
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
 * Load saved session cookies for a specific account
 */
function loadSession(sessionPath) {
    const p = sessionPath || COOKIES_PATH;
    try {
        if (fs.existsSync(p)) {
            const cookies = JSON.parse(fs.readFileSync(p, 'utf8'));
            console.log(`[FBScraper] 📂 Loaded session: ${path.basename(p)} (${cookies.length} cookies)`);
            return cookies;
        }
    } catch (e) {
        console.warn(`[FBScraper] ⚠️ Load session failed: ${e.message}`);
    }
    return null;
}

/**
 * Login to Facebook via Playwright
 * @param {Page} page - Playwright page
 * @param {string} email - FB email (passed from getAuthContext)
 * @param {string} password - FB password (passed from getAuthContext)
 */
async function loginToFacebook(page, email = '', password = '') {
    const loginEmail = email || FB_EMAIL;
    const loginPassword = password || FB_PASSWORD;
    if (!loginEmail || !loginPassword) {
        throw new Error('FB_EMAIL and FB_PASSWORD required for self-hosted mode');
    }

    console.log(`[FBScraper] 🔐 Logging in as ${loginEmail}...`);

    await page.goto(`${FB_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);

    // Fill email
    const emailInput = await page.$('input[name="email"], input#email');
    if (emailInput) {
        await emailInput.click();
        await emailInput.fill(loginEmail);
    } else {
        console.error('[FBScraper] ❌ Email input not found');
        return false;
    }
    await delay(800);

    // Fill password
    const passInput = await page.$('input[name="pass"], input#pass');
    if (passInput) {
        await passInput.click();
        await passInput.fill(loginPassword);
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
 * Get or create an authenticated browser context.
 * Now account-aware: uses AccountManager for rotation + per-account session/proxy.
 * @param {object|null} account - from accountManager.getNextAccount()
 */
async function getAuthContext(account = null) {
    // Use provided account or fall back to env credentials
    const accEmail = account?.email || FB_EMAIL;
    const accPassword = account?.password || FB_PASSWORD;
    const accProxy = account?.proxy_url || '';
    const sessionPath = account ? accountManager.getSessionPath(account) : COOKIES_PATH;

    sessionAge++;

    // Rotate browser session periodically (or when account changes)
    if (activeBrowser && sessionAge > MAX_SESSION_AGE) {
        console.log('[FBScraper] 🔄 Rotating browser session...');
        if (activeContext) {
            // Save session to account-specific path
            try {
                const cookies = await activeContext.cookies();
                fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
                fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
                console.log(`[FBScraper] 💾 Session saved → ${path.basename(sessionPath)}`);
            } catch { }
        }
        try { await activeBrowser.close(); } catch { }
        activeBrowser = null;
        activeContext = null;
        isLoggedIn = false;
        sessionAge = 0;
    }

    if (activeContext && isLoggedIn) return activeContext;

    // ── Build launch options ──
    const PROFILE_DIR = path.join(__dirname, '..', '..', 'data', 'fb_browser_profile');

    // Persistent context: use profile from task fb:login if available (most stable)
    if (!activeContext && fs.existsSync(PROFILE_DIR) && !accProxy) {
        try {
            console.log(`[FBScraper] 📁 Using persistent browser profile (${accEmail})`);
            const persistCtx = await chromium.launchPersistentContext(PROFILE_DIR, {
                headless: true,
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            });
            activeContext = persistCtx;
            activeBrowser = null; // persistent context manages its own browser
            isLoggedIn = true;
            sessionAge = 0;
            console.log(`[FBScraper] ✅ Persistent session loaded`);
            return activeContext;
        } catch (err) {
            console.warn(`[FBScraper] ⚠️ Persistent context failed: ${err.message} — falling back to cookie session`);
            activeContext = null;
        }
    }


    // Cookie-based session fallback — build launch options
    const launchOptions = {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    };

    // Per-account proxy (1 account : 1 proxy — prevents Chain-ban)
    // Assigned automatically by Webshare auto-assign on startup
    if (accProxy) {
        try {
            const pUrl = new URL(accProxy);
            launchOptions.proxy = {
                server: `${pUrl.protocol}//${pUrl.hostname}:${pUrl.port}`,
            };
            if (pUrl.username) {
                launchOptions.proxy.username = decodeURIComponent(pUrl.username);
                launchOptions.proxy.password = decodeURIComponent(pUrl.password);
            }
            console.log(`[FBScraper] 🔒 Using dedicated proxy for ${accEmail}`);
        } catch { }
    } else if (pool.loaded && pool.hasProxies()) {
        // Fallback: shared proxy pool (round-robin)
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
                console.log(`[FBScraper] 🌐 Using pool proxy for ${accEmail}`);
            } catch { }
        }
    } else {
        console.log(`[FBScraper] ⚡ Direct connect (no proxy) for ${accEmail}`);
    }

    const fp = generateFingerprint({ region: 'US' });

    activeBrowser = await chromium.launch(launchOptions);
    activeContext = await activeBrowser.newContext({
        userAgent: fp.userAgent,
        viewport: fp.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Block images, fonts, CSS to speed up page loads
    await activeContext.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    // Try loading saved session first (account-specific)
    const savedCookies = loadSession(sessionPath);
    if (savedCookies && savedCookies.length > 0) {
        await activeContext.addCookies(savedCookies);
        console.log(`[FBScraper] 🍪 Restored session: ${accEmail}`);

        const page = await activeContext.newPage();
        await page.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(1500);

        const url = page.url();

        // ── Checkpoint detection ──
        if (url.includes('checkpoint') || url.includes('two_step') ||
            await page.$('text="Confirm your identity"') ||
            await page.$('text="Xác nhận danh tính"')) {
            console.log(`[FBScraper] 🚨 CHECKPOINT trên session của ${accEmail}!`);
            if (account) accountManager.reportCheckpoint(account.id);
            await page.close();
            throw new Error(`Checkpoint: ${accEmail}`);
        }

        const hasNav = await page.$('div[role="navigation"], div[aria-label="Facebook"]');
        if (hasNav && !url.includes('/login')) {
            console.log(`[FBScraper] ✅ Session valid: ${accEmail}`);
            isLoggedIn = true;
            await page.close();
            return activeContext;
        }

        console.log(`[FBScraper] ⚠️ Session expired: ${accEmail} — trying FB_COOKIES fallback...`);
        await page.close();
    }

    // ── Fallback: FB_COOKIES from .env (pre-authenticated session) ──
    // This avoids email/password login which triggers 2FA on datacenter IPs.
    // FB_COOKIES format: "c_user=XXX; xs=XXX; datr=XXX; fr=XXX; sb=XXX"
    const envCookies = process.env.FB_COOKIES || '';
    if (envCookies && envCookies.includes('c_user=') && envCookies.includes('xs=')) {
        console.log(`[FBScraper] 🍪 Trying FB_COOKIES from .env...`);
        try {
            // Parse raw cookie string → Playwright cookie objects
            const playwrightCookies = envCookies.split(';')
                .map(part => part.trim())
                .filter(Boolean)
                .map(part => {
                    const eqIdx = part.indexOf('=');
                    if (eqIdx < 0) return null;
                    const name = part.substring(0, eqIdx).trim();
                    const value = part.substring(eqIdx + 1).trim();
                    if (!name) return null;
                    return {
                        name,
                        value,
                        domain: '.facebook.com',
                        path: '/',
                        httpOnly: true,
                        secure: true,
                        sameSite: 'None',
                    };
                })
                .filter(Boolean);

            if (playwrightCookies.length >= 2) {
                await activeContext.addCookies(playwrightCookies);
                console.log(`[FBScraper] 🍪 Injected ${playwrightCookies.length} cookies from FB_COOKIES env`);

                // Validate session
                const testPage = await activeContext.newPage();
                await testPage.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await delay(2000);

                const testUrl = testPage.url();

                // Checkpoint check
                if (testUrl.includes('checkpoint') || testUrl.includes('two_step')) {
                    console.warn(`[FBScraper] 🚨 FB_COOKIES session hit checkpoint — falling through to login`);
                    await testPage.close();
                } else {
                    const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
                    if (hasNav && !testUrl.includes('/login')) {
                        console.log(`[FBScraper] ✅ FB_COOKIES session valid!`);
                        isLoggedIn = true;
                        // Save as account-specific session for next use
                        try {
                            const cookies = await activeContext.cookies();
                            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
                            fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
                            console.log(`[FBScraper] 💾 Session saved from FB_COOKIES → ${path.basename(sessionPath)}`);
                        } catch { }
                        await testPage.close();
                        return activeContext;
                    }
                    console.warn(`[FBScraper] ⚠️ FB_COOKIES session not valid (no nav found) — falling through to login`);
                    await testPage.close();
                }
            }
        } catch (cookieErr) {
            console.warn(`[FBScraper] ⚠️ FB_COOKIES fallback failed: ${cookieErr.message}`);
        }
    }

    // ── Login ── (pass credentials directly, no env mutation needed)
    const loginPage = await activeContext.newPage();
    const success = await loginToFacebook(loginPage, accEmail, accPassword);
    await loginPage.close();

    if (success) {
        // Save account-specific session
        try {
            const cookies = await activeContext.cookies();
            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
            fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
            console.log(`[FBScraper] 💾 New session saved → ${path.basename(sessionPath)}`);
        } catch (e) {
            console.warn(`[FBScraper] ⚠️ Session save failed: ${e.message}`);
        }
    } else {
        if (account) accountManager.reportCheckpoint(account.id);
        throw new Error(`Login failed: ${accEmail}`);
    }

    return activeContext;
}

async function closeBrowser() {
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
 * Get posts from a Facebook group (with 2-minute timeout).
 * Uses AccountManager for multi-account rotation.
 */
async function getGroupPosts(groupUrl, groupName, options = {}) {
    // ── Get next available account ──
    const account = accountManager.getNextAccount(options);
    if (!account) {
        console.log(`[CrawBot] ❌ Không có tài khoản nào sẵn sàng — bỏ qua ${groupName}`);
        return [];
    }

    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('⏰ Group timeout (2min)')), 120000)
    );
    try {
        const posts = await Promise.race([timeout, _getGroupPostsInner(groupUrl, groupName, account)]);
        // Report success back to AccountManager
        if (posts.length >= 0) accountManager.reportSuccess(account.id, posts.length);
        return posts;
    } catch (err) {
        console.warn(`[CrawBot] ⚠️ ${groupName}: ${err.message}`);
        // If it's a checkpoint error, it was already reported inside getAuthContext()
        return [];
    }
}

async function _getGroupPostsInner(groupUrl, groupName, account = null) {
    const groupId = extractGroupId(groupUrl);
    if (!groupId) return [];

    let page = null;
    try {
        const context = await getAuthContext(account);
        try {
            page = await context.newPage();
        } catch (pageErr) {
            // Stealth plugin can throw async errors on page creation if browser was just recycled
            console.warn(`[FBScraper] ⚠️ newPage failed (stealth plugin): ${pageErr.message} — retrying once`);
            await closeBrowser();
            const ctx2 = await getAuthContext(account);
            page = await ctx2.newPage();
        }

        console.log(`[FBScraper] 📥 ${groupName}`);
        await page.goto(`${FB_URL}/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Wait for React to hydrate (2.5s — faster, still reliable)
        await delay(2500);

        // ── Immediate checkpoint/login detection (OpenClaw technique) ──
        const landedUrl = page.url();
        if (landedUrl.includes('checkpoint') || landedUrl.includes('two_step')) {
            console.log(`[FBScraper] 🚨 CHECKPOINT after goto ${groupName} — stopping`);
            if (account) accountManager.reportCheckpoint(account.id);
            await page.close();
            return [];
        }
        if (landedUrl.includes('/login')) {
            console.warn(`[FBScraper] 🔒 Redirected to login for ${groupName} — session expired`);
            isLoggedIn = false;
            await page.close();
            return [];
        }
        const pageTitle = await page.title();
        if (['security check', 'checkpoint', 'log in'].some(kw => pageTitle.toLowerCase().includes(kw))) {
            console.log(`[FBScraper] 🚨 Checkpoint page detected: "${pageTitle}" for ${groupName}`);
            if (account) accountManager.reportCheckpoint(account.id);
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
                try {
                    const gd = require('../agent/groupDiscovery');
                    if (gd.deactivateGroup) gd.deactivateGroup(groupUrl);
                } catch (_) { }
                await page.close();
                return [];
            } else if (isJoinPage) {
                // AUTO-JOIN: click "Join Group" button and retry
                console.log(`[FBScraper] 🚪 ${groupName}: NOT A MEMBER — auto-joining...`);
                try {
                    // Try clicking Join button (FB uses various labels)
                    const joinBtn = await page.$('div[role="button"]:has-text("Join"), div[role="button"]:has-text("Tham gia"), div[role="button"]:has-text("Join group"), div[role="button"]:has-text("Tham gia nhóm")');
                    if (joinBtn) {
                        await joinBtn.click();
                        await delay(3000);

                        // Check if we got in (public group) or pending (private group)
                        const afterText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
                        if (afterText.includes('Pending') || afterText.includes('Chờ phê duyệt') || afterText.includes('pending')) {
                            console.log(`[FBScraper] ⏳ ${groupName}: Join request sent — pending admin approval`);
                        } else {
                            // Might have joined instantly — reload and try to scrape
                            console.log(`[FBScraper] ✅ ${groupName}: Joined! Reloading to scrape...`);
                            await page.goto(`${FB_URL}/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, {
                                waitUntil: 'domcontentloaded', timeout: 25000,
                            });
                            await delay(5000);
                            // Check if feed is now visible
                            const hasFeed = await page.$('div[role="feed"], div[role="article"]');
                            if (hasFeed) {
                                // Success! Don't close page — fall through to scrolling below
                                console.log(`[FBScraper] 🎉 ${groupName}: Feed loaded after join!`);
                                // We need to NOT return here — let code continue to scroll+extract
                                // Use a flag
                            } else {
                                console.warn(`[FBScraper] ⚠️ ${groupName}: Joined but feed still not visible`);
                                await page.close();
                                return [];
                            }
                        }
                    } else {
                        console.warn(`[FBScraper] ⚠️ ${groupName}: Join button not found`);
                        await page.close();
                        return [];
                    }
                } catch (joinErr) {
                    console.warn(`[FBScraper] ⚠️ ${groupName}: Auto-join failed: ${joinErr.message}`);
                    await page.close();
                    return [];
                }
                // If we reach here with pending status, skip for now
                if (!await page.$('div[role="feed"]')) {
                    await page.close();
                    return [];
                }
            } else {
                console.warn(`[FBScraper] ⚠️ Feed not found for ${groupName} (url: ${currentUrl.substring(0, 60)})`);
                await page.close();
                return [];
            }
        }

        // Smart scroll — scroll aggressively to load 30+ posts
        // Stops early if: enough posts visible OR 5 consecutive no-growth
        let prevHeight = 0;
        let noGrowthCount = 0;
        const TARGET_FEED_CHILDREN = maxPosts * 2; // Overshoot to ensure enough
        for (let i = 0; i < 40; i++) {
            await page.evaluate(() => window.scrollBy(0, 4000));
            await delay(250);
            const curHeight = await page.evaluate(() => document.body.scrollHeight);

            // Early stop: if we have enough feed children already visible
            const feedCount = await page.evaluate(() =>
                document.querySelectorAll('div[role="feed"] > div').length
            );
            if (feedCount >= TARGET_FEED_CHILDREN && i >= 5) break;

            if (curHeight === prevHeight) {
                noGrowthCount++;
                if (i >= 5 && noGrowthCount >= 5) break;
            } else {
                noGrowthCount = 0;
            }
            prevHeight = curHeight;
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

        // Extract posts from rendered DOM
        const posts = await page.evaluate((gUrl) => {
            const results = [];
            const seenTexts = new Set();

            // Primary: feed children (catches ALL posts, not just role="article")
            // Facebook doesn't always add role="article" — feed children is more reliable
            let units = document.querySelectorAll('div[role="feed"] > div');

            // Fallback: div[role="article"] if no feed found
            if (units.length === 0) {
                units = document.querySelectorAll('div[role="article"]');
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

                    // Author — <strong> inside <a> tag (FB renders: <a href=profile><strong>Name</strong></a>)
                    // Must NOT grab post title text like "Gấp" which is also <strong>
                    let authorName = 'Unknown';
                    let authorUrl = '';
                    let authorAvatar = '';
                    const authorLinkEl = unit.querySelector('a strong');
                    if (authorLinkEl) {
                        authorName = authorLinkEl.innerText?.trim() || 'Unknown';
                        // Get profile URL from parent <a>
                        const aTag = authorLinkEl.closest('a');
                        if (aTag && aTag.href && !aTag.href.includes('/groups/')) {
                            authorUrl = aTag.href.split('?')[0]; // Clean URL
                        }
                    } else {
                        const strong = unit.querySelector('strong');
                        if (strong && (strong.innerText?.trim()?.length || 0) < 40) {
                            authorName = strong.innerText?.trim() || 'Unknown';
                        }
                    }

                    // Avatar — FB uses <image> (SVG) or <img> for profile pics
                    // Look for small images near the top (avatar is typically first image)
                    const svgImg = unit.querySelector('image[href], image[xlink\\:href]');
                    if (svgImg) {
                        authorAvatar = svgImg.getAttribute('href') || svgImg.getAttribute('xlink:href') || '';
                    }
                    if (!authorAvatar) {
                        const imgEl = unit.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
                        if (imgEl) authorAvatar = imgEl.src || '';
                    }

                    // Post URL — 4-pass fallback (OpenClaw technique)
                    let postUrl = '';
                    const isPostLink = (href) => href && (
                        href.includes('/posts/') || href.includes('story_fbid') ||
                        href.includes('permalink') || href.includes('/permalink/')
                    );

                    // Pass 1: direct post/story links
                    for (const a of unit.querySelectorAll('a')) {
                        if (isPostLink(a.href)) { postUrl = a.href; break; }
                    }

                    // Pass 2: timestamp links (aria-label with relative time)
                    if (!postUrl) {
                        const timeSelectors = [
                            'a[aria-label*="giờ"]', 'a[aria-label*="phút"]', 'a[aria-label*="ngày"]',
                            'a[aria-label*="tuần"]', 'a[aria-label*="tháng"]',
                            'a[aria-label*="hour"]', 'a[aria-label*="minute"]',
                            'a[aria-label*="day"]', 'a[aria-label*="week"]', 'a[aria-label*="month"]',
                            'a abbr[title]',
                        ];
                        for (const sel of timeSelectors) {
                            const el2 = sel.endsWith(']') && sel.includes(' ')
                                ? unit.querySelector(sel)?.closest('a')
                                : unit.querySelector(sel);
                            if (el2 && isPostLink(el2.href)) { postUrl = el2.href; break; }
                        }
                    }

                    // Pass 3: reconstruct from photo link set param (post ID hidden inside)
                    // Facebook embeds post ID: /photo/?fbid=X&set=pcb.POSTID or set=gm.POSTID
                    if (!postUrl) {
                        for (const a of unit.querySelectorAll('a[href*="/photo/"]')) {
                            const setMatch = (a.href || '').match(/[?&]set=(?:pcb|gm|pb|g)\.(\d+)/);
                            if (setMatch) {
                                const grpLink = unit.querySelector('a[href*="/groups/"][href*="/user/"]');
                                if (grpLink) {
                                    const grpMatch = grpLink.href.match(/\/groups\/(\d+)\//);
                                    if (grpMatch) {
                                        postUrl = `https://www.facebook.com/groups/${grpMatch[1]}/posts/${setMatch[1]}/`;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Pass 4: any /groups/.../posts/ link
                    if (!postUrl) {
                        const grpPostLink = unit.querySelector('a[href*="/groups/"][href*="/posts/"]');
                        if (grpPostLink) postUrl = grpPostLink.href;
                    }

                    // Clean query params from URL
                    if (postUrl) {
                        try { const u = new URL(postUrl); u.search = ''; postUrl = u.toString(); } catch { }
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
                        // Week support: "2w", "2 tuần", "1 week"
                        if (/^\d+w$/i.test(t) || /^\d+\s*tuần/i.test(t) || /^\d+\s*week/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 7 * 86400000).toISOString();
                            break;
                        }
                        if (/^yesterday/i.test(t) || /^hôm qua/i.test(t)) {
                            createdAt = new Date(now - 86400000).toISOString();
                            break;
                        }
                        if (/^just now/i.test(t) || /^vừa xong/i.test(t)) {
                            createdAt = new Date().toISOString();
                            break;
                        }
                    }
                    if (!createdAt) createdAt = new Date().toISOString();

                    // Filter stale posts (>14 days old = no longer actionable)
                    const postAge = (Date.now() - new Date(createdAt).getTime()) / 86400000;
                    if (postAge > 14) continue;

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
                        author_url: authorUrl,
                        author_avatar: authorAvatar,
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
        await delay(500);
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

        const comments = await page.evaluate(({ pUrl, src }) => {
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
        }, { pUrl: postUrl, src: source });

        console.log(`[FBScraper] ✅ ${comments.length} comments`);
        await page.close();
        await delay(1000);
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
/**
 * Auto-join all target Facebook groups for a specific account.
 * @param {Array|null} groups - Target groups (defaults to config)
 * @param {object|null} account - Specific FB account to use (from accountManager)
 */
async function autoJoinGroups(groups = null, account = null) {
    const config = require('../config');
    const fs = require('fs');
    const PROD_GROUPS_FILE = path.join(__dirname, '..', '..', 'data', 'prod_groups.json');

    // Load groups: prod_groups.json > passed groups > config fallback
    let targetGroups = groups;
    if (!targetGroups || targetGroups.length === 0) {
        try {
            if (fs.existsSync(PROD_GROUPS_FILE)) {
                targetGroups = JSON.parse(fs.readFileSync(PROD_GROUPS_FILE, 'utf8'));
            }
        } catch { }
    }
    if (!targetGroups || targetGroups.length === 0) {
        targetGroups = config.FB_TARGET_GROUPS || [];
    }

    if (targetGroups.length === 0) {
        console.log('[FBScraper] ⚠️ No target groups to join');
        return { joined: 0, already: 0, pending: 0, failed: 0 };
    }

    const accLabel = account?.email || 'default';
    console.log(`[FBScraper] 🚀 Auto-joining ${targetGroups.length} groups for ${accLabel}...`);

    const stats = { joined: 0, already: 0, pending: 0, failed: 0 };
    let page = null;

    try {
        const context = await getAuthContext(account);
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
// MAIN ENTRY — Parallel group scraping
// ═══════════════════════════════════════════════════════

/**
 * Scrape all configured Facebook Groups in parallel batches of 5.
 * Replaces sequential scraping for 4-5x speed improvement.
 * @param {number} maxPosts - max posts per group
 * @returns {Array} all posts from all groups
 */
async function scrapeFacebookGroups(maxPosts = 20, options = {}, externalGroups = null) {
    const cfg = require('../config');
    // Use externally-provided groups (49 from prod) or fall back to config (19)
    const groups = (externalGroups && externalGroups.length > 0)
        ? externalGroups
        : (cfg.FB_TARGET_GROUPS || []);

    if (groups.length === 0) {
        console.log('[FBScraper] ⚠️ No target groups configured');
        return [];
    }

    const BATCH_SIZE = 3; // Reduced from 5 — prevents OOM crash (3 tabs × ~150MB = 450MB safe)
    console.log(`[FBScraper] 🚀 Parallel scraping ${groups.length} groups (batch=${BATCH_SIZE})...`);
    const allPosts = [];

    for (let i = 0; i < groups.length; i += BATCH_SIZE) {
        const batch = groups.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(groups.length / BATCH_SIZE);
        console.log(`[FBScraper] 📦 Batch ${batchNum}/${totalBatches}: ${batch.map(g => g.name).join(', ')}`);

        const results = await Promise.allSettled(
            batch.map(g => getGroupPosts(g.url, g.name, options))
        );

        for (const r of results) {
            if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                allPosts.push(...r.value);
            }
        }

        // Close browser between batches to free RAM (prevents OOM crash)
        if (i + BATCH_SIZE < groups.length) {
            await closeBrowser();
            // Random delay 2-4s between batches (human-like + avoids FB rate-limit)
            const batchDelay = 2000 + Math.random() * 2000;
            const mem = process.memoryUsage();
            console.log(`[FBScraper] 💾 Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB — pausing ${Math.round(batchDelay / 1000)}s`);
            await delay(batchDelay);
        }
    }

    // Final cleanup
    await closeBrowser();
    console.log(`[FBScraper] ✅ Total scraped: ${allPosts.length} posts from ${groups.length} groups`);
    return allPosts;
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
    scrapeFacebookGroups,
    setCookies,
    getCookies,
    fetchFreeProxies,
    loadFreeProxies,
    closeBrowser,
    testScrape,
    extractGroupId,
};
