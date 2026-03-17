/**
 * Authentication Context Manager
 * Handles Facebook login, cookie restoration, and session management.
 * 
 * @module scraper/authContext
 */
const {
    state, chromium, delay, FB_URL, COOKIES_PATH, SESSIONS_DIR,
    FB_EMAIL, FB_PASSWORD, fs, path, pool, generateFingerprint,
    saveSession, loadSession
} = require('./browserManager');
const accountManager = require('../../ai/agents/accountManager');

/**
 * Login to Facebook via Playwright
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

    const emailInput = await page.$('input[name="email"], input#email');
    if (emailInput) {
        await emailInput.click();
        await emailInput.fill(loginEmail);
    } else {
        console.error('[FBScraper] ❌ Email input not found');
        return false;
    }
    await delay(800);

    const passInput = await page.$('input[name="pass"], input#pass');
    if (passInput) {
        await passInput.click();
        await passInput.fill(loginPassword);
    } else {
        console.error('[FBScraper] ❌ Password input not found');
        return false;
    }
    await delay(800);

    await passInput.press('Enter');
    console.log('[FBScraper] ⏳ Waiting for login response...');
    await delay(8000);

    const currentUrl = page.url();
    console.log(`[FBScraper] 📍 Post-login URL: ${currentUrl}`);

    try {
        fs.mkdirSync(path.join(__dirname, '..', '..', '..', 'data'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '..', '..', '..', 'data', 'fb_login_debug.png') });
        console.log('[FBScraper] 📸 Debug screenshot saved to data/fb_login_debug.png');
    } catch { }

    if (currentUrl.includes('checkpoint') || currentUrl.includes('two_step')) {
        console.log(`[FBScraper] ⚠️ 2FA/Checkpoint at: ${currentUrl}`);
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
            return false;
        }
    }

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

    if (!currentUrl.includes('/login')) {
        console.log(`[FBScraper] ✅ Login successful!`);
        state.isLoggedIn = true;
        await delay(3000);
        return true;
    }

    console.error(`[FBScraper] ❌ Login failed — still on login page`);
    return false;
}

/**
 * Get or create an authenticated browser context.
 * Account-aware: uses AccountManager for rotation + per-account session/proxy.
 */
async function getAuthContext(account = null) {
    const accEmail = account?.email || FB_EMAIL;
    const accPassword = account?.password || FB_PASSWORD;
    const accProxy = account?.proxy_url || '';
    const sessionPath = account ? accountManager.getSessionPath(account) : COOKIES_PATH;
    const accUsername = accEmail.split('@')[0];
    const storageStatePath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);

    state.sessionAge++;

    // Rotate browser session periodically
    if (state.activeBrowser && state.sessionAge > state.MAX_SESSION_AGE) {
        console.log('[FBScraper] 🔄 Rotating browser session...');
        if (state.activeContext) {
            try {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                await state.activeContext.storageState({ path: storageStatePath });
                console.log(`[FBScraper] 💾 StorageState saved → ${accUsername}_auth.json`);
            } catch (e) {
                try {
                    const cookies = await state.activeContext.cookies();
                    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
                    fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
                } catch { }
            }
        }
        try { await state.activeBrowser.close(); } catch { }
        state.activeBrowser = null;
        state.activeContext = null;
        state.isLoggedIn = false;
        state.sessionAge = 0;
    }

    if (state.activeContext && state.isLoggedIn) return state.activeContext;

    // Persistent context
    const PROFILE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'fb_browser_profile');
    if (!state.activeContext && fs.existsSync(PROFILE_DIR) && !accProxy) {
        try {
            console.log(`[FBScraper] 📁 Using persistent browser profile (${accEmail})`);
            const persistCtx = await chromium.launchPersistentContext(PROFILE_DIR, {
                headless: true,
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            });
            state.activeContext = persistCtx;
            state.activeBrowser = null;
            state.isLoggedIn = true;
            state.sessionAge = 0;
            console.log(`[FBScraper] ✅ Persistent session loaded`);
            return state.activeContext;
        } catch (err) {
            console.warn(`[FBScraper] ⚠️ Persistent context failed: ${err.message} — falling back to cookie session`);
            state.activeContext = null;
        }
    }

    // Build launch options
    const launchOptions = {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    };

    if (accProxy) {
        try {
            const pUrl = new URL(accProxy);
            launchOptions.proxy = { server: `${pUrl.protocol}//${pUrl.hostname}:${pUrl.port}` };
            if (pUrl.username) {
                launchOptions.proxy.username = decodeURIComponent(pUrl.username);
                launchOptions.proxy.password = decodeURIComponent(pUrl.password);
            }
            console.log(`[FBScraper] 🔒 Using dedicated proxy for ${accEmail}`);
        } catch { }
    } else if (pool.loaded && pool.hasProxies()) {
        const best = pool.getBestProxy();
        if (best) {
            try {
                const pUrl = new URL(best.proxyUrl);
                launchOptions.proxy = { server: `${pUrl.protocol}//${pUrl.hostname}:${pUrl.port}` };
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

    state.activeBrowser = await chromium.launch(launchOptions);
    state.activeContext = await state.activeBrowser.newContext({
        userAgent: fp.userAgent,
        viewport: fp.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Block heavy resources
    await state.activeContext.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
        return route.continue();
    });

    // Proxy connectivity test
    if (launchOptions.proxy) {
        let proxyWorks = false;
        try {
            const testPage = await state.activeContext.newPage();
            await testPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await testPage.close();
            proxyWorks = true;
            console.log(`[FBScraper] ✅ Proxy works for Facebook`);
        } catch (proxyErr) {
            console.warn(`[FBScraper] ⚠️ Proxy failed: ${proxyErr.message.substring(0, 80)}`);
        }

        if (!proxyWorks) {
            console.warn(`[FBScraper] 🔄 Falling back to direct connect...`);
            try { await state.activeBrowser.close(); } catch { }
            state.activeBrowser = null;
            state.activeContext = null;

            delete launchOptions.proxy;
            state.activeBrowser = await chromium.launch(launchOptions);
            state.activeContext = await state.activeBrowser.newContext({
                userAgent: fp.userAgent, viewport: fp.viewport,
                locale: 'en-US', timezoneId: 'America/New_York',
            });
            await state.activeContext.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
                return route.continue();
            });
            console.log(`[FBScraper] ⚡ Relaunched with direct connect for ${accEmail}`);
        }
    }

    // PRIORITY 0: StorageState
    if (fs.existsSync(storageStatePath)) {
        console.log(`[FBScraper] 🔑 Found storageState: ${accUsername}_auth.json`);
        try {
            if (state.activeContext && state.activeBrowser) {
                try { await state.activeContext.close(); } catch { }
            }
            state.activeContext = await state.activeBrowser.newContext({
                storageState: storageStatePath,
                userAgent: fp.userAgent, viewport: fp.viewport,
                locale: 'en-US', timezoneId: 'America/New_York',
            });
            const testPage = await state.activeContext.newPage();
            await testPage.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await delay(2000);
            const testUrl = testPage.url();
            const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
            if (hasNav && !testUrl.includes('/login') && !testUrl.includes('checkpoint')) {
                console.log(`[FBScraper] ✅ StorageState session valid for ${accEmail}!`);
                state.isLoggedIn = true;
                try { await state.activeContext.storageState({ path: storageStatePath }); } catch { }
                await testPage.close();
                return state.activeContext;
            }
            console.warn(`[FBScraper] ⚠️ StorageState expired for ${accEmail}, falling back to cookies...`);
            await testPage.close();
        } catch (err) {
            console.warn(`[FBScraper] ⚠️ StorageState error: ${err.message}`);
        }
        try { if (state.activeContext) await state.activeContext.close(); } catch { }
        state.activeContext = await state.activeBrowser.newContext({
            userAgent: fp.userAgent, viewport: fp.viewport,
            locale: 'en-US', timezoneId: 'America/New_York',
        });
    }

    // PRIORITY 1: Saved cookie session
    const savedCookies = loadSession(sessionPath);
    if (savedCookies && savedCookies.length > 0) {
        await state.activeContext.addCookies(savedCookies);
        console.log(`[FBScraper] 🍪 Restored session: ${accEmail}`);
        const page = await state.activeContext.newPage();
        await page.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(1500);
        const url = page.url();

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
            state.isLoggedIn = true;
            try {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                await state.activeContext.storageState({ path: storageStatePath });
                console.log(`[FBScraper] 🔄 Migrated to storageState: ${accUsername}_auth.json`);
            } catch { }
            await page.close();
            return state.activeContext;
        }
        console.log(`[FBScraper] ⚠️ Session expired: ${accEmail} — trying per-account cookies...`);
        await page.close();
    }

    // PRIORITY 2: Per-account JSON cookie file
    const cookieJsonPath = path.join(__dirname, '..', '..', '..', 'data', `fb_cookies_${accUsername}.json`);
    if (fs.existsSync(cookieJsonPath)) {
        try {
            const rawCookies = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
            const playwrightCookies = rawCookies
                .filter(c => c.name && c.value && c.domain)
                .map(c => ({
                    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
                    httpOnly: !!c.httpOnly, secure: c.secure !== false,
                    sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None',
                    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
                }));

            await state.activeContext.addCookies(playwrightCookies);
            console.log(`[FBScraper] 🍪 Injected ${playwrightCookies.length} cookies from ${path.basename(cookieJsonPath)}`);

            const testPage = await state.activeContext.newPage();
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
                    state.isLoggedIn = true;
                    try {
                        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                        await state.activeContext.storageState({ path: storageStatePath });
                        console.log(`[FBScraper] 🔄 Auto-migrated to storageState: ${accUsername}_auth.json`);
                    } catch { }
                    await testPage.close();
                    return state.activeContext;
                }
                console.warn(`[FBScraper] ⚠️ Cookie file session not valid (no nav)`);
                await testPage.close();
            }
        } catch (jsonErr) {
            console.warn(`[FBScraper] ⚠️ Cookie file error: ${jsonErr.message}`);
        }
    }

    // Fallback: FB_COOKIES from .env
    const envCookies = process.env.FB_COOKIES || '';
    if (envCookies && envCookies.includes('c_user=') && envCookies.includes('xs=')) {
        console.log(`[FBScraper] 🍪 Trying FB_COOKIES from .env...`);
        try {
            const playwrightCookies = envCookies.split(';').map(part => part.trim()).filter(Boolean).map(part => {
                const eqIdx = part.indexOf('=');
                if (eqIdx < 0) return null;
                const name = part.substring(0, eqIdx).trim();
                const value = part.substring(eqIdx + 1).trim();
                if (!name) return null;
                return { name, value, domain: '.facebook.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' };
            }).filter(Boolean);

            if (playwrightCookies.length >= 2) {
                await state.activeContext.addCookies(playwrightCookies);
                console.log(`[FBScraper] 🍪 Injected ${playwrightCookies.length} cookies from FB_COOKIES env`);
                const testPage = await state.activeContext.newPage();
                await testPage.goto(`${FB_URL}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await delay(2000);
                const testUrl = testPage.url();

                if (testUrl.includes('checkpoint') || testUrl.includes('two_step')) {
                    console.warn(`[FBScraper] 🚨 FB_COOKIES session hit checkpoint — falling through to login`);
                    await testPage.close();
                } else {
                    const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
                    if (hasNav && !testUrl.includes('/login')) {
                        console.log(`[FBScraper] ✅ FB_COOKIES session valid!`);
                        state.isLoggedIn = true;
                        try {
                            const cookies = await state.activeContext.cookies();
                            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
                            fs.writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
                        } catch { }
                        await testPage.close();
                        return state.activeContext;
                    }
                    console.warn(`[FBScraper] ⚠️ FB_COOKIES session not valid — falling through to login`);
                    await testPage.close();
                }
            }
        } catch (cookieErr) {
            console.warn(`[FBScraper] ⚠️ FB_COOKIES fallback failed: ${cookieErr.message}`);
        }
    }

    // Login
    const loginPage = await state.activeContext.newPage();
    const success = await loginToFacebook(loginPage, accEmail, accPassword);
    await loginPage.close();

    if (success) {
        try {
            const cookies = await state.activeContext.cookies();
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

    return state.activeContext;
}

module.exports = { loginToFacebook, getAuthContext };
