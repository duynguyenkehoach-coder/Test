/**
 * THG Lead Gen — Facebook Self-Healing Login Module
 * 
 * Strategy: Playwright API Login → Golden Session
 * 
 * WHY Playwright context.request (not axios, not page):
 *   - axios got 400: missing Sec-Fetch-* headers, FB rejects raw HTTP
 *   - page on mbasic: 302 redirect loop (server-side, can't intercept)
 *   - page on www: Arkose Labs CAPTCHA blocks 2FA form
 *   - context.request: sends proper browser headers + shares cookies with pages
 * 
 * Phase 1: Login via context.request API (no page rendering!)
 *   - Playwright sends real browser headers automatically
 *   - Cookie jar shared between API requests and browser pages
 *   - Parse HTML form, POST credentials, handle 2FA
 * 
 * Phase 2: Golden Session (reuse same context — cookies already there!)
 *   - Open page → /me identity forcing → newsfeed warming
 *   - Backup golden session to vault
 * 
 * @module agents/fbSelfHeal
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

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
// Constants
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
// Session Health Check + Cleanup + Backup
// ═══════════════════════════════════════════════════════

function isSessionHealthy(accUsername) {
    const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
    const backupPath = path.join(BACKUP_DIR, `${accUsername}_auth.json`);

    // Auto-restore from backup
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
        } catch (e) { console.warn(`[SelfHeal]   ⚠️ ${path.basename(fp)}: ${e.message}`); }
    }
}

function backupGoldenSession(accUsername) {
    const source = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
    const target = path.join(BACKUP_DIR, `${accUsername}_auth.json`);
    try {
        if (fs.existsSync(source)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
            fs.copyFileSync(source, target);
            console.log(`[SelfHeal] 💾 Backed up → backups/${accUsername}_auth.json`);
        }
    } catch (e) { console.warn(`[SelfHeal] ⚠️ Backup error: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════
// Zombie Process Cleanup
// ═══════════════════════════════════════════════════════

function killZombieBrowsers() {
    if (process.platform !== 'linux') return;
    try {
        console.log('[System] 🧛 Zombie Hunter: cleaning up stale browser processes...');
        execSync('pkill -9 -f "chromium.*--headless" 2>/dev/null || true', { timeout: 5000 });
        execSync('rm -rf /tmp/playwright_chromiumdev_profile-* 2>/dev/null || true', { timeout: 5000 });
        console.log('[System] ✅ Cleanup done');
    } catch (e) {
        console.warn(`[System] ⚠️ Cleanup error: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════
// HTML Parsing helpers
// ═══════════════════════════════════════════════════════

/** Extract hidden form fields from HTML */
function extractFormFields(html) {
    const fields = {};
    // Match hidden inputs: <input type="hidden" name="xxx" value="yyy">
    const regex = /<input[^>]*?name="([^"]+)"[^>]*?value="([^"]*)"[^>]*?>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const name = match[1];
        if (!['email', 'pass', 'login'].includes(name)) {
            fields[name] = match[2];
        }
    }
    // Also match reversed order: value before name
    const regex2 = /<input[^>]*?value="([^"]*)"[^>]*?name="([^"]+)"[^>]*?>/gi;
    while ((match = regex2.exec(html)) !== null) {
        const name = match[2];
        if (!['email', 'pass', 'login'].includes(name) && !fields[name]) {
            fields[name] = match[1];
        }
    }
    return fields;
}

/** Extract form action URL from HTML */
function extractFormAction(html) {
    const match = html.match(/<form[^>]*?action="([^"]+)"/i);
    if (!match) return null;
    return match[1].replace(/&amp;/g, '&');
}

// ═══════════════════════════════════════════════════════
// Newsfeed Warming
// ═══════════════════════════════════════════════════════

async function interactWithNewsfeed(page, tag) {
    console.log(`${tag} 🎭 Warming: scroll + random Like...`);
    for (let i = 0; i < 3; i++) {
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
                        await delay(2000 + Math.random() * 3000);
                    }
                }
            } catch { }
        }
    }
}

// ═══════════════════════════════════════════════════════
// MAIN: Self-Heal Login (context.request API + Golden Session)
// ═══════════════════════════════════════════════════════

async function selfHealLogin(browser, account, tag) {
    const accEmail = account.email;
    const accPassword = account.password;
    const accUsername = accEmail.split('@')[0];

    if (!accPassword) {
        console.warn(`${tag} ⚠️ No password — cannot self-heal`);
        return null;
    }

    // 🧹 Clear old broken sessions
    clearInvalidSession(accUsername);

    // Generate 2FA code upfront
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

    // ═══ Create context — cookies shared between API and pages ═══
    const goldenUA = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    let ctx = null;

    try {
        ctx = await browser.newContext({
            userAgent: UA_MOBILE,
            viewport: { width: 390, height: 844 },
            locale: 'en-US',
        });

        const api = ctx.request; // Playwright API — shares cookies with pages!

        // ═══ PHASE 1: HTTP LOGIN via context.request ═══
        // Sends proper Sec-Fetch-* headers automatically, follows redirects,
        // stores cookies in context cookie jar
        console.log(`${tag} 🌐 Phase 1: API login on m.facebook.com...`);

        // Step 1: GET login page
        const loginResp = await api.get('https://m.facebook.com/login/', {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        const loginHtml = await loginResp.text();
        const loginStatus = loginResp.status();
        console.log(`${tag} 🔧 GET login: ${loginStatus}, length: ${loginHtml.length}`);

        // Check if we got a login form
        const hasForm = loginHtml.includes('name="email"') || loginHtml.includes('name="pass"');
        console.log(`${tag} 🔧 Has login form: ${hasForm ? 'YES' : 'NO'}`);

        if (!hasForm) {
            // Try noscript fallback
            console.log(`${tag} 🔧 Trying noscript fallback...`);
            const noscriptResp = await api.get('https://www.facebook.com/login/?_fb_noscript=1');
            const noscriptHtml = await noscriptResp.text();
            const noscriptHasForm = noscriptHtml.includes('name="email"') || noscriptHtml.includes('name="pass"');
            console.log(`${tag} 🔧 Noscript: ${noscriptResp.status()}, form: ${noscriptHasForm ? 'YES' : 'NO'}, length: ${noscriptHtml.length}`);

            if (!noscriptHasForm) {
                console.warn(`${tag} ❌ No login form found on any endpoint`);
                console.log(`${tag} 🔧 Page preview: ${loginHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 200)}`);
                await ctx.close();
                return null;
            }
        }

        // Parse form fields
        const formFields = extractFormFields(loginHtml);
        const formAction = extractFormAction(loginHtml);
        console.log(`${tag} 🔧 Form fields: ${Object.keys(formFields).join(', ') || 'none'}`);
        console.log(`${tag} 🔧 Form action: ${formAction || 'not found'}`);

        // Step 2: POST credentials
        let postUrl = formAction || '/login/device-based/regular/login/';
        if (postUrl.startsWith('/')) postUrl = `https://m.facebook.com${postUrl}`;

        const formData = {
            ...formFields,
            email: accEmail,
            pass: accPassword,
            login: 'Log In',
        };

        console.log(`${tag} 🔑 POST credentials → ${postUrl.substring(0, 60)}...`);
        const postResp = await api.post(postUrl, {
            form: formData,
            headers: {
                'Referer': 'https://m.facebook.com/login/',
            },
        });
        const postHtml = await postResp.text();
        const postUrl2 = postResp.url();
        console.log(`${tag} 🔧 POST result: ${postResp.status()}, URL: ${postUrl2.substring(0, 100)}`);

        // Step 3: Handle 2FA checkpoint
        if (postUrl2.includes('checkpoint') || postUrl2.includes('two_step') ||
            postUrl2.includes('approvals') || postHtml.includes('approvals_code')) {
            console.log(`${tag} 🔐 2FA checkpoint detected`);

            if (!code) {
                console.warn(`${tag} ❌ No 2FA code available!`);
                await ctx.close();
                return null;
            }

            // Parse 2FA form
            let tfaHtml = postHtml;
            // If redirected to a new URL, fetch it
            if (!tfaHtml.includes('approvals_code') && !tfaHtml.includes('name="approvals_code"')) {
                console.log(`${tag} 🔧 Fetching 2FA page...`);
                const tfaResp = await api.get(postUrl2);
                tfaHtml = await tfaResp.text();
            }

            const tfaFields = extractFormFields(tfaHtml);
            let tfaAction = extractFormAction(tfaHtml);
            if (!tfaAction) tfaAction = postUrl2; // Use current URL
            if (tfaAction.startsWith('/')) tfaAction = `https://m.facebook.com${tfaAction}`;

            console.log(`${tag} 🔧 2FA form action: ${tfaAction.substring(0, 60)}`);
            console.log(`${tag} ⚡ Submitting 2FA code ${code}...`);

            const tfaResp2 = await api.post(tfaAction, {
                form: {
                    ...tfaFields,
                    approvals_code: code.replace(/\s/g, ''),
                },
                headers: { 'Referer': postUrl2 },
            });
            let tfaHtml2 = await tfaResp2.text();
            let tfaUrl = tfaResp2.url();
            console.log(`${tag} 🔧 2FA result: ${tfaResp2.status()}, URL: ${tfaUrl.substring(0, 80)}`);

            // Handle checkpoint continuation steps (Save Device, Continue, etc.)
            for (let step = 0; step < 6; step++) {
                if (!tfaUrl.includes('checkpoint') && !tfaUrl.includes('two_step') && !tfaUrl.includes('approvals')) break;

                const stepFields = extractFormFields(tfaHtml2);
                let stepAction = extractFormAction(tfaHtml2);
                if (!stepAction) break;
                if (stepAction.startsWith('/')) stepAction = `https://m.facebook.com${stepAction}`;

                // Add submit/continue field
                const submitData = { ...stepFields };
                if (!submitData.submit) submitData.submit = 'Continue';

                console.log(`${tag} ✅ Checkpoint step ${step + 1} → POST ${stepAction.substring(0, 50)}...`);
                const stepResp = await api.post(stepAction, {
                    form: submitData,
                    headers: { 'Referer': tfaUrl },
                });
                tfaHtml2 = await stepResp.text();
                tfaUrl = stepResp.url();
                console.log(`${tag} 🔧 Step ${step + 1}: ${stepResp.status()}, URL: ${tfaUrl.substring(0, 80)}`);
            }
        }

        // ═══ PHASE 2: GOLDEN SESSION (same context, cookies already loaded!) ═══
        // The beauty: context.request shared cookies with context.newPage()!
        console.log(`${tag} 💎 Phase 2: Golden Session (cookies already in context)...`);

        // Switch to desktop UA for the page
        // Note: we can't change UA mid-context, so we transfer cookies to a new context
        const allCookies = await ctx.cookies();
        await ctx.close();
        ctx = null;

        const goldenCtx = await browser.newContext({
            userAgent: goldenUA,
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
        });
        await goldenCtx.addCookies(allCookies);
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

            // Check + Save
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
                backupGoldenSession(accUsername);
            } else {
                console.log(`${tag} ⚠️ Session saved but ${hasCUser ? 'missing xs' : 'WEAK (no c_user)'} → ${accUsername}`);
            }

            await goldenCtx.close();
            return ssPath;
        } catch (warmErr) {
            console.warn(`${tag} ⚠️ Phase 2 error: ${warmErr.message}`);
            // Try to save what we have
            try {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
                await goldenCtx.storageState({ path: ssPath });
                await goldenCtx.close();
                return ssPath;
            } catch {
                try { await goldenCtx.close(); } catch { }
                return null;
            }
        }

    } catch (err) {
        console.warn(`${tag} ❌ Self-heal error: ${err.message}`);
        if (ctx) try { await ctx.close(); } catch { }
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
    killZombieBrowsers,
    interactWithNewsfeed,
};
