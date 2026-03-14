/**
 * THG Lead Gen — Facebook Self-Healing Login Module
 * 
 * Strategy: Bootstrap datr → API Login → Golden Session
 * 
 * WHY "Bootstrap datr" is required:
 *   - Facebook's CDN (Akamai) returns 400 if request has no `datr` cookie
 *   - `datr` is a device-tracking cookie set on first visit to facebook.com
 *   - Without it, ALL login endpoints (m.facebook.com, mbasic) reject requests
 *   - Solution: GET www.facebook.com FIRST → datr saved in cookie jar → then login
 * 
 * WHY UA rotation with sec-ch-ua matching:
 *   - Facebook checks if User-Agent matches sec-ch-ua-platform
 *   - Mismatch = instant 400 or fingerprint flag
 *   - Each strategy has matching UA + sec-ch-ua headers
 * 
 * Flow:
 *   1. Create context with mobile UA + matching sec-ch-ua headers
 *   2. Bootstrap: GET www.facebook.com → datr cookie saved
 *   3. GET mbasic.facebook.com/login → parse form (lsd, jazoest)
 *   4. POST credentials → handle 2FA if needed
 *   5. Open page in SAME context → /me identity forcing → warm-up
 *   6. If fail → rotate to next UA strategy and retry
 * 
 * @module agents/fbSelfHeal
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════════════════
// Built-in TOTP generator
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
// UA Strategies — UA + matching sec-ch-ua headers
// ═══════════════════════════════════════════════════════

const UA_STRATEGIES = [
    {
        name: 'Pixel 9 Pro (Android 15)',
        ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
        headers: {
            'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"',
        },
        viewport: { width: 412, height: 915 },
    },
    {
        name: 'iPhone 15 Pro (Safari)',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        headers: {
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"iOS"',
        },
        viewport: { width: 393, height: 852 },
    },
    {
        name: 'Galaxy S24 Ultra (Android 14)',
        ua: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
        headers: {
            'sec-ch-ua': '"Not(A:Brand";v="99", "Samsung Internet";v="24", "Chromium";v="122"',
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"',
        },
        viewport: { width: 384, height: 854 },
    },
];

const UA_DESKTOP_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
        try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log(`[SelfHeal]   🗑️ Deleted: ${path.basename(fp)}`); } }
        catch (e) { console.warn(`[SelfHeal]   ⚠️ ${path.basename(fp)}: ${e.message}`); }
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
// Zombie Cleanup (Docker-safe)
// ═══════════════════════════════════════════════════════

function killZombieBrowsers() {
    if (process.platform !== 'linux') return;
    try {
        console.log('[System] 🧛 Zombie Hunter: cleaning up...');
        // Docker-safe: use ps + grep + xargs instead of pkill
        execSync("ps aux | grep -v grep | grep -E 'chrom' | awk '{print $2}' | xargs -r kill -9 2>/dev/null", { timeout: 5000, stdio: 'ignore' });
        execSync('rm -rf /tmp/playwright_chromiumdev_profile-* 2>/dev/null', { timeout: 5000, stdio: 'ignore' });
        console.log('[System] ✅ Cleanup done');
    } catch {
        // No zombie = no problem
    }
}

// ═══════════════════════════════════════════════════════
// HTML Parsing helpers
// ═══════════════════════════════════════════════════════

function extractFormFields(html) {
    const fields = {};
    // Match: name="xxx" value="yyy" (in any order within <input>)
    const inputRegex = /<input[^>]*>/gi;
    let inputMatch;
    while ((inputMatch = inputRegex.exec(html)) !== null) {
        const tag = inputMatch[0];
        const nameMatch = tag.match(/name="([^"]+)"/);
        const valueMatch = tag.match(/value="([^"]*)"/);
        if (nameMatch && valueMatch) {
            const name = nameMatch[1];
            if (!['email', 'pass', 'login'].includes(name)) {
                fields[name] = valueMatch[1];
            }
        }
    }
    return fields;
}

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
// Try one login attempt with a specific UA strategy
// ═══════════════════════════════════════════════════════

async function tryLoginWithStrategy(browser, strategy, accEmail, accPassword, code, tag) {
    let ctx = null;
    try {
        // Create context with matching UA + sec-ch-ua headers
        ctx = await browser.newContext({
            userAgent: strategy.ua,
            extraHTTPHeaders: strategy.headers,
            viewport: strategy.viewport,
            isMobile: true,
            locale: 'en-US',
        });

        const api = ctx.request;

        // ─── STEP 1: Bootstrap — GET www.facebook.com to acquire `datr` cookie ───
        console.log(`${tag} 🎣 Bootstrap: getting datr from www.facebook.com...`);
        const bootstrapResp = await api.get('https://www.facebook.com/', {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            },
        });
        const bootstrapCookies = await ctx.cookies();
        const hasDatr = bootstrapCookies.some(c => c.name === 'datr');
        console.log(`${tag} 🔧 Bootstrap: ${bootstrapResp.status()}, datr: ${hasDatr ? 'YES ✅' : 'NO ❌'}, cookies: ${bootstrapCookies.length}`);

        // ─── STEP 2: GET mbasic login form ───
        console.log(`${tag} 🚪 GET mbasic login form...`);
        const loginResp = await api.get('https://mbasic.facebook.com/login/?refsrc=deprecated&lwv=100&_fb_noscript=1', {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin', // Coming from facebook.com
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'Referer': 'https://www.facebook.com/',
            },
        });
        const loginStatus = loginResp.status();
        const loginHtml = await loginResp.text();
        const loginUrl = loginResp.url();
        console.log(`${tag} 🔧 Login page: ${loginStatus}, length: ${loginHtml.length}, URL: ${loginUrl.substring(0, 80)}`);

        if (loginStatus === 400 || loginStatus === 403) {
            console.warn(`${tag} ⚠️ ${strategy.name} got ${loginStatus} — trying next UA...`);
            await ctx.close();
            return null; // Signal to try next strategy
        }

        // Check for form
        const hasForm = loginHtml.includes('name="email"') && loginHtml.includes('name="pass"');
        if (!hasForm) {
            // Maybe we landed on www — try to find a form anyway
            const preview = loginHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 200);
            console.log(`${tag} 🔧 Page preview: ${preview}`);

            // Try m.facebook.com as fallback
            console.log(`${tag} 🔧 Trying m.facebook.com/login/...`);
            const mResp = await api.get('https://m.facebook.com/login/', {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Referer': 'https://www.facebook.com/',
                },
            });
            const mHtml = await mResp.text();
            const mHasForm = mHtml.includes('name="email"') && mHtml.includes('name="pass"');
            console.log(`${tag} 🔧 m.facebook.com: ${mResp.status()}, form: ${mHasForm ? 'YES' : 'NO'}, length: ${mHtml.length}`);

            if (!mHasForm) {
                console.warn(`${tag} ❌ No login form on any endpoint with ${strategy.name}`);
                await ctx.close();
                return null;
            }
            // Use m.facebook.com HTML
            return await doLoginAndGoldenSession(ctx, browser, api, mHtml, 'https://m.facebook.com', accEmail, accPassword, code, tag);
        }

        return await doLoginAndGoldenSession(ctx, browser, api, loginHtml, 'https://mbasic.facebook.com', accEmail, accPassword, code, tag);

    } catch (err) {
        console.warn(`${tag} ❌ ${strategy.name} error: ${err.message}`);
        if (ctx) try { await ctx.close(); } catch { }
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Login POST + 2FA + Golden Session
// ═══════════════════════════════════════════════════════

async function doLoginAndGoldenSession(ctx, browser, api, loginHtml, baseUrl, accEmail, accPassword, code, tag) {
    const accUsername = accEmail.split('@')[0];

    // Parse form
    const fields = extractFormFields(loginHtml);
    let formAction = extractFormAction(loginHtml);
    console.log(`${tag} 🔧 Form fields: ${Object.keys(fields).join(', ') || 'none'}`);
    console.log(`${tag} 🔧 Form action: ${formAction || 'default'}`);

    if (!formAction) formAction = `${baseUrl}/login/device-based/regular/login/`;
    if (formAction.startsWith('/')) formAction = `${baseUrl}${formAction}`;

    // ─── POST credentials ───
    console.log(`${tag} 🔑 POST credentials → ${formAction.substring(0, 60)}...`);
    const postResp = await api.post(formAction, {
        form: {
            ...fields,
            email: accEmail,
            pass: accPassword,
            login: 'Log In',
        },
        headers: {
            'Referer': `${baseUrl}/login/`,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
        },
    });
    const postHtml = await postResp.text();
    const postUrl = postResp.url();
    console.log(`${tag} 🔧 POST: ${postResp.status()}, URL: ${postUrl.substring(0, 100)}`);

    // ─── 2FA Handling ───
    if (postUrl.includes('checkpoint') || postUrl.includes('two_step') ||
        postUrl.includes('approvals') || postHtml.includes('approvals_code')) {
        console.log(`${tag} 🔐 2FA checkpoint detected`);

        if (!code) {
            console.warn(`${tag} ❌ No 2FA code!`);
            await ctx.close();
            return null;
        }

        let tfaHtml = postHtml;
        // Fetch checkpoint page if needed
        if (!tfaHtml.includes('approvals_code') && !tfaHtml.includes('name="approvals_code"')) {
            const tfaResp = await api.get(postUrl, {
                headers: { 'Referer': `${baseUrl}/login/` },
            });
            tfaHtml = await tfaResp.text();
        }

        const tfaFields = extractFormFields(tfaHtml);
        let tfaAction = extractFormAction(tfaHtml) || postUrl;
        if (tfaAction.startsWith('/')) tfaAction = `${baseUrl}${tfaAction}`;

        console.log(`${tag} ⚡ Submitting 2FA code ${code}...`);
        const tfaPostResp = await api.post(tfaAction, {
            form: {
                ...tfaFields,
                approvals_code: code.replace(/\s/g, ''),
            },
            headers: {
                'Referer': postUrl,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
            },
        });
        let stepHtml = await tfaPostResp.text();
        let stepUrl = tfaPostResp.url();
        console.log(`${tag} 🔧 2FA result: ${tfaPostResp.status()}, URL: ${stepUrl.substring(0, 80)}`);

        // Handle checkpoint steps (Save Device, Continue)
        for (let step = 0; step < 6; step++) {
            if (!stepUrl.includes('checkpoint') && !stepUrl.includes('two_step') && !stepUrl.includes('approvals')) break;

            const stepFields = extractFormFields(stepHtml);
            let stepAction = extractFormAction(stepHtml);
            if (!stepAction) break;
            if (stepAction.startsWith('/')) stepAction = `${baseUrl}${stepAction}`;

            const submitData = { ...stepFields };
            if (!submitData.submit) submitData.submit = 'Continue';
            // Check "save device" option
            if (stepHtml.includes('name="name_action_selected"')) {
                submitData.name_action_selected = 'save_device';
            }

            const sr = await api.post(stepAction, {
                form: submitData,
                headers: { 'Referer': stepUrl },
            });
            stepHtml = await sr.text();
            stepUrl = sr.url();
            console.log(`${tag} ✅ Checkpoint step ${step + 1}: ${sr.status()}, URL: ${stepUrl.substring(0, 80)}`);
        }
    }

    // ─── PHASE 2: Golden Session ───
    // Transfer cookies to a desktop context for scraping
    const allCookies = await ctx.cookies();
    await ctx.close();
    console.log(`${tag} 📥 API cookies: ${allCookies.length} (c_user: ${allCookies.some(c => c.name === 'c_user') ? 'YES' : 'NO'})`);

    const goldenUA = UA_DESKTOP_POOL[Math.floor(Math.random() * UA_DESKTOP_POOL.length)];
    console.log(`${tag} 💎 Phase 2: Golden Session...`);

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

        if (meUrl.includes('checkpoint') || meUrl.includes('login')) {
            for (let i = 0; i < 3; i++) {
                await goldenPage.keyboard.press('Enter');
                await delay(3000);
            }
            meUrl = goldenPage.url();
        }

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
}

// ═══════════════════════════════════════════════════════
// MAIN: Self-Heal Login with UA Rotation
// ═══════════════════════════════════════════════════════

async function selfHealLogin(browser, account, tag) {
    const accEmail = account.email;
    const accPassword = account.password;
    const accUsername = accEmail.split('@')[0];

    if (!accPassword) {
        console.warn(`${tag} ⚠️ No password — cannot self-heal`);
        return null;
    }

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

    // ═══ Try each UA strategy until one works ═══
    for (let i = 0; i < UA_STRATEGIES.length; i++) {
        const strategy = UA_STRATEGIES[i];
        console.log(`${tag} 🎭 [${i + 1}/${UA_STRATEGIES.length}] Trying: ${strategy.name}...`);

        const result = await tryLoginWithStrategy(browser, strategy, accEmail, accPassword, code, tag);
        if (result) {
            console.log(`${tag} 🏆 Success with ${strategy.name}!`);
            return result;
        }

        // Re-generate TOTP code if it might have expired between attempts
        if (totpSecret && i < UA_STRATEGIES.length - 1) {
            try {
                code = authenticator.generate(totpSecret);
                console.log(`${tag} 🔄 Refreshed TOTP: ${code}`);
            } catch { }
        }

        await delay(3000); // Brief pause between strategies
    }

    console.warn(`${tag} 🚨 All ${UA_STRATEGIES.length} UA strategies failed`);
    return null;
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
