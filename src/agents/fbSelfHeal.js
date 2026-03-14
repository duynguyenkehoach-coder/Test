/**
 * THG Lead Gen — Facebook Self-Healing Login Module
 * 
 * Strategy: Raw HTTP Login (axios) → Golden Session (Playwright)
 * 
 * WHY HTTP instead of Playwright for login:
 *   - mbasic.facebook.com 302-redirects to www (server-side, can't prevent)
 *   - www with JS OFF = empty page (React SPA needs JS)
 *   - www with JS ON = Arkose Labs CAPTCHA blocks form
 *   - Raw HTTP = invisible to Arkose, no browser fingerprint
 * 
 * Phase 1: HTTP Login on m.facebook.com
 *   - GET login page → parse HTML form fields (lsd, jazoest)
 *   - POST credentials → follow redirects → get auth cookies
 *   - If 2FA → parse checkpoint form → POST TOTP/recovery code
 *   - Collect all Set-Cookie headers
 * 
 * Phase 2: Golden Session (Playwright, JS enabled)
 *   - Inject HTTP cookies into Playwright context
 *   - Identity Forcing: /me → forces c_user + xs creation
 *   - Newsfeed warm-up: scroll + random Like
 *   - Backup golden session to "safe vault"
 * 
 * @module agents/fbSelfHeal
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// ═══════════════════════════════════════════════════════
// Built-in TOTP generator (crypto-based, no otplib dep)
// ═══════════════════════════════════════════════════════
const authenticator = {
    generate(secret) {
        const cleanSecret = secret.replace(/\s/g, '');
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
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / 30);
        const counterBuf = Buffer.alloc(8);
        counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
        counterBuf.writeUInt32BE(counter & 0xFFFFFFFF, 4);
        const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
        return code.toString().padStart(6, '0');
    }
};

// ═══════════════════════════════════════════════════════
// Constants & Paths
// ═══════════════════════════════════════════════════════

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const BACKUP_DIR = path.join(SESSIONS_DIR, 'backups');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// TOTP / Recovery Code helpers
// ═══════════════════════════════════════════════════════

function getTotpSecret(email) {
    let i = 1;
    while (process.env[`FB_ACCOUNT_${i}_EMAIL`]) {
        if (process.env[`FB_ACCOUNT_${i}_EMAIL`] === email) {
            return process.env[`FB_ACCOUNT_${i}_TOTP_SECRET`] || null;
        }
        i++;
    }
    return null;
}

function getRecoveryCode(accUsername) {
    const codesPath = path.join(DATA_DIR, `recovery_codes_${accUsername}.json`);
    if (!fs.existsSync(codesPath)) return null;
    try {
        const codes = JSON.parse(fs.readFileSync(codesPath, 'utf8'));
        if (!Array.isArray(codes) || codes.length === 0) return null;
        const code = codes.shift();
        fs.writeFileSync(codesPath, JSON.stringify(codes, null, 2));
        console.log(`[SelfHeal] 🎫 Recovery codes remaining for ${accUsername}: ${codes.length}`);
        return code;
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════
// Session Health Check
// ═══════════════════════════════════════════════════════

function isSessionHealthy(accUsername) {
    const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
    const backupPath = path.join(BACKUP_DIR, `${accUsername}_auth.json`);

    // Auto-restore from backup if main file missing
    if (!fs.existsSync(ssPath) && fs.existsSync(backupPath)) {
        console.log(`[SelfHeal] 🔄 Restoring ${accUsername} from backup...`);
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.copyFileSync(backupPath, ssPath);
    }

    if (fs.existsSync(ssPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
            const cookies = data.cookies || [];
            const hasCUser = cookies.some(c => c.name === 'c_user');
            const hasXs = cookies.some(c => c.name === 'xs');
            return { healthy: hasCUser && hasXs && cookies.length >= 10, cookieCount: cookies.length, hasCUser, hasXs };
        } catch { }
    }
    const cookiePath = path.join(DATA_DIR, `fb_cookies_${accUsername}.json`);
    if (fs.existsSync(cookiePath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
            const hasCUser = cookies.some(c => c.name === 'c_user');
            const hasXs = cookies.some(c => c.name === 'xs');
            return { healthy: hasCUser && hasXs && cookies.length >= 10, cookieCount: cookies.length, hasCUser, hasXs };
        } catch { }
    }
    return { healthy: false, cookieCount: 0, hasCUser: false, hasXs: false };
}

// ═══════════════════════════════════════════════════════
// Session Cleanup & Backup
// ═══════════════════════════════════════════════════════

/** Clear invalid session files before self-heal */
function clearInvalidSession(accUsername) {
    const targets = [
        path.join(SESSIONS_DIR, `${accUsername}_auth.json`),
        path.join(DATA_DIR, `fb_cookies_${accUsername}.json`),
    ];
    console.log(`[SelfHeal] 🧹 Clearing old session for ${accUsername}...`);
    for (const fp of targets) {
        try {
            if (fs.existsSync(fp)) {
                fs.unlinkSync(fp);
                console.log(`[SelfHeal]   🗑️ Deleted: ${path.basename(fp)}`);
            }
        } catch (e) { console.warn(`[SelfHeal]   ⚠️ Could not delete ${path.basename(fp)}: ${e.message}`); }
    }
}

/** Backup golden session to safe vault */
function backupGoldenSession(accUsername) {
    const source = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
    const target = path.join(BACKUP_DIR, `${accUsername}_auth.json`);
    try {
        if (fs.existsSync(source)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
            fs.copyFileSync(source, target);
            console.log(`[SelfHeal] 💾 Backed up golden session → backups/${accUsername}_auth.json`);
        }
    } catch (e) { console.warn(`[SelfHeal] ⚠️ Backup error: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════
// HTTP Login (Phase 1) — Raw axios, no browser
// ═══════════════════════════════════════════════════════

/** Parse Set-Cookie headers from axios response */
function extractCookiesFromResponse(resp) {
    const cookies = {};
    const setCookieHeaders = resp.headers['set-cookie'] || [];
    for (const sc of setCookieHeaders) {
        const [nameVal] = sc.split(';');
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx > 0) {
            cookies[nameVal.substring(0, eqIdx).trim()] = nameVal.substring(eqIdx + 1).trim();
        }
    }
    return cookies;
}

/** Convert cookie object → axios Cookie header string */
function cookieHeader(cookies) {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Convert cookie object → Playwright cookie array */
function toPlaywrightCookies(cookies) {
    return Object.entries(cookies).map(([name, value]) => ({
        name, value,
        domain: '.facebook.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
    }));
}

/** Extract HTML form hidden fields */
function extractFormFields(html) {
    const fields = {};
    const regex = /name="([^"]+)"\s+value="([^"]*)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        if (!['email', 'pass', 'login'].includes(match[1])) {
            fields[match[1]] = match[2];
        }
    }
    return fields;
}

/**
 * HTTP-based login on m.facebook.com
 * Returns collected cookies or null on failure
 */
async function httpLogin(accEmail, accPassword, code, tag) {
    let allCookies = {};

    const axiosConfig = {
        headers: {
            'User-Agent': UA_MOBILE,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        maxRedirects: 5,
        timeout: 30000,
        // Important: handle cookies manually
        withCredentials: false,
        validateStatus: () => true, // Don't throw on any status
    };

    try {
        // ─── Step 1: GET login page ───
        console.log(`${tag} 🌐 HTTP: GET m.facebook.com/login/...`);
        const loginResp = await axios.get('https://m.facebook.com/login/', axiosConfig);
        Object.assign(allCookies, extractCookiesFromResponse(loginResp));
        console.log(`${tag} 🔧 Login page: ${loginResp.status}, cookies: ${Object.keys(allCookies).length}`);

        // Parse form fields
        const formFields = extractFormFields(loginResp.data);
        console.log(`${tag} 🔧 Form fields: ${Object.keys(formFields).join(', ')}`);

        // ─── Step 2: POST credentials ───
        const postData = new URLSearchParams({
            ...formFields,
            email: accEmail,
            pass: accPassword,
            login: 'Log In',
        });

        console.log(`${tag} 🔑 HTTP: POST login credentials...`);
        const postResp = await axios.post(
            'https://m.facebook.com/login/device-based/regular/login/',
            postData.toString(),
            {
                ...axiosConfig,
                headers: {
                    ...axiosConfig.headers,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://m.facebook.com/login/',
                    'Cookie': cookieHeader(allCookies),
                },
                maxRedirects: 0, // Don't follow — we need cookies from each redirect
                validateStatus: () => true,
            }
        );
        Object.assign(allCookies, extractCookiesFromResponse(postResp));
        console.log(`${tag} 🔧 POST result: ${postResp.status}, cookies: ${Object.keys(allCookies).length}`);

        // Follow redirects manually to collect all cookies
        let location = postResp.headers['location'];
        let currentUrl = location || '';
        for (let redir = 0; redir < 8 && location; redir++) {
            // Make absolute if relative
            if (location.startsWith('/')) location = `https://m.facebook.com${location}`;

            const redirResp = await axios.get(location, {
                ...axiosConfig,
                headers: {
                    ...axiosConfig.headers,
                    Cookie: cookieHeader(allCookies),
                    Referer: 'https://m.facebook.com/',
                },
                maxRedirects: 0,
                validateStatus: () => true,
            });
            Object.assign(allCookies, extractCookiesFromResponse(redirResp));
            location = redirResp.headers['location'];
            currentUrl = redirResp.request?.res?.responseUrl || location || currentUrl;

            if (redirResp.status >= 200 && redirResp.status < 300) {
                // Got a final page
                currentUrl = location || currentUrl;
                console.log(`${tag} 🔧 Redirect ${redir + 1}: final page ${redirResp.status}`);

                // Check if this is a 2FA page
                if (redirResp.data?.includes('approvals_code') || redirResp.data?.includes('checkpoint')) {
                    return await handle2FAHTTP(tag, allCookies, redirResp.data, code);
                }
                break;
            }

            console.log(`${tag} 🔧 Redirect ${redir + 1}: ${redirResp.status} → ${(location || '').substring(0, 60)}`);
        }

        // Check if we need 2FA
        if (currentUrl.includes('checkpoint') || currentUrl.includes('two_step') || currentUrl.includes('approvals')) {
            console.log(`${tag} 🔐 2FA checkpoint detected via HTTP`);
            // Fetch the checkpoint page
            const cpResp = await axios.get(currentUrl.startsWith('/') ? `https://m.facebook.com${currentUrl}` : currentUrl, {
                ...axiosConfig,
                headers: { ...axiosConfig.headers, Cookie: cookieHeader(allCookies) },
            });
            Object.assign(allCookies, extractCookiesFromResponse(cpResp));
            return await handle2FAHTTP(tag, allCookies, cpResp.data, code);
        }

        console.log(`${tag} 📥 HTTP login cookies: ${Object.keys(allCookies).length} (c_user: ${allCookies.c_user ? 'YES' : 'NO'})`);
        return allCookies;

    } catch (err) {
        console.warn(`${tag} ❌ HTTP login error: ${err.message}`);
        return null;
    }
}

/** Handle 2FA via HTTP after login */
async function handle2FAHTTP(tag, allCookies, pageHtml, code) {
    if (!code) {
        console.warn(`${tag} ❌ 2FA required but no code available`);
        return null;
    }

    console.log(`${tag} 🔐 HTTP 2FA: submitting code ${code}...`);

    const formFields = extractFormFields(pageHtml);
    // Find form action
    const actionMatch = pageHtml.match(/action="([^"]+)"/);
    let formAction = actionMatch?.[1] || '/checkpoint/';
    if (formAction.startsWith('/')) formAction = `https://m.facebook.com${formAction}`;
    // Decode HTML entities
    formAction = formAction.replace(/&amp;/g, '&');

    const postData = new URLSearchParams({
        ...formFields,
        approvals_code: code.replace(/\s/g, ''),
    });

    try {
        const resp = await axios.post(formAction, postData.toString(), {
            headers: {
                'User-Agent': UA_MOBILE,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieHeader(allCookies),
                'Referer': 'https://m.facebook.com/',
            },
            maxRedirects: 5,
            timeout: 30000,
            validateStatus: () => true,
        });
        Object.assign(allCookies, extractCookiesFromResponse(resp));
        console.log(`${tag} 🔧 2FA result: ${resp.status}, cookies: ${Object.keys(allCookies).length}`);

        // Handle checkpoint continuation steps (save device, etc.)
        let html = resp.data || '';
        for (let step = 0; step < 5; step++) {
            if (!html.includes('checkpoint') && !resp.headers?.location?.includes('checkpoint')) break;

            const stepFields = extractFormFields(html);
            const stepAction = html.match(/action="([^"]+)"/)?.[1];
            if (!stepAction) break;

            const stepUrl = stepAction.startsWith('/') ? `https://m.facebook.com${stepAction}` : stepAction;
            const stepData = new URLSearchParams({ ...stepFields, submit: 'Continue' });

            const stepResp = await axios.post(stepUrl.replace(/&amp;/g, '&'), stepData.toString(), {
                headers: {
                    'User-Agent': UA_MOBILE,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': cookieHeader(allCookies),
                },
                maxRedirects: 5,
                timeout: 15000,
                validateStatus: () => true,
            });
            Object.assign(allCookies, extractCookiesFromResponse(stepResp));
            html = stepResp.data || '';
            console.log(`${tag} ✅ Checkpoint step ${step + 1}: ${stepResp.status}`);
        }

        console.log(`${tag} 📥 Post-2FA cookies: ${Object.keys(allCookies).length} (c_user: ${allCookies.c_user ? 'YES' : 'NO'})`);
        return allCookies;
    } catch (err) {
        console.warn(`${tag} ❌ 2FA HTTP error: ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Newsfeed Warming + VIP Interaction
// ═══════════════════════════════════════════════════════

async function interactWithNewsfeed(page, tag) {
    console.log(`${tag} 🎭 Warming: scroll + random Like...`);
    for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, Math.floor(Math.random() * 800) + 400);
        await delay(2000 + Math.random() * 3000);

        if (Math.random() < 0.3) {
            try {
                const likeBtn = await page.$('div[role="button"][aria-label="Like"], div[role="button"][aria-label="Thích"]');
                if (likeBtn) {
                    const isPressed = await likeBtn.getAttribute('aria-pressed');
                    if (isPressed !== 'true') {
                        await likeBtn.scrollIntoViewIfNeeded();
                        await delay(1000);
                        await likeBtn.click();
                        console.log(`${tag} 👍 Random Like!`);
                        await delay(3000 + Math.random() * 3000);
                    }
                }
            } catch { }
        }
    }
}

// ═══════════════════════════════════════════════════════
// MAIN: Self-Heal Login
// ═══════════════════════════════════════════════════════

/**
 * Self-Healing Login: HTTP Login + Playwright Golden Session
 * @returns {string|null} path to storageState file, or null
 */
async function selfHealLogin(browser, account, tag) {
    const accEmail = account.email;
    const accPassword = account.password;
    const accUsername = accEmail.split('@')[0];

    if (!accPassword) {
        console.warn(`${tag} ⚠️ No password — cannot self-heal`);
        return null;
    }

    // 🧹 Clear old broken sessions first
    clearInvalidSession(accUsername);

    // Generate 2FA code
    let code = null;
    const totpSecret = getTotpSecret(accEmail);
    console.log(`${tag} 🔧 TOTP: ${totpSecret ? 'YES' : 'NO'}`);
    if (totpSecret) {
        try {
            code = authenticator.generate(totpSecret);
            console.log(`${tag} 🔑 TOTP code: ${code}`);
        } catch (e) { console.warn(`${tag} ⚠️ TOTP error: ${e.message}`); }
    }
    if (!code) {
        code = getRecoveryCode(accUsername);
        if (code) console.log(`${tag} 🎫 Recovery code: ${code}`);
    }

    try {
        // ═══ PHASE 1: HTTP LOGIN (no browser, invisible to Arkose) ═══
        console.log(`${tag} 🌐 Phase 1: HTTP login on m.facebook.com...`);
        const httpCookies = await httpLogin(accEmail, accPassword, code, tag);

        if (!httpCookies) {
            console.warn(`${tag} ❌ HTTP login failed`);
            return null;
        }

        const cookieNames = Object.keys(httpCookies);
        console.log(`${tag} 📥 HTTP cookies: ${cookieNames.length} (${cookieNames.slice(0, 8).join(', ')})`);

        // ═══ PHASE 2: GOLDEN SESSION (Playwright, JS enabled) ═══
        const goldenUA = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
        console.log(`${tag} 💎 Phase 2: Golden Session (UA: ${goldenUA.substring(0, 40)}...)...`);

        const goldenCtx = await browser.newContext({
            userAgent: goldenUA,
            viewport: { width: 1280, height: 720 },
        });

        // Inject HTTP cookies into Playwright
        const pwCookies = toPlaywrightCookies(httpCookies);
        await goldenCtx.addCookies(pwCookies);
        const goldenPage = await goldenCtx.newPage();

        try {
            // Identity Forcing
            console.log(`${tag} 🆔 Identity forcing: /me...`);
            await goldenPage.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await delay(5000);

            let meUrl = goldenPage.url();
            console.log(`${tag} 🔧 /me → ${meUrl.substring(0, 100)}`);

            // Handle checkpoint
            if (meUrl.includes('checkpoint') || meUrl.includes('login')) {
                console.log(`${tag} 🛡️ Checkpoint, pressing Enter...`);
                for (let i = 0; i < 3; i++) {
                    await goldenPage.keyboard.press('Enter');
                    await delay(3000);
                }
                meUrl = goldenPage.url();
            }

            // Newsfeed warm-up
            if (!meUrl.includes('/login')) {
                console.log(`${tag} 🎢 Warming up...`);
                await goldenPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
                await delay(5000);
                await interactWithNewsfeed(goldenPage, tag);
                await goldenPage.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
                await delay(5000);
            }

            // ─── Check + Save ───
            const cookies = await goldenCtx.cookies();
            const fbCookies = cookies.filter(c => c.domain?.includes('facebook'));
            const hasCUser = cookies.some(c => c.name === 'c_user');
            const hasXs = cookies.some(c => c.name === 'xs');
            console.log(`${tag} 🍪 Total: ${cookies.length}, FB: ${fbCookies.length}, c_user: ${hasCUser ? '✅' : '❌'}, xs: ${hasXs ? '✅' : '❌'}`);

            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
            await goldenCtx.storageState({ path: ssPath });

            const cookieJsonPath = path.join(DATA_DIR, `fb_cookies_${accUsername}.json`);
            fs.writeFileSync(cookieJsonPath, JSON.stringify(fbCookies, null, 2));

            if (hasCUser && hasXs) {
                console.log(`${tag} ✨ GOLDEN SESSION! (${fbCookies.length} cookies) → ${accUsername}`);
                backupGoldenSession(accUsername); // 💾 Backup to vault
            } else {
                console.log(`${tag} ⚠️ Session saved but ${hasCUser ? 'missing xs' : 'WEAK (no c_user)'} → ${accUsername}`);
            }

            await goldenCtx.close();
            return ssPath;
        } catch (warmErr) {
            console.warn(`${tag} ⚠️ Phase 2 error: ${warmErr.message}. Saving HTTP cookies...`);
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
            await goldenCtx.storageState({ path: ssPath });
            await goldenCtx.close();
            return ssPath;
        }

    } catch (err) {
        console.warn(`${tag} ❌ Self-heal error: ${err.message}`);
        return null;
    }
}

module.exports = {
    selfHealLogin,
    isSessionHealthy,
    getTotpSecret,
    getRecoveryCode,
    clearInvalidSession,
    backupGoldenSession,
    interactWithNewsfeed,
};
