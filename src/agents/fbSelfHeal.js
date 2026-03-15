/**
 * THG Lead Gen — Facebook Self-Healing Login Module
 * 
 * Strategy: Page No-JS Login → Golden Session
 * 
 * WHY page.goto() with javaScriptEnabled: false:
 *   - context.request returns raw HTML: form buried in JS bundles, regex fails
 *   - page renders DOM: page.$('input[name="email"]') finds form ANYWHERE
 *   - JS disabled = Arkose Labs cannot run (needs JS engine)
 *   - Browser still sends proper Sec-Fetch-* headers
 *   - Noscript fallback shows plain HTML login form
 * 
 * Flow:
 *   1. Create context: JS OFF + mobile UA + matching sec-ch-ua
 *   2. page.goto('https://www.facebook.com/') → datr + noscript login form
 *   3. page.$('input[name="email"]') → DOM-based form detection
 *   4. page.fill() + Enter → submit login
 *   5. Handle 2FA via DOM on checkpoint page
 *   6. Transfer cookies → JS desktop context → /me + warm-up
 *   7. If strategy fails → rotate to next UA
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
// UA Strategies — matching UA + sec-ch-ua headers
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
        execSync("ps aux | grep -v grep | grep -E 'chrom' | awk '{print $2}' | xargs -r kill -9 2>/dev/null", { timeout: 5000, stdio: 'ignore' });
        execSync('rm -rf /tmp/playwright_chromiumdev_profile-* 2>/dev/null', { timeout: 5000, stdio: 'ignore' });
        console.log('[System] ✅ Cleanup done');
    } catch {
        // No zombies = no problem
    }
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
// DOM-based form detection helpers
// ═══════════════════════════════════════════════════════

/** Find login form inputs in the page DOM (works with JS off) */
async function findLoginForm(page, tag) {
    // Try standard selectors first
    let emailInput = await page.$('input[name="email"]');
    let passInput = await page.$('input[name="pass"]');

    if (emailInput && passInput) return { emailInput, passInput };

    // Try ID-based selectors
    emailInput = await page.$('#email, input#m_login_email');
    passInput = await page.$('#pass, input#m_login_password');

    if (emailInput && passInput) return { emailInput, passInput };

    // Try type-based selectors (broader search)
    const allInputs = await page.$$('input');
    let foundEmail = null, foundPass = null;

    for (const inp of allInputs) {
        const type = await inp.getAttribute('type').catch(() => '');
        const name = await inp.getAttribute('name').catch(() => '');
        const id = await inp.getAttribute('id').catch(() => '');
        const placeholder = await inp.getAttribute('placeholder').catch(() => '');
        const ariaLabel = await inp.getAttribute('aria-label').catch(() => '');

        // Log all inputs for debugging
        if (name || id) {
            console.log(`${tag}   🔍 <input name="${name}" type="${type}" id="${id}" placeholder="${(placeholder || '').substring(0, 30)}">`);
        }

        // Match email/text input
        if (!foundEmail && (type === 'email' || type === 'text' || type === 'tel') &&
            (name === 'email' || id === 'email' || id === 'm_login_email' ||
                placeholder?.toLowerCase().includes('email') || placeholder?.toLowerCase().includes('phone') ||
                ariaLabel?.toLowerCase().includes('email'))) {
            foundEmail = inp;
        }
        // Match password input
        if (!foundPass && type === 'password') {
            foundPass = inp;
        }
    }

    if (foundEmail && foundPass) return { emailInput: foundEmail, passInput: foundPass };
    return null;
}

// ═══════════════════════════════════════════════════════
// Try login with one UA strategy (page-based, No-JS)
// ═══════════════════════════════════════════════════════

async function tryLoginWithStrategy(browser, strategy, accEmail, accPassword, code, tag) {
    let ctx = null;
    try {
        ctx = await browser.newContext({
            userAgent: strategy.ua,
            extraHTTPHeaders: strategy.headers,
            viewport: strategy.viewport,
            isMobile: true,
            javaScriptEnabled: false, // KEY: No JS = No Arkose!
            locale: 'en-US',
        });

        const page = await ctx.newPage();

        // ─── Step 1: Navigate to facebook.com (datr bootstrap + noscript form) ───
        console.log(`${tag} 🎣 Loading facebook.com (No-JS mode)...`);
        await page.goto('https://www.facebook.com/', {
            waitUntil: 'load',
            timeout: 60000,
        });
        await delay(3000);

        const landingUrl = page.url();
        console.log(`${tag} 🔧 Landing: ${landingUrl.substring(0, 80)}`);

        // Check datr cookie
        const cookies = await ctx.cookies();
        const hasDatr = cookies.some(c => c.name === 'datr');
        console.log(`${tag} 🔧 datr: ${hasDatr ? 'YES ✅' : 'NO ❌'}, cookies: ${cookies.length}`);

        // ─── Step 2: Find login form via DOM query ───
        console.log(`${tag} 🔍 Searching for login form in DOM...`);
        let formResult = await findLoginForm(page, tag);

        if (!formResult) {
            // Try mbasic (browser follows 302 to www, noscript renders)
            console.log(`${tag} 🔧 No form on www. Trying mbasic...`);
            await page.goto('https://mbasic.facebook.com/login/', {
                waitUntil: 'load',
                timeout: 30000,
            });
            await delay(3000);
            console.log(`${tag} 🔧 mbasic URL: ${page.url().substring(0, 80)}`);
            formResult = await findLoginForm(page, tag);
        }

        if (!formResult) {
            // Try www/login directly
            console.log(`${tag} 🔧 Trying www.facebook.com/login/...`);
            await page.goto('https://www.facebook.com/login/', {
                waitUntil: 'load',
                timeout: 30000,
            });
            await delay(3000);
            formResult = await findLoginForm(page, tag);
        }

        if (!formResult) {
            console.warn(`${tag} ❌ No login form found with ${strategy.name}`);
            // Dump page content for debugging
            const content = await page.content();
            // Strip scripts, show first 500 chars of HTML
            const stripped = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
            console.log(`${tag} 🔧 Page HTML (cleaned, first 300): ${stripped.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 300)}`);
            await ctx.close();
            return null;
        }

        // ─── Step 3: Fill form and submit ───
        console.log(`${tag} 📝 Login form FOUND! Filling credentials...`);
        await formResult.emailInput.fill(accEmail);
        await delay(500 + Math.random() * 500);
        await formResult.passInput.fill(accPassword);
        await delay(500 + Math.random() * 500);

        // Submit form
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => { }),
            page.keyboard.press('Enter'),
        ]);
        await delay(5000);

        const postLoginUrl = page.url();
        console.log(`${tag} 🔧 Post-login URL: ${postLoginUrl.substring(0, 100)}`);

        // ─── Step 4: Handle 2FA ───
        const needs2FA = postLoginUrl.includes('checkpoint') || postLoginUrl.includes('two_step') ||
            postLoginUrl.includes('approvals') || postLoginUrl.includes('login/identify');

        if (needs2FA) {
            console.log(`${tag} 🔐 2FA checkpoint detected`);
            if (!code) {
                console.warn(`${tag} ❌ No 2FA code available!`);
                await ctx.close();
                return null;
            }

            // Look for code input
            let codeInput = await page.$('input[name="approvals_code"]');
            if (!codeInput) {
                // Click "Try another way" / fallback link
                const fallbackLink = await page.$('a[href*="checkpoint/fallback"], a[href*="try_another"]');
                if (fallbackLink) {
                    console.log(`${tag} 🔧 Clicking fallback link...`);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => { }),
                        fallbackLink.click(),
                    ]);
                    await delay(3000);
                    codeInput = await page.$('input[name="approvals_code"]');
                }
            }

            // Broader search for code input
            if (!codeInput) {
                const inputs = await page.$$('input[type="text"], input[type="tel"], input[type="number"]');
                for (const inp of inputs) {
                    const name = await inp.getAttribute('name').catch(() => '');
                    const type = await inp.getAttribute('type').catch(() => '');
                    if (name && name !== 'email' && name !== 'pass' && name !== 'lsd') {
                        console.log(`${tag} 🔧 Using input name="${name}" type="${type}" for 2FA`);
                        codeInput = inp;
                        break;
                    }
                }
            }

            if (codeInput) {
                console.log(`${tag} ⚡ Submitting 2FA code: ${code}`);
                await codeInput.fill(code.replace(/\s/g, ''));
                await delay(1000);

                // Check "save device" option
                const saveDevice = await page.$('input[name="save_device"][value="1"], input[name="name_action_selected"]');
                if (saveDevice) {
                    try { await saveDevice.check(); } catch { await saveDevice.click().catch(() => { }); }
                    console.log(`${tag} 💾 "Save Device" checked`);
                }

                // Submit
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => { }),
                    page.keyboard.press('Enter'),
                ]);
                await delay(5000);
                console.log(`${tag} 🔧 Post-2FA URL: ${page.url().substring(0, 100)}`);

                // Handle checkpoint continuation steps
                for (let step = 0; step < 5; step++) {
                    const stepUrl = page.url();
                    if (!stepUrl.includes('checkpoint') && !stepUrl.includes('two_step') && !stepUrl.includes('approvals')) break;
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).catch(() => { }),
                        page.keyboard.press('Enter'),
                    ]);
                    await delay(3000);
                    console.log(`${tag} ✅ Checkpoint step ${step + 1}: ${page.url().substring(0, 80)}`);
                }
            } else {
                console.warn(`${tag} ❌ No 2FA code input found`);
                // Dump page for debugging
                const allInputs = await page.$$('input');
                for (const inp of allInputs) {
                    const nm = await inp.getAttribute('name').catch(() => '');
                    const tp = await inp.getAttribute('type').catch(() => '');
                    console.log(`${tag}   🔧 <input name="${nm}" type="${tp}">`);
                }
                await ctx.close();
                return null;
            }
        }

        // ─── Step 5: Golden Session (transfer cookies to JS-enabled desktop context) ───
        const allCookies = await ctx.cookies();
        await ctx.close();
        ctx = null;

        const hasCUserRaw = allCookies.some(c => c.name === 'c_user');
        console.log(`${tag} 📥 Phase 1 cookies: ${allCookies.length}, c_user: ${hasCUserRaw ? 'YES' : 'NO'}`);

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

            // Handle checkpoint
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

            // Check + Save
            const finalCookies = await goldenCtx.cookies();
            const fbCookies = finalCookies.filter(c => c.domain?.includes('facebook'));
            const hasCUser = finalCookies.some(c => c.name === 'c_user');
            const hasXs = finalCookies.some(c => c.name === 'xs');
            console.log(`${tag} 🍪 Total: ${finalCookies.length}, FB: ${fbCookies.length}, c_user: ${hasCUser ? '✅' : '❌'}, xs: ${hasXs ? '✅' : '❌'}`);

            const accUsername = accEmail.split('@')[0];
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            const ssPath = path.join(SESSIONS_DIR, `${accUsername}_auth.json`);
            await goldenCtx.storageState({ path: ssPath });
            fs.writeFileSync(path.join(DATA_DIR, `fb_cookies_${accUsername}.json`), JSON.stringify(fbCookies, null, 2));

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
                const accUsername = accEmail.split('@')[0];
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

    // ═══ Try each UA strategy ═══
    for (let i = 0; i < UA_STRATEGIES.length; i++) {
        const strategy = UA_STRATEGIES[i];
        console.log(`${tag} 🎭 [${i + 1}/${UA_STRATEGIES.length}] Trying: ${strategy.name}...`);

        const result = await tryLoginWithStrategy(browser, strategy, accEmail, accPassword, code, tag);
        if (result) {
            console.log(`${tag} 🏆 Success with ${strategy.name}!`);
            return result;
        }

        // Refresh TOTP between strategies
        if (totpSecret && i < UA_STRATEGIES.length - 1) {
            try { code = authenticator.generate(totpSecret); console.log(`${tag} 🔄 Refreshed TOTP: ${code}`); }
            catch { }
        }
        await delay(3000);
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
