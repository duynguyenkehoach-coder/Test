/**
 * THG Lead Gen — Facebook Self-Healing Login Module
 * 
 * Strategy: Hybrid Page + API Login → Golden Session
 * 
 * WHY Hybrid (page + context.request):
 *   - Page with JS off: finds form fields via DOM (visible email/pass inputs)
 *   - Hidden fields (lsd, jazoest): extracted from DOM via getAttribute()
 *   - Submit button is CSS-hidden (display:none) → can't click it
 *   - context.request.post(): POSTs form data directly (no button needed!)
 *   - Cookie jar SHARED between page and API requests
 * 
 * Flow:
 *   1. page.goto facebook.com (JS off) → datr + DOM form fields
 *   2. Extract all hidden inputs: lsd, jazoest, li, m_ts, etc.
 *   3. context.request.post() → credentials + hidden fields
 *   4. Handle 2FA + Save Device prompts via API
 *   5. Transfer cookies → JS desktop context → /me + warm-up
 *   6. ONLY return success if c_user is present
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
// UA Strategies
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
            // c_user + xs = essentials → HEALTHY (even with fewer total cookies)
            return { healthy: hasCUser && hasXs, cookieCount: cookies.length, hasCUser, hasXs };
        } catch { }
    }
    const cookiePath = path.join(DATA_DIR, `fb_cookies_${accUsername}.json`);
    if (fs.existsSync(cookiePath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
            const hasCUser = cookies.some(c => c.name === 'c_user');
            const hasXs = cookies.some(c => c.name === 'xs');
            // c_user + xs = essentials → HEALTHY
            return { healthy: hasCUser && hasXs, cookieCount: cookies.length, hasCUser, hasXs };
        } catch { }
    }
    return { healthy: false, cookieCount: 0, hasCUser: false, hasXs: false };
}

function clearInvalidSession(accUsername) {
    // ═══ SAFETY: Always backup before deleting! ═══
    backupSession(accUsername);

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

/**
 * Backup ALL session files before self-healing deletes them.
 * If self-healing fails, restoreSession() can bring them back.
 */
function backupSession(accUsername) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const filesToBackup = [
        { src: path.join(SESSIONS_DIR, `${accUsername}_auth.json`), dst: path.join(BACKUP_DIR, `${accUsername}_auth.json`) },
        { src: path.join(DATA_DIR, `fb_cookies_${accUsername}.json`), dst: path.join(BACKUP_DIR, `fb_cookies_${accUsername}.json`) },
    ];
    let backed = 0;
    for (const { src, dst } of filesToBackup) {
        try {
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dst);
                backed++;
            }
        } catch (e) { console.warn(`[SelfHeal] ⚠️ Backup error for ${path.basename(src)}: ${e.message}`); }
    }
    if (backed > 0) console.log(`[SelfHeal] 💾 Backed up ${backed} session files before clearing`);
}

// Keep old name for backward compatibility
function backupGoldenSession(accUsername) { backupSession(accUsername); }

/**
 * Restore session files from backup (called when self-healing FAILS).
 * This ensures we never permanently lose working cookies.
 */
function restoreSession(accUsername) {
    const filesToRestore = [
        { src: path.join(BACKUP_DIR, `${accUsername}_auth.json`), dst: path.join(SESSIONS_DIR, `${accUsername}_auth.json`) },
        { src: path.join(BACKUP_DIR, `fb_cookies_${accUsername}.json`), dst: path.join(DATA_DIR, `fb_cookies_${accUsername}.json`) },
    ];
    let restored = 0;
    for (const { src, dst } of filesToRestore) {
        try {
            if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
                restored++;
            }
        } catch (e) { console.warn(`[SelfHeal] ⚠️ Restore error for ${path.basename(src)}: ${e.message}`); }
    }
    if (restored > 0) console.log(`[SelfHeal] ♻️ Restored ${restored} session files from backup (login failed, keeping old cookies)`);
    return restored > 0;
}

// ═══════════════════════════════════════════════════════
// Zombie Cleanup (Docker-safe)
// ═══════════════════════════════════════════════════════

function killZombieBrowsers() {
    if (process.platform !== 'linux') return;
    try {
        console.log('[System] 🧛 Zombie Hunter: cleaning up...');
        execSync("ps aux | grep -v grep | grep -E 'chrom' | awk '{print $2}' | xargs -r kill -9 2>/dev/null", { timeout: 5000, stdio: 'ignore' });
        execSync('rm -rf /tmp/playwright_chromiumdev_profile-* 2>/dev/null', { timeout: 5000, stdio: 'ignore' });
        console.log('[System] ✅ Cleanup done');
    } catch { }
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
                if (likeBtn && (await likeBtn.getAttribute('aria-pressed')) !== 'true') {
                    await likeBtn.scrollIntoViewIfNeeded();
                    await delay(1000);
                    await likeBtn.click();
                    console.log(`${tag} 👍 Random Like!`);
                    await delay(2000 + Math.random() * 3000);
                }
            } catch { }
        }
    }
}

// ═══════════════════════════════════════════════════════
// HTML parsing helpers (for API response HTML)
// ═══════════════════════════════════════════════════════

function extractFormFields(html) {
    const fields = {};
    const inputRegex = /<input[^>]*>/gi;
    let m;
    while ((m = inputRegex.exec(html)) !== null) {
        const tag = m[0];
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
// Try login with one UA strategy (Hybrid: Page + API)
// ═══════════════════════════════════════════════════════

async function tryLoginWithStrategy(browser, strategy, accEmail, accPassword, code, tag) {
    let ctx = null;
    try {
        ctx = await browser.newContext({
            userAgent: strategy.ua,
            extraHTTPHeaders: strategy.headers,
            viewport: strategy.viewport,
            isMobile: true,
            javaScriptEnabled: false, // No JS for page (datr + field extraction)
            locale: 'en-US',
        });

        const page = await ctx.newPage();
        const api = ctx.request; // Shares cookie jar with page!

        // ─── Step 1: Page load → datr cookie + DOM form field extraction ───
        console.log(`${tag} 🎣 Loading facebook.com (No-JS, datr + form fields)...`);
        await page.goto('https://www.facebook.com/', {
            waitUntil: 'load',
            timeout: 60000,
        });
        await delay(3000);

        const cookies0 = await ctx.cookies();
        const hasDatr = cookies0.some(c => c.name === 'datr');
        console.log(`${tag} 🔧 datr: ${hasDatr ? '✅' : '❌'}, cookies: ${cookies0.length}`);

        // ─── Step 2: Extract hidden form fields from DOM ───
        console.log(`${tag} 🔍 Extracting form fields from DOM...`);
        const hiddenFields = {};
        const hiddenInputs = await page.$$('input[type="hidden"]');
        for (const inp of hiddenInputs) {
            const name = await inp.getAttribute('name').catch(() => null);
            const value = await inp.getAttribute('value').catch(() => null);
            if (name && value !== null) {
                hiddenFields[name] = value;
            }
        }

        // Also find the form action
        const forms = await page.$$('form');
        let formAction = null;
        for (const form of forms) {
            const action = await form.getAttribute('action').catch(() => null);
            if (action && (action.includes('login') || action.includes('Login'))) {
                formAction = action;
                break;
            }
        }

        const fieldNames = Object.keys(hiddenFields);
        console.log(`${tag} 🔧 Hidden fields (${fieldNames.length}): ${fieldNames.join(', ')}`);
        console.log(`${tag} 🔧 Form action: ${formAction || 'not found'}`);
        console.log(`${tag} 🔧 lsd: ${hiddenFields.lsd ? 'YES' : 'NO'}, jazoest: ${hiddenFields.jazoest ? 'YES' : 'NO'}`);

        // Close the page — we got what we need (cookie jar persists)
        await page.close();

        // ─── Step 3: API POST login (cookie jar has datr from page!) ───
        let postUrl = formAction || '/login/device-based/regular/login/';
        if (postUrl.startsWith('/')) postUrl = `https://www.facebook.com${postUrl}`;

        const formData = {
            ...hiddenFields,
            email: accEmail,
            pass: accPassword,
            login: 'Log In',
        };

        console.log(`${tag} 🔑 API POST → ${postUrl.substring(0, 60)}...`);
        const postResp = await api.post(postUrl, {
            form: formData,
            headers: {
                'Referer': 'https://www.facebook.com/',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
            },
        });
        const postHtml = await postResp.text();
        const postResultUrl = postResp.url();
        const postStatus = postResp.status();
        console.log(`${tag} 🔧 POST: ${postStatus}, URL: ${postResultUrl.substring(0, 100)}`);

        // Check cookies immediately after POST
        const postCookies = await ctx.cookies();
        const postHasCUser = postCookies.some(c => c.name === 'c_user');
        console.log(`${tag} 🔧 Post-login cookies: ${postCookies.length}, c_user: ${postHasCUser ? '✅' : '❌'}`);

        // ─── Step 4: Handle 2FA checkpoint ───
        if (postResultUrl.includes('checkpoint') || postResultUrl.includes('two_step') ||
            postResultUrl.includes('approvals') || postHtml.includes('approvals_code')) {
            console.log(`${tag} 🔐 2FA checkpoint detected`);

            if (!code) {
                console.warn(`${tag} ❌ No 2FA code!`);
                await ctx.close();
                return null;
            }

            let tfaHtml = postHtml;
            // If we need to GET the checkpoint page
            if (!tfaHtml.includes('approvals_code') && !tfaHtml.includes('name="approvals_code"')) {
                const tfaPage = await api.get(postResultUrl);
                tfaHtml = await tfaPage.text();
            }

            const tfaFields = extractFormFields(tfaHtml);
            let tfaAction = extractFormAction(tfaHtml) || postResultUrl;
            if (tfaAction.startsWith('/')) tfaAction = `https://www.facebook.com${tfaAction}`;

            console.log(`${tag} ⚡ Submitting 2FA code: ${code}`);
            const tfaResp = await api.post(tfaAction, {
                form: {
                    ...tfaFields,
                    approvals_code: code.replace(/\s/g, ''),
                },
                headers: { 'Referer': postResultUrl },
            });
            let stepHtml = await tfaResp.text();
            let stepUrl = tfaResp.url();
            console.log(`${tag} 🔧 2FA result: ${tfaResp.status()}, URL: ${stepUrl.substring(0, 80)}`);

            // Handle checkpoint continuation (Save Device, Continue, etc.)
            for (let step = 0; step < 8; step++) {
                // Check for c_user
                const ck = await ctx.cookies();
                if (ck.some(c => c.name === 'c_user')) {
                    console.log(`${tag} 🎉 c_user obtained at step ${step}!`);
                    break;
                }

                if (!stepUrl.includes('checkpoint') && !stepUrl.includes('two_step') && !stepUrl.includes('approvals')) break;

                const stepFields = extractFormFields(stepHtml);
                let stepAction = extractFormAction(stepHtml);
                if (!stepAction) break;
                if (stepAction.startsWith('/')) stepAction = `https://www.facebook.com${stepAction}`;

                // Add submit/continue 
                const submitData = { ...stepFields };
                if (!submitData.submit) submitData.submit = 'Continue';
                // Select "save device" if option exists
                if (stepHtml.includes('name_action_selected')) {
                    submitData.name_action_selected = 'save_device';
                }

                console.log(`${tag} 👆 Checkpoint step ${step + 1} → ${stepAction.substring(0, 50)}...`);
                const sr = await api.post(stepAction, {
                    form: submitData,
                    headers: { 'Referer': stepUrl },
                });
                stepHtml = await sr.text();
                stepUrl = sr.url();
                console.log(`${tag} ✅ Step ${step + 1}: ${sr.status()}, URL: ${stepUrl.substring(0, 80)}`);
            }
        }

        // ─── Step 5: Check if login succeeded ───
        const allCookies = await ctx.cookies();
        const hasCUser = allCookies.some(c => c.name === 'c_user');
        const hasXs = allCookies.some(c => c.name === 'xs');
        console.log(`${tag} 📥 Phase 1 final: ${allCookies.length} cookies, c_user: ${hasCUser ? '✅' : '❌'}, xs: ${hasXs ? '✅' : '❌'}`);

        if (allCookies.length <= 2 && !hasCUser) {
            console.warn(`${tag} ❌ Login had no effect (${allCookies.length} cookies). Might need different approach.`);
            // Dump post HTML for debugging
            const stripped = postHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
            console.log(`${tag} 🔧 POST response: ${stripped.substring(0, 300)}`);
            await ctx.close();
            return null;
        }

        // ─── Step 6: Golden Session (transfer to JS-enabled desktop context) ───
        await ctx.close();
        ctx = null;

        const goldenUA = UA_DESKTOP_POOL[Math.floor(Math.random() * UA_DESKTOP_POOL.length)];
        console.log(`${tag} 💎 Phase 2: Golden Session (${allCookies.length} cookies)...`);

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

            // Handle checkpoint on /me
            if (meUrl.includes('checkpoint') || meUrl.includes('login')) {
                for (let i = 0; i < 3; i++) {
                    await goldenPage.keyboard.press('Enter');
                    await delay(3000);
                }
                meUrl = goldenPage.url();
            }

            // Warm-up
            if (!meUrl.includes('/login')) {
                console.log(`${tag} 🎢 Warming up...`);
                await goldenPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
                await delay(5000);
                await interactWithNewsfeed(goldenPage, tag);
                await goldenPage.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
                await delay(5000);
            }

            // Final check
            const finalCookies = await goldenCtx.cookies();
            const fbCookies = finalCookies.filter(c => c.domain?.includes('facebook'));
            const finalCUser = finalCookies.some(c => c.name === 'c_user');
            const finalXs = finalCookies.some(c => c.name === 'xs');
            console.log(`${tag} 🍪 Final: ${finalCookies.length} total, ${fbCookies.length} FB, c_user: ${finalCUser ? '✅' : '❌'}, xs: ${finalXs ? '✅' : '❌'}`);

            const accUsername = accEmail.split('@')[0];
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
            await goldenCtx.storageState({ path: ssPath });
            fs.writeFileSync(path.join(DATA_DIR, `fb_cookies_${accUsername}.json`), JSON.stringify(fbCookies, null, 2));

            await goldenCtx.close();

            if (finalCUser && finalXs) {
                console.log(`${tag} ✨ GOLDEN SESSION! (${fbCookies.length} cookies) → ${accUsername}`);
                backupGoldenSession(accUsername);
                return ssPath;
            } else if (finalCUser) {
                console.log(`${tag} ⚠️ Got c_user but no xs — partial session`);
                return ssPath;
            } else {
                console.warn(`${tag} ❌ No c_user after identity forcing`);
                return null;
            }
        } catch (warmErr) {
            console.warn(`${tag} ⚠️ Phase 2 error: ${warmErr.message}`);
            try { await goldenCtx.close(); } catch { }
            return null;
        }

    } catch (err) {
        console.warn(`${tag} ❌ ${strategy.name} error: ${err.message}`);
        if (ctx) try { await ctx.close(); } catch { }
        return null;
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

    clearInvalidSession(accUsername); // Now backs up before clearing!

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

    // ═══ Try each UA strategy ═══
    for (let i = 0; i < UA_STRATEGIES.length; i++) {
        const strategy = UA_STRATEGIES[i];
        console.log(`${tag} 🎭 [${i + 1}/${UA_STRATEGIES.length}] Trying: ${strategy.name}...`);

        const result = await tryLoginWithStrategy(browser, strategy, accEmail, accPassword, code, tag);
        if (result) {
            console.log(`${tag} 🏆 Success with ${strategy.name}!`);
            return result;
        }

        // Refresh TOTP
        if (totpSecret && i < UA_STRATEGIES.length - 1) {
            try { code = authenticator.generate(totpSecret); console.log(`${tag} 🔄 Refreshed TOTP: ${code}`); }
            catch { }
        }
        await delay(3000);
    }

    console.warn(`${tag} 🚨 All ${UA_STRATEGIES.length} UA strategies failed — no c_user`);

    // ═══ SAFETY NET: Restore old cookies so account isn't permanently locked out ═══
    console.log(`${tag} ♻️ Restoring previous cookies (login failed, keeping old session)...`);
    const restored = restoreSession(accUsername);
    if (restored) {
        console.log(`${tag} ✅ Old cookies restored — account will retry with existing session next scan`);
    } else {
        console.warn(`${tag} ❌ No backup found — cookies permanently lost. Manual re-login required.`);
    }

    return null;
}

module.exports = {
    selfHealLogin,
    isSessionHealthy,
    getTotpSecret,
    getRecoveryCode,
    clearInvalidSession,
    backupGoldenSession,
    restoreSession,
    killZombieBrowsers,
    interactWithNewsfeed,
};
