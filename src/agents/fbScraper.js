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
// TOTP generator — use Node.js built-in crypto (no otplib dependency issues)
const crypto = require('crypto');
const authenticator = {
    generate(secret) {
        // Remove spaces from secret
        const cleanSecret = secret.replace(/\s/g, '');
        // Base32 decode
        const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const c of cleanSecret.toUpperCase()) {
            const val = base32chars.indexOf(c);
            if (val === -1) continue;
            bits += val.toString(2).padStart(5, '0');
        }
        const secretBytes = Buffer.alloc(Math.floor(bits.length / 8));
        for (let i = 0; i < secretBytes.length; i++) {
            secretBytes[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
        }
        // TOTP: time-based counter (30-second window)
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / 30);
        const counterBuf = Buffer.alloc(8);
        counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
        counterBuf.writeUInt32BE(counter & 0xFFFFFFFF, 4);
        // HMAC-SHA1
        const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
        return code.toString().padStart(6, '0');
    }
};
console.log('[FBScraper] 🔑 Built-in TOTP generator ready');
const fs = require('fs');
const path = require('path');
const { pool } = require('../proxy/proxyPool');
const { generateFingerprint } = require('../proxy/fingerprint');
const accountManager = require('../agent/accountManager');
const { selfHealLogin, isSessionHealthy, clearInvalidSession } = require('./fbSelfHeal');

chromium.use(StealthPlugin());

const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 600));
const FB_URL = 'https://www.facebook.com';
// Legacy single-account session path (fallback)
const COOKIES_PATH = path.join(__dirname, '..', '..', 'data', 'fb_session.json');
// StorageState sessions (preferred, created by fb-login.js)
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'sessions');

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
    const accUsername = accEmail.split('@')[0];
    const storageStatePath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);

    sessionAge++;

    // Rotate browser session periodically (or when account changes)
    if (activeBrowser && sessionAge > MAX_SESSION_AGE) {
        console.log('[FBScraper] 🔄 Rotating browser session...');
        if (activeContext) {
            // Save storageState (cookies + localStorage) for longer session life
            try {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                await activeContext.storageState({ path: storageStatePath });
                console.log(`[FBScraper] 💾 StorageState saved → ${accUsername}_auth.json`);
            } catch (e) {
                // Fallback: save cookies only
                try {
                    const cookies = await activeContext.cookies();
                    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
                    fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
                } catch { }
            }
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

    const fp = generateFingerprint({ region: 'US', accountId: accEmail });

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

    // Proxy connectivity test — verify Facebook is reachable through proxy
    if (launchOptions.proxy) {
        let proxyWorks = false;
        try {
            const testPage = await activeContext.newPage();
            await testPage.goto('https://www.facebook.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            });
            await testPage.close();
            proxyWorks = true;
            console.log(`[FBScraper] ✅ Proxy works for Facebook`);
        } catch (proxyErr) {
            console.warn(`[FBScraper] ⚠️ Proxy failed: ${proxyErr.message.substring(0, 80)}`);
        }

        if (!proxyWorks) {
            console.warn(`[FBScraper] 🔄 Falling back to direct connect...`);
            // Kill the broken browser completely
            try { await activeBrowser.close(); } catch { }
            activeBrowser = null;
            activeContext = null;

            // Relaunch clean browser without proxy
            delete launchOptions.proxy;
            activeBrowser = await chromium.launch(launchOptions);
            activeContext = await activeBrowser.newContext({
                userAgent: fp.userAgent,
                viewport: fp.viewport,
                locale: 'en-US',
                timezoneId: 'America/New_York',
            });
            await activeContext.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });
            console.log(`[FBScraper] ⚡ Relaunched with direct connect for ${accEmail}`);
        }
    }

    // ═══ PRIORITY 0: StorageState auth (from fb-login.js — most stable) ═══
    if (fs.existsSync(storageStatePath)) {
        console.log(`[FBScraper] 🔑 Found storageState: ${accUsername}_auth.json`);
        try {
            // Close existing context if any, create new one with storageState
            if (activeContext && activeBrowser) {
                try { await activeContext.close(); } catch { }
            }
            activeContext = await activeBrowser.newContext({
                storageState: storageStatePath,
                userAgent: fp.userAgent,
                viewport: fp.viewport,
                locale: 'en-US',
                timezoneId: 'America/New_York',
            });
            // Validate storageState session
            const testPage = await activeContext.newPage();
            await testPage.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await delay(2000);
            const testUrl = testPage.url();
            const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
            if (hasNav && !testUrl.includes('/login') && !testUrl.includes('checkpoint')) {
                console.log(`[FBScraper] ✅ StorageState session valid for ${accEmail}!`);
                isLoggedIn = true;
                // Auto-renew storageState with fresh tokens
                try { await activeContext.storageState({ path: storageStatePath }); } catch { }
                await testPage.close();
                return activeContext;
            }
            console.warn(`[FBScraper] ⚠️ StorageState expired for ${accEmail}, falling back to cookies...`);
            await testPage.close();
        } catch (err) {
            console.warn(`[FBScraper] ⚠️ StorageState error: ${err.message}`);
        }
        // Reset context for cookie-based fallback
        try { if (activeContext) await activeContext.close(); } catch { }
        activeContext = await activeBrowser.newContext({
            userAgent: fp.userAgent,
            viewport: fp.viewport,
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
    }

    // ═══ PRIORITY 1: Saved cookie session (account-specific) ═══
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
            // Auto-save as storageState for future (migrate cookie→storageState)
            try {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                await activeContext.storageState({ path: storageStatePath });
                console.log(`[FBScraper] 🔄 Migrated to storageState: ${accUsername}_auth.json`);
            } catch { }
            await page.close();
            return activeContext;
        }

        console.log(`[FBScraper] ⚠️ Session expired: ${accEmail} — trying per-account cookies...`);
        await page.close();
    }

    // ═══ PRIORITY 2: Per-account JSON cookie file (Cookie Editor export) ═══
    const cookieJsonPath = path.join(__dirname, '..', '..', 'data', `fb_cookies_${accUsername}.json`);
    if (fs.existsSync(cookieJsonPath)) {
        try {
            const rawCookies = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
            // Convert Cookie Editor format → Playwright format
            const playwrightCookies = rawCookies
                .filter(c => c.name && c.value && c.domain)
                .map(c => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    httpOnly: !!c.httpOnly,
                    secure: c.secure !== false,
                    sameSite: c.sameSite === 'no_restriction' ? 'None'
                        : c.sameSite === 'lax' ? 'Lax'
                            : c.sameSite === 'strict' ? 'Strict' : 'None',
                    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
                }));

            await activeContext.addCookies(playwrightCookies);
            console.log(`[FBScraper] 🍪 Injected ${playwrightCookies.length} cookies from ${path.basename(cookieJsonPath)}`);

            // Validate
            const testPage = await activeContext.newPage();
            await testPage.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await delay(2000);
            const testUrl = testPage.url();

            if (testUrl.includes('checkpoint') || testUrl.includes('two_step')) {
                console.warn(`[FBScraper] 🚨 Cookie file session hit checkpoint`);
                await testPage.close();
            } else {
                const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
                if (hasNav && !testUrl.includes('/login')) {
                    console.log(`[FBScraper] ✅ Cookie file session valid for ${accEmail}!`);
                    isLoggedIn = true;
                    // Auto-save as storageState (migrate cookie→storageState)
                    try {
                        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                        await activeContext.storageState({ path: storageStatePath });
                        console.log(`[FBScraper] 🔄 Auto-migrated to storageState: ${accUsername}_auth.json`);
                    } catch { }
                    await testPage.close();
                    return activeContext;
                }
                console.warn(`[FBScraper] ⚠️ Cookie file session not valid (no nav)`);
                await testPage.close();
            }
        } catch (jsonErr) {
            console.warn(`[FBScraper] ⚠️ Cookie file error: ${jsonErr.message}`);
        }
    }

    // ── Fallback 2: FB_COOKIES from .env (pre-authenticated session) ──
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
        const TARGET_FEED_CHILDREN = 60; // ~30 posts × 2 overshoot
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

    // Load groups: groups.db (all active) > prod_groups.json fallback > config fallback
    let targetGroups = groups;
    if (!targetGroups || targetGroups.length === 0) {
        try {
            const groupDiscovery = require('../agent/groupDiscovery');
            targetGroups = groupDiscovery.getScanRotationList(200);
        } catch { }
    }
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
            // Recycle page every 15 groups to prevent OOM crash
            if (i > 0 && i % 15 === 0) {
                console.log(`[FBScraper] 🔄 Recycling page (memory relief)...`);
                try { await page.close(); } catch { }
                page = await context.newPage();
                await delay(1000);
            }

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
 * Single-browser Facebook scraper with batched contexts.
 * 1 Chromium + max 2 contexts at a time (3 causes crashes).
 * 4GB RAM + 4GB swap = enough for full page loads without resource blocking.
 */
async function scrapeFacebookGroups(maxPosts = 20, options = {}, externalGroups = null) {
    const cfg = require('../config');
    const groups = (externalGroups && externalGroups.length > 0)
        ? externalGroups
        : (cfg.FB_TARGET_GROUPS || []);

    if (groups.length === 0) {
        console.log('[FBScraper] ⚠️ No target groups configured');
        return [];
    }

    const allAccounts = accountManager.getActiveAccounts ?
        accountManager.getActiveAccounts() :
        [accountManager.getNextAccount(options)].filter(Boolean);

    if (allAccounts.length === 0) {
        console.log('[FBScraper] ❌ No accounts available');
        return [];
    }

    // Split groups round-robin
    const accountGroupMap = {};
    for (const acc of allAccounts) accountGroupMap[acc.email] = { account: acc, groups: [] };
    groups.forEach((group, i) => {
        const acc = allAccounts[i % allAccounts.length];
        accountGroupMap[acc.email].groups.push(group);
    });

    console.log(`[FBScraper] 🚀 Scraping ${groups.length} groups across ${allAccounts.length} accounts`);
    for (const { account, groups: g } of Object.values(accountGroupMap)) {
        console.log(`[FBScraper]   📧 ${account.email}: ${g.length} groups`);
    }

    // Launch ONE browser with memory-saving args
    let browser = null;
    const allPosts = [];

    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--disable-extensions',
                '--disable-component-update',
                '--no-first-run',
                '--js-flags=--max-old-space-size=400',
            ],
        });
        console.log('[FBScraper] 🌐 Browser launched');

        // Run max 2 contexts at a time (3 causes OOM/crash)
        const MAX_PARALLEL = 2;
        const entries = Object.values(accountGroupMap);

        for (let i = 0; i < entries.length; i += MAX_PARALLEL) {
            const batch = entries.slice(i, i + MAX_PARALLEL);
            console.log(`[FBScraper] 🔄 Batch ${Math.floor(i / MAX_PARALLEL) + 1}: ${batch.map(b => b.account.email.split('@')[0]).join(' + ')}`);

            const tasks = batch.map(({ account, groups: accGroups }) =>
                _scrapeWithContext(browser, account, accGroups)
            );
            const results = await Promise.allSettled(tasks);
            for (const r of results) {
                if (r.status === 'fulfilled' && Array.isArray(r.value)) allPosts.push(...r.value);
            }
        }
    } catch (err) {
        console.error(`[FBScraper] 💥 Browser launch failed: ${err.message}`);
    } finally {
        try { if (browser) await browser.close(); } catch { }
    }

    console.log(`[FBScraper] ✅ Done: ${allPosts.length} posts from ${groups.length} groups`);
    return allPosts;
}

// Self-Heal functions moved to ./fbSelfHeal.js
// Exports: selfHealLogin, isSessionHealthy, getTotpSecret, getRecoveryCode, interactWithNewsfeed

/**
 * Scrape groups for ONE account using a context in the shared browser.
 * No resource blocking — 4GB + 4GB swap handles full FB pages.
 */
async function _scrapeWithContext(browser, account, groups) {
    const accEmail = account.email;
    const tag = `[${accEmail.split('@')[0]}]`;
    console.log(`\n${tag} ═══ Starting (${groups.length} groups) ═══`);

    // 🏥 SESSION HEALTH CHECK — verify cookies before scraping
    const health = isSessionHealthy(accEmail.split('@')[0]);
    if (health.healthy) {
        console.log(`${tag} 🏥 Session HEALTHY: ${health.cookieCount} cookies, c_user: ✅, xs: ✅`);
    } else {
        console.log(`${tag} 🏥 Session WEAK: ${health.cookieCount} cookies, c_user: ${health.hasCUser ? '✅' : '❌'}, xs: ${health.hasXs ? '✅' : '❌'} → will need self-healing`);
    }

    const fp = generateFingerprint({ region: 'US', accountId: accEmail });
    let context = null;
    const posts = [];

    try {
        context = await browser.newContext({
            userAgent: fp.userAgent,
            viewport: fp.viewport,
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });

        // NO route interception — it was causing browser crashes
        // (intercepting every XHR/GraphQL request creates too many pending handlers)
        // 4GB RAM + 4GB swap is enough for full page loads

        // Load cookies: JSON file FIRST, session fallback
        const accUsername = accEmail.split('@')[0];
        const cookieJsonPath = path.join(__dirname, '..', '..', 'data', `fb_cookies_${accUsername}.json`);
        const sessionDir = path.join(__dirname, '..', '..', 'data', 'fb_sessions');
        const sessionPath = path.join(sessionDir, `${accEmail.replace(/[@.]/g, '_')}.json`);
        let loaded = false;

        if (fs.existsSync(cookieJsonPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
                const pwc = raw.filter(c => c.name && c.value && c.domain).map(c => ({
                    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
                    httpOnly: !!c.httpOnly, secure: c.secure !== false,
                    sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None',
                    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
                }));
                await context.addCookies(pwc); loaded = true;
                console.log(`${tag} 🍪 Cookies from ${path.basename(cookieJsonPath)} (${pwc.length})`);
                try { if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath); } catch { }
            } catch (e) { console.warn(`${tag} ⚠️ Cookie error: ${e.message}`); }
        }
        if (!loaded && fs.existsSync(sessionPath)) {
            try {
                const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (saved.length > 0) { await context.addCookies(saved); loaded = true; console.log(`${tag} 📂 Session fallback (${saved.length} cookies)`); }
            } catch { }
        }
        if (!loaded) {
            const env = process.env.FB_COOKIES || '';
            if (env.includes('c_user=')) {
                const pwc = env.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
                    const [n, ...r] = pair.split('=');
                    return { name: n.trim(), value: r.join('=').trim(), domain: '.facebook.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' };
                });
                await context.addCookies(pwc);
                console.log(`${tag} 🍪 Cookies from .env (${pwc.length})`);
            }
        }

        // Validate session
        const testPage = await context.newPage();
        await testPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(3000);
        const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
        const testUrl = testPage.url();
        if (!hasNav || testUrl.includes('/login') || testUrl.includes('checkpoint')) {
            console.warn(`${tag} ❌ Session invalid — attempting self-healing...`);
            await testPage.close();

            // ═══ SELF-HEALING: Auto-login with 2FA ═══
            const ssPath = await selfHealLogin(browser, account, tag);
            if (!ssPath) {
                console.warn(`${tag} 💀 Self-healing failed — skipping account`);
                await context.close(); return [];
            }
            // Replace old context with fresh authenticated one
            await context.close();
            context = await browser.newContext({
                storageState: ssPath,
                userAgent: fp.userAgent,
                viewport: fp.viewport,
                locale: 'en-US',
                timezoneId: 'America/New_York',
            });
            console.log(`${tag} 🔄 Self-healing successful! New context loaded from ${path.basename(ssPath)}`);
        } else {
            console.log(`${tag} ✅ Session valid!`);
            await testPage.close();
        }

        // AUTO-RENEW: Save fresh cookies + storageState
        try {
            const freshCookies = await context.cookies();
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(sessionPath, JSON.stringify(freshCookies, null, 2));
            if (fs.existsSync(cookieJsonPath)) {
                const fbCookies = freshCookies.filter(c => c.domain?.includes('facebook'));
                if (fbCookies.length > 0) {
                    fs.writeFileSync(cookieJsonPath, JSON.stringify(fbCookies, null, 2));
                    console.log(`${tag} 🔄 Cookies auto-renewed → ${path.basename(cookieJsonPath)} (${fbCookies.length})`);
                }
            }
            // StorageState migration
            const ssDir = path.join(__dirname, '..', '..', 'data', 'sessions');
            const ssPath = path.join(ssDir, `${accUsername}_auth.json`);
            fs.mkdirSync(ssDir, { recursive: true });
            await context.storageState({ path: ssPath });
            console.log(`${tag} 🔑 StorageState saved → ${accUsername}_auth.json`);
        } catch (e) { console.warn(`${tag} ⚠️ Cookie save error: ${e.message}`); }

        // ═══ NEWSFEED WARM-UP: Browse like a real human before scraping ═══
        const warmPage = await context.newPage();
        try {
            console.log(`${tag} 🏠 Newsfeed warm-up...`);
            await warmPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await delay(3000);
            // Scroll newsfeed 2-3 times like reading
            const scrolls = 2 + Math.floor(Math.random() * 2);
            for (let s = 0; s < scrolls; s++) {
                await warmPage.evaluate(() => window.scrollBy(0, 800 + Math.random() * 600));
                await delay(2000 + Math.random() * 3000);
            }
            console.log(`${tag} 🏠 Warm-up done (${scrolls} scrolls)`);
        } catch (e) { console.warn(`${tag} ⚠️ Warm-up error: ${e.message}`); }
        await warmPage.close();
        await delay(2000 + Math.random() * 3000); // Brief pause before starting

        // Scrape each group (reuse page)
        const page = await context.newPage();

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const groupId = extractGroupId(group.url);
            if (!groupId) continue;

            try {
                // ═══ HUMAN-LIKE JITTER between groups ═══
                if (i > 0) {
                    const jitter = 8000 + Math.random() * 12000; // 8-20 seconds
                    console.log(`${tag} 😴 Jitter: ${(jitter / 1000).toFixed(1)}s`);
                    await delay(jitter);
                    // Every 5th group: take a longer "coffee break"
                    if (i % 5 === 0) {
                        const breakTime = 25000 + Math.random() * 20000; // 25-45 seconds
                        console.log(`${tag} ☕ Coffee break: ${(breakTime / 1000).toFixed(0)}s`);
                        await delay(breakTime);
                    }
                }

                console.log(`${tag} [${i + 1}/${groups.length}] 📥 ${group.name}`);
                await page.goto(`https://www.facebook.com/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(3000 + Math.random() * 2000); // 3-5s after page load

                const url = page.url();
                if (url.includes('checkpoint')) {
                    console.warn(`${tag} 🚨 ${group.name}: REAL checkpoint — stopping account`);
                    accountManager.reportCheckpoint(account.id);
                    break;
                }
                if (url.includes('/login')) {
                    console.log(`${tag} 🔒 ${group.name}: login redirect (restricted) — skipping`);
                    continue;
                }

                let hasFeed = false;
                try { await page.waitForSelector('div[role="feed"]', { timeout: 12000 }); hasFeed = true; }
                catch {
                    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
                    const isJoinPage = pageText.toLowerCase().includes('join group') || pageText.includes('Tham gia nh');
                    if (isJoinPage) {
                        console.log(`${tag} 🚪 ${group.name}: NOT A MEMBER — joining inline...`);
                        try {
                            const joinBtn = await page.$('div[role="button"]:has-text("Join"), div[role="button"]:has-text("Tham gia")');
                            if (joinBtn) {
                                await joinBtn.click();
                                await delay(3000);
                                const afterText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
                                if (afterText.includes('Pending') || afterText.includes('pending') || afterText.includes('Chờ')) {
                                    console.log(`${tag} ⏳ ${group.name}: pending approval — skip`);
                                    continue;
                                }
                                console.log(`${tag} ✅ ${group.name}: Joined! Reloading...`);
                                await page.goto(`https://www.facebook.com/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 25000 });
                                await delay(3000);
                                try { await page.waitForSelector('div[role="feed"]', { timeout: 8000 }); hasFeed = true; }
                                catch { console.log(`${tag} ⚠️ ${group.name}: joined but feed not visible yet`); }
                            }
                        } catch (joinErr) { console.warn(`${tag} ⚠️ ${group.name}: join failed: ${joinErr.message.substring(0, 50)}`); }
                    } else {
                        console.log(`${tag} ⚠️ ${group.name}: no feed visible`);
                    }
                }
                if (!hasFeed) continue;

                // Scroll to load more posts
                let noGrowth = 0, prevCnt = 0;
                for (let s = 0; s < 25; s++) {
                    await page.evaluate(() => window.scrollBy(0, 2000));
                    await delay(1000);
                    const cnt = await page.evaluate(() => {
                        const f = document.querySelector('div[role="feed"]');
                        return f ? f.querySelectorAll('div[role="article"]').length : 0;
                    });
                    if (cnt >= 25) break;
                    if (cnt === prevCnt) { noGrowth++; if (noGrowth >= 3) break; } else { noGrowth = 0; }
                    prevCnt = cnt;
                }

                // Click "See More" buttons to expand truncated posts
                try {
                    const seeMoreBtns = await page.$$('div[role="button"]:has-text("See more"), div[role="button"]:has-text("Xem thêm")');
                    for (const btn of seeMoreBtns.slice(0, 15)) {
                        await btn.click().catch(() => { });
                    }
                    if (seeMoreBtns.length > 0) await delay(500);
                } catch { }

                // Extract posts with real timestamps from FB DOM
                const MAX_AGE_DAYS = 3;
                const gPosts = await page.evaluate(({ gName, gUrl, maxAgeDays }) => {
                    const feed = document.querySelector('div[role="feed"]');
                    if (!feed) return [];

                    // Parse FB relative time string → age in hours
                    function parseRelativeTime(timeStr) {
                        if (!timeStr) return null;
                        const s = timeStr.trim().toLowerCase();
                        // "just now", "vừa xong"
                        if (s.includes('just now') || s.includes('vừa xong') || s === 'now') return 0;
                        // "Xm" or "X min" or "X phút"
                        let m = s.match(/(\d+)\s*(m\b|min|mins|minute|minutes|phút)/);
                        if (m) return parseInt(m[1]) / 60;
                        // "Xh" or "X hours" or "X giờ"
                        m = s.match(/(\d+)\s*(h\b|hr|hrs|hour|hours|giờ)/);
                        if (m) return parseInt(m[1]);
                        // "Xd" or "X days" or "X ngày"
                        m = s.match(/(\d+)\s*(d\b|day|days|ngày)/);
                        if (m) return parseInt(m[1]) * 24;
                        // "Xw" or "X weeks" or "X tuần"
                        m = s.match(/(\d+)\s*(w\b|wk|wks|week|weeks|tuần)/);
                        if (m) return parseInt(m[1]) * 24 * 7;
                        // "X tháng" or "X months" — always > 3 days
                        m = s.match(/(\d+)\s*(tháng|month|months|mo\b)/);
                        if (m) return parseInt(m[1]) * 24 * 30;
                        // "X năm" or "X years" — always very old
                        m = s.match(/(\d+)\s*(năm|year|years|yr|yrs)/);
                        if (m) return parseInt(m[1]) * 24 * 365;
                        // "yesterday" / "hôm qua"
                        if (s.includes('yesterday') || s.includes('hôm qua')) return 24;

                        // Full date: "28 tháng 2, 2023" or "10 tháng 3"
                        m = s.match(/(\d{1,2})\s*tháng\s*(\d{1,2})(?:,?\s*(\d{4}))?/);
                        if (m) {
                            const day = parseInt(m[1]), month = parseInt(m[2]) - 1;
                            const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
                            const postDate = new Date(year, month, day);
                            const ageMs = Date.now() - postDate.getTime();
                            return ageMs > 0 ? ageMs / (1000 * 3600) : 0;
                        }
                        // Full date EN: "March 10, 2023", "Feb 28, 2023", "Mar 10 at 2:30 PM"
                        const monthNames = {
                            jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
                            january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
                        };
                        m = s.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
                        if (m) {
                            const month = monthNames[m[1].toLowerCase().substring(0, 3)];
                            const day = parseInt(m[2]);
                            const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
                            const postDate = new Date(year, month, day);
                            const ageMs = Date.now() - postDate.getTime();
                            return ageMs > 0 ? ageMs / (1000 * 3600) : 0;
                        }

                        // If contains year number like "2023", "2024", "2025" → parse as old
                        m = s.match(/\b(20[12]\d)\b/);
                        if (m) {
                            const year = parseInt(m[1]);
                            // If year < current year → definitely old
                            if (year < new Date().getFullYear()) return 24 * 365;
                        }

                        return null;
                    }

                    const articles = feed.querySelectorAll(':scope > div');
                    const res = [];
                    const seenUrls = new Set();
                    const now = Date.now();

                    articles.forEach(a => {
                        const txt = a.innerText || '';
                        if (txt.length < 50) return;

                        // Get permalink (multiple patterns)
                        const links = Array.from(a.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/groups/"][href*="/posts/"]'));
                        let rawUrl = links[0]?.href || '';
                        // Fallback: any link that looks like a FB post URL
                        if (!rawUrl) {
                            const allA = a.querySelectorAll('a[href]');
                            for (const al of allA) {
                                const h = al.href || '';
                                if (h.includes('facebook.com') && (h.includes('/posts/') || h.includes('story_fbid') || h.includes('/permalink/'))) {
                                    rawUrl = h; break;
                                }
                            }
                        }
                        const postUrl = rawUrl.split('?')[0];
                        if (postUrl && seenUrls.has(postUrl)) return;
                        if (postUrl) seenUrls.add(postUrl);

                        // === EXTRACT REAL TIMESTAMP ===
                        // Strategy 1: aria-label on permalink link (most reliable)
                        let timeStr = '';
                        for (const link of links) {
                            const ariaTime = link.getAttribute('aria-label');
                            if (ariaTime && ariaTime.match(/\d/)) { timeStr = ariaTime; break; }
                            // Text inside the link (e.g. "2h", "1d")
                            const linkText = link.innerText?.trim();
                            if (linkText && linkText.match(/^\d+[mhdw]$|^just now$|^yesterday$/i)) { timeStr = linkText; break; }
                        }
                        // Strategy 2: abbr element (classic FB)
                        if (!timeStr) {
                            const abbr = a.querySelector('abbr');
                            if (abbr) timeStr = abbr.textContent?.trim() || abbr.getAttribute('title') || '';
                        }
                        // Strategy 3: span near timestamp area (expanded patterns)
                        if (!timeStr) {
                            const spans = a.querySelectorAll('span');
                            for (const sp of spans) {
                                const t = sp.textContent?.trim();
                                if (t && t.match(/^\d+[mhdw]$|^just now$|^yesterday$|^hôm qua$|^\d+\s*(phút|giờ|ngày|tuần|năm|tháng|year|month|week|day|hour|min)/i)) {
                                    timeStr = t; break;
                                }
                                // Also catch full date strings in spans
                                if (t && t.match(/^\d{1,2}\s*tháng\s*\d{1,2}/i)) {
                                    timeStr = t; break;
                                }
                                if (t && t.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i)) {
                                    timeStr = t; break;
                                }
                            }
                        }

                        // Parse to age in hours
                        const ageHours = parseRelativeTime(timeStr);
                        const ageDays = ageHours !== null ? ageHours / 24 : null;

                        // FILTER: skip posts older than maxAgeDays
                        // Also skip posts with NO parseable timestamp (assume old/pinned)
                        if (ageDays !== null && ageDays > maxAgeDays) return;
                        if (ageDays === null && timeStr) return; // Had text but couldn't parse → likely old

                        // Convert to ISO date
                        let postedAt = '';
                        if (ageHours !== null) {
                            postedAt = new Date(now - ageHours * 3600 * 1000).toISOString();
                        }

                        // === EXTRACT AUTHOR NAME (multi-strategy) ===
                        let author = '';
                        let authorUrl = '';

                        // Strategy 1: Profile image alt text (most reliable on modern FB)
                        const profileImg = a.querySelector('image, img[src*="scontent"], svg image');
                        if (profileImg) {
                            const alt = profileImg.getAttribute('alt') || profileImg.closest('[aria-label]')?.getAttribute('aria-label') || '';
                            if (alt && alt.length > 1 && alt.length < 80 && !alt.match(/photo|hình|ảnh|image|like|comment/i)) {
                                author = alt.replace(/'s profile.*|'s photo.*/i, '').trim();
                            }
                        }

                        // Strategy 2: Header links to user profile (FB uses /user/ or profile.php)
                        if (!author) {
                            const headerLinks = a.querySelectorAll('a[href*="/user/"], a[href*="profile.php"], a[href*="facebook.com/"][role="link"]');
                            for (const hl of headerLinks) {
                                const name = hl.innerText?.trim();
                                const href = hl.href || '';
                                if (name && name.length > 1 && name.length < 60
                                    && !name.match(/^(\d+[mhdw]|just now|yesterday|hôm qua|like|comment|share|chia sẻ)$/i)
                                    && !href.includes('/posts/') && !href.includes('/permalink/') && !href.includes('story_fbid')) {
                                    author = name;
                                    authorUrl = href.split('?')[0];
                                    break;
                                }
                            }
                        }

                        // Strategy 3: Classic FB (h2/h3/strong links)
                        if (!author) {
                            const classicEl = a.querySelector('h2 a, h3 a, h4 a, strong a[role="link"]');
                            if (classicEl) {
                                author = classicEl.innerText?.trim() || '';
                                authorUrl = authorUrl || (classicEl.href || '').split('?')[0];
                            }
                        }

                        // Strategy 4: First <a> with user profile URL pattern
                        if (!author) {
                            const allLinks = a.querySelectorAll('a[href]');
                            for (const al of allLinks) {
                                const href = al.href || '';
                                if ((href.includes('facebook.com/') && !href.includes('/posts/') && !href.includes('/groups/')
                                    && !href.includes('/permalink/') && !href.includes('story_fbid') && !href.includes('#')
                                    && !href.includes('/photos/') && !href.includes('/videos/'))) {
                                    const name = al.innerText?.trim();
                                    if (name && name.length > 1 && name.length < 60 && !name.match(/^\d+$/)) {
                                        author = name;
                                        authorUrl = href.split('?')[0];
                                        break;
                                    }
                                }
                            }
                        }

                        // Strategy 5: First strong/span text in header area (last resort)
                        if (!author) {
                            const headerStrong = a.querySelector('strong');
                            if (headerStrong) {
                                const name = headerStrong.innerText?.trim();
                                if (name && name.length > 1 && name.length < 60) author = name;
                            }
                        }

                        res.push({
                            platform: 'facebook',
                            group_name: gName,
                            group_url: gUrl,
                            post_url: postUrl,
                            author_name: author || 'Unknown',
                            author_url: authorUrl,
                            author_avatar: '',
                            content: txt.substring(0, 2000),
                            post_created_at: postedAt,
                            time_raw: timeStr,
                            scraped_at: new Date().toISOString(),
                            source_group: gName,
                            item_type: 'post'
                        });
                    });
                    return res;
                }, { gName: group.name, gUrl: group.url, maxAgeDays: MAX_AGE_DAYS });

                posts.push(...gPosts);
                console.log(`${tag} ✅ ${group.name}: ${gPosts.length} posts (total: ${posts.length})`);
                accountManager.reportSuccess(account.id, gPosts.length);
            } catch (err) {
                console.warn(`${tag} ❌ ${group.name}: ${err.message.substring(0, 80)}`);
            }

            // 5-10s delay between groups for safety
            if (i < groups.length - 1) await delay(5000 + Math.random() * 5000);
            if (i > 0 && i % 5 === 0) { const m = process.memoryUsage(); console.log(`${tag} 💾 RSS=${Math.round(m.rss / 1024 / 1024)}MB`); }
        }
        await page.close();
    } catch (err) {
        console.error(`${tag} 💥 Fatal: ${err.message}`);
    } finally {
        try { if (context) await context.close(); } catch { }
        console.log(`${tag} 🏁 Done: ${posts.length} posts`);
    }
    return posts;
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
