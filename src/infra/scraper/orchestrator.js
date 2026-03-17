/**
 * Orchestrator — Main entry for parallel group scraping
 * Coordinates multi-account scraping with shared browser.
 * 
 * @module scraper/orchestrator
 */
const { chromium, delay, fs, path, generateFingerprint, extractGroupId } = require('./browserManager');
const accountManager = require('../../ai/agents/accountManager');
const { bridgeToHub } = require('./hubBridge');
const { runPersonaSession } = require('../../ai/squad/agents/personaAgent');

/**
 * Single-browser Facebook scraper with batched contexts.
 * 1 Chromium + max 2 contexts at a time.
 */
async function scrapeFacebookGroups(maxPosts = 20, options = {}, externalGroups = null) {
    const cfg = require('../../config');
    const groups = (externalGroups && externalGroups.length > 0)
        ? externalGroups
        : (cfg.FB_TARGET_GROUPS || []);

    if (groups.length === 0) {
        console.log('[FBScraper] ⚠️ No target groups configured');
        return [];
    }

    const allAccounts = accountManager.getActiveAccounts
        ? accountManager.getActiveAccounts()
        : [accountManager.getNextAccount(options)].filter(Boolean);

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

    let browser = null;
    const allPosts = [];

    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
                '--disable-blink-features=AutomationControlled', '--disable-extensions',
                '--disable-component-update', '--no-first-run',
                '--js-flags=--max-old-space-size=400',
            ],
        });
        console.log('[FBScraper] 🌐 Browser launched');

        const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '2', 10); // VPS-safe default; local .env can set 4
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
    if (allPosts.length > 0) await bridgeToHub(allPosts);
    return allPosts;
}

/**
 * Scrape groups for ONE account using a context in the shared browser.
 */
async function _scrapeWithContext(browser, account, groups) {
    const accEmail = account.email;
    const tag = `[${accEmail.split('@')[0]}]`;
    console.log(`\n${tag} ═══ Starting (${groups.length} groups) ═══`);

    const fp = generateFingerprint({ region: 'US', accountId: accEmail });
    let context = null;
    const posts = [];

    // UA Sync
    const accUsername = accEmail.split('@')[0];
    const uaPath = path.join(__dirname, '..', '..', '..', 'data', `ua_${accUsername}.txt`);
    let syncedUA = fp.userAgent;
    if (fs.existsSync(uaPath)) {
        syncedUA = fs.readFileSync(uaPath, 'utf8').trim();
        console.log(`${tag} 🔑 UA Synced from cookie injection: ${syncedUA.substring(0, 60)}...`);
    }

    try {
        // ═══ Proxy Injection (1 static IP per account) ═══
        const proxyEnvKey = `PROXY_${accUsername}`;
        const proxyUrl = process.env[proxyEnvKey] || '';
        let proxyConfig = undefined;

        if (proxyUrl) {
            try {
                const parsed = new URL(proxyUrl);
                proxyConfig = {
                    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
                    username: decodeURIComponent(parsed.username),
                    password: decodeURIComponent(parsed.password),
                };
                console.log(`${tag} 🌐 Proxy: ${parsed.hostname}:${parsed.port}`);
            } catch (e) {
                console.warn(`${tag} ⚠️ Invalid proxy URL in ${proxyEnvKey}: ${e.message}`);
            }
        } else {
            console.log(`${tag} 🏠 No proxy (using local IP)`);
        }

        context = await browser.newContext({
            userAgent: syncedUA,
            viewport: fp.viewport,
            locale: 'en-US',
            timezoneId: 'America/New_York',
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        });

        // Load cookies
        const cookieJsonPath = path.join(__dirname, '..', '..', '..', 'data', `fb_cookies_${accUsername}.json`);
        const sessionDir = path.join(__dirname, '..', '..', '..', 'data', 'fb_sessions');
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

        // Validate session — PATIENT check (retry once before abort)
        const testPage = await context.newPage();
        let sessionValid = false;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                if (attempt === 1) {
                    await testPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
                } else {
                    console.log(`${tag} 🔄 Retry validation (attempt 2)...`);
                    await testPage.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
                }

                // Wait for nav element (up to 10s) — much more patient than old 3s
                const hasNav = await testPage.waitForSelector(
                    'div[role="navigation"], div[aria-label="Facebook"], a[aria-label="Facebook"]',
                    { timeout: 10000 }
                ).catch(() => null);

                const testUrl = testPage.url();
                if (hasNav && !testUrl.includes('/login') && !testUrl.includes('checkpoint')) {
                    sessionValid = true;
                    break;
                }

                if (testUrl.includes('checkpoint')) {
                    console.warn(`${tag} 🚨 Checkpoint detected`);
                    break;
                }
                if (testUrl.includes('/login')) {
                    console.warn(`${tag} 🔒 Redirected to login (attempt ${attempt})`);
                }
            } catch (e) {
                console.warn(`${tag} ⚠️ Validation attempt ${attempt} error: ${e.message.substring(0, 60)}`);
            }

            if (attempt < 2) await delay(3000); // Pause before retry
        }

        if (sessionValid) {
            console.log(`${tag} ✅ Session valid!`);
            await testPage.close();
        } else {
            // ═══ SCREENSHOT DEBUG: Capture what Facebook is showing ═══
            try {
                const debugUrl = testPage.url();
                const debugTitle = await testPage.title().catch(() => 'N/A');
                console.warn(`${tag} 🔍 DEBUG: URL = ${debugUrl}`);
                console.warn(`${tag} 🔍 DEBUG: Title = ${debugTitle}`);

                const screenshotPath = path.join(__dirname, '..', '..', '..', 'data', `error_${accUsername}.png`);
                await testPage.screenshot({ path: screenshotPath, fullPage: true });
                console.warn(`${tag} 📸 Screenshot saved → ${screenshotPath}`);

                // Check for common Facebook popups/blockers
                const bodyText = await testPage.textContent('body').catch(() => '');
                if (bodyText.includes('checkpoint')) {
                    console.warn(`${tag} 🚨 CHECKPOINT DETECTED in page body`);
                } else if (bodyText.includes('Đăng nhập') || bodyText.includes('Log in') || bodyText.includes('Log In')) {
                    console.warn(`${tag} 🔒 LOGIN PAGE — cookies expired or revoked`);
                } else if (bodyText.includes('confirm your identity') || bodyText.includes('xác minh')) {
                    console.warn(`${tag} 🛡️ IDENTITY VERIFICATION popup detected`);
                } else if (bodyText.includes('cookie') || bodyText.includes('consent')) {
                    console.warn(`${tag} 🍪 COOKIE CONSENT popup blocking — may need auto-dismiss`);
                } else {
                    console.warn(`${tag} ❓ Unknown blocker. First 200 chars: ${bodyText.substring(0, 200)}`);
                }
            } catch (ssErr) {
                console.warn(`${tag} ⚠️ Screenshot failed: ${ssErr.message}`);
            }

            console.warn(`${tag} ❌ Session invalid after 2 attempts. Self-healing disabled to protect IP/User-Agent. Please extract cookies manually via Desktop.`);
            await testPage.close();
            await context.close();
            return [];
        }

        // AUTO-RENEW cookies
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
            const ssDir = path.join(__dirname, '..', '..', '..', 'data', 'sessions');
            const ssPath = path.join(ssDir, `${accUsername}_auth.json`);
            fs.mkdirSync(ssDir, { recursive: true });
            await context.storageState({ path: ssPath });
            console.log(`${tag} 🔑 StorageState saved → ${accUsername}_auth.json`);
        } catch (e) { console.warn(`${tag} ⚠️ Cookie save error: ${e.message}`); }

        // 🎭 Persona Warm-up — PASSIVE camouflage before scraping
        const warmPage = await context.newPage();
        try {
            console.log(`${tag} � Đang khoác áo Nguỵ Trang (Warm-up)...`);
            await runPersonaSession(warmPage, accUsername, 'light');
        } catch (e) { console.warn(`${tag} ⚠️ Persona Warm-up error: ${e.message}`); }
        finally {
            await warmPage.close();
            await delay(2000 + Math.random() * 3000);
        }

        // Scrape each group
        const page = await context.newPage();
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const groupId = extractGroupId(group.url);
            if (!groupId) continue;

            try {
                // Human-like jitter
                if (i > 0) {
                    const jitter = 8000 + Math.random() * 12000;
                    console.log(`${tag} 😴 Jitter: ${(jitter / 1000).toFixed(1)}s`);
                    await delay(jitter);
                    if (i % 5 === 0) {
                        const breakTime = 25000 + Math.random() * 20000;
                        console.log(`${tag} ☕ Coffee break: ${(breakTime / 1000).toFixed(0)}s`);
                        await delay(breakTime);
                    }
                }

                console.log(`${tag} [${i + 1}/${groups.length}] 📥 ${group.name}`);
                await page.goto(`https://www.facebook.com/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(3000 + Math.random() * 2000);

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

                // ═══ DYNAMIC SCROLLING — Cuộn thông minh, cắt sớm bài cũ ═══
                const MAX_AGE_DAYS = 3;
                let noGrowth = 0, prevCnt = 0;

                for (let s = 0; s < 35; s++) {
                    await page.evaluate(() => window.scrollBy(0, 2000 + Math.random() * 500));
                    await delay(1000 + Math.random() * 1000);

                    const scrollStatus = await page.evaluate((maxDays) => {
                        const feed = document.querySelector('div[role="feed"]');
                        if (!feed) return { cnt: 0, stopEarly: false, timeLog: '' };

                        const articles = feed.querySelectorAll(':scope > div');
                        let cnt = 0, lastValidTime = '';

                        for (let i = articles.length - 1; i >= 0; i--) {
                            const a = articles[i];
                            if (a.innerText && a.innerText.length > 50) {
                                cnt++;
                                if (!lastValidTime) {
                                    const abbr = a.querySelector('abbr');
                                    if (abbr) lastValidTime = abbr.textContent?.trim() || abbr.getAttribute('title') || '';
                                    if (!lastValidTime) {
                                        for (const sp of a.querySelectorAll('span')) {
                                            const t = sp.textContent?.trim();
                                            if (t && t.match(/^\d+[mhdw]$|^just now$|^yesterday$|^hôm qua$|^\d+\s*(phút|giờ|ngày|tuần|năm|tháng)/i)) {
                                                lastValidTime = t; break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let stopEarly = false;
                        if (lastValidTime) {
                            const s = lastValidTime.toLowerCase();
                            if (s.match(/w\b|wk|week|tuần|tháng|month|năm|year/)) stopEarly = true;
                            if (s.match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i)) stopEarly = true;
                            if (s.match(/\b(20[12]\d)\b/)) stopEarly = true;
                            const dayMatch = s.match(/(\d+)\s*(d\b|day|ngày)/);
                            if (dayMatch && parseInt(dayMatch[1]) > maxDays) stopEarly = true;
                        }
                        return { cnt, stopEarly, timeLog: lastValidTime };
                    }, MAX_AGE_DAYS);

                    if (scrollStatus.cnt >= 40) {
                        console.log(`${tag} 🎯 ${group.name}: Đạt 40 bài. Dừng cuộn.`);
                        break;
                    }
                    if (scrollStatus.stopEarly) {
                        console.log(`${tag} 🛑 ${group.name}: Bài cũ [${scrollStatus.timeLog}]. Cắt sớm!`);
                        break;
                    }
                    if (scrollStatus.cnt === prevCnt) {
                        noGrowth++;
                        if (noGrowth >= 3) { console.log(`${tag} 🔚 ${group.name}: Kịch đáy.`); break; }
                    } else { noGrowth = 0; }
                    prevCnt = scrollStatus.cnt;
                }

                // Click "See More" buttons to expand truncated posts
                try {
                    const seeMoreBtns = await page.$$('div[role="button"]:has-text("See more"), div[role="button"]:has-text("Xem thêm")');
                    for (const btn of seeMoreBtns.slice(0, 15)) {
                        await btn.click().catch(() => { });
                    }
                    if (seeMoreBtns.length > 0) await delay(500);
                } catch { }

                const gPosts = await page.evaluate(({ gName, gUrl, maxAgeDays }) => {
                    const feed = document.querySelector('div[role="feed"]');
                    if (!feed) return [];

                    function parseRelativeTime(timeStr) {
                        if (!timeStr) return null;
                        const s = timeStr.trim().toLowerCase();
                        if (s.includes('just now') || s.includes('vừa xong') || s === 'now') return 0;
                        let m = s.match(/(\d+)\s*(m\b|min|mins|minute|minutes|phút)/);
                        if (m) return parseInt(m[1]) / 60;
                        m = s.match(/(\d+)\s*(h\b|hr|hrs|hour|hours|giờ)/);
                        if (m) return parseInt(m[1]);
                        m = s.match(/(\d+)\s*(d\b|day|days|ngày)/);
                        if (m) return parseInt(m[1]) * 24;
                        m = s.match(/(\d+)\s*(w\b|wk|wks|week|weeks|tuần)/);
                        if (m) return parseInt(m[1]) * 24 * 7;
                        m = s.match(/(\d+)\s*(tháng|month|months|mo\b)/);
                        if (m) return parseInt(m[1]) * 24 * 30;
                        m = s.match(/(\d+)\s*(năm|year|years|yr|yrs)/);
                        if (m) return parseInt(m[1]) * 24 * 365;
                        if (s.includes('yesterday') || s.includes('hôm qua')) return 24;

                        m = s.match(/(\d{1,2})\s*tháng\s*(\d{1,2})(?:,?\s*(\d{4}))?/);
                        if (m) {
                            const day = parseInt(m[1]), month = parseInt(m[2]) - 1;
                            const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
                            const postDate = new Date(year, month, day);
                            const ageMs = Date.now() - postDate.getTime();
                            return ageMs > 0 ? ageMs / (1000 * 3600) : 0;
                        }
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
                        m = s.match(/\b(20[12]\d)\b/);
                        if (m) {
                            const year = parseInt(m[1]);
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

                        const links = Array.from(a.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/groups/"][href*="/posts/"]'));
                        let rawUrl = links[0]?.href || '';
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

                        let timeStr = '';
                        for (const link of links) {
                            const ariaTime = link.getAttribute('aria-label');
                            if (ariaTime && ariaTime.match(/\d/)) { timeStr = ariaTime; break; }
                            const linkText = link.innerText?.trim();
                            if (linkText && linkText.match(/^\d+[mhdw]$|^just now$|^yesterday$/i)) { timeStr = linkText; break; }
                        }
                        if (!timeStr) {
                            const abbr = a.querySelector('abbr');
                            if (abbr) timeStr = abbr.textContent?.trim() || abbr.getAttribute('title') || '';
                        }
                        if (!timeStr) {
                            const spans = a.querySelectorAll('span');
                            for (const sp of spans) {
                                const t = sp.textContent?.trim();
                                if (t && t.match(/^\d+[mhdw]$|^just now$|^yesterday$|^hôm qua$|^\d+\s*(phút|giờ|ngày|tuần|năm|tháng|year|month|week|day|hour|min)/i)) {
                                    timeStr = t; break;
                                }
                                if (t && t.match(/^\d{1,2}\s*tháng\s*\d{1,2}/i)) { timeStr = t; break; }
                                if (t && t.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i)) { timeStr = t; break; }
                            }
                        }

                        const ageHours = parseRelativeTime(timeStr);
                        const ageDays = ageHours !== null ? ageHours / 24 : null;
                        if (ageDays !== null && ageDays > maxAgeDays) return;
                        if (ageDays === null && timeStr) return;

                        let postedAt = '';
                        if (ageHours !== null) postedAt = new Date(now - ageHours * 3600 * 1000).toISOString();

                        // Author extraction (5 strategies)
                        let author = '';
                        let authorUrl = '';
                        const profileImg = a.querySelector('image, img[src*="scontent"], svg image');
                        if (profileImg) {
                            const alt = profileImg.getAttribute('alt') || profileImg.closest('[aria-label]')?.getAttribute('aria-label') || '';
                            if (alt && alt.length > 1 && alt.length < 80 && !alt.match(/photo|hình|ảnh|image|like|comment/i)) {
                                author = alt.replace(/'s profile.*|'s photo.*/i, '').trim();
                            }
                        }
                        if (!author) {
                            const headerLinks = a.querySelectorAll('a[href*="/user/"], a[href*="profile.php"], a[href*="facebook.com/"][role="link"]');
                            for (const hl of headerLinks) {
                                const name = hl.innerText?.trim();
                                const href = hl.href || '';
                                if (name && name.length > 1 && name.length < 60
                                    && !name.match(/^(\d+[mhdw]|just now|yesterday|hôm qua|like|comment|share|chia sẻ)$/i)
                                    && !href.includes('/posts/') && !href.includes('/permalink/') && !href.includes('story_fbid')) {
                                    author = name; authorUrl = href.split('?')[0]; break;
                                }
                            }
                        }
                        if (!author) {
                            const classicEl = a.querySelector('h2 a, h3 a, h4 a, strong a[role="link"]');
                            if (classicEl) {
                                author = classicEl.innerText?.trim() || '';
                                authorUrl = authorUrl || (classicEl.href || '').split('?')[0];
                            }
                        }
                        if (!author) {
                            const allLinks = a.querySelectorAll('a[href]');
                            for (const al of allLinks) {
                                const href = al.href || '';
                                if ((href.includes('facebook.com/') && !href.includes('/posts/') && !href.includes('/groups/')
                                    && !href.includes('/permalink/') && !href.includes('story_fbid') && !href.includes('#')
                                    && !href.includes('/photos/') && !href.includes('/videos/'))) {
                                    const name = al.innerText?.trim();
                                    if (name && name.length > 1 && name.length < 60 && !name.match(/^\d+$/)) {
                                        author = name; authorUrl = href.split('?')[0]; break;
                                    }
                                }
                            }
                        }
                        if (!author) {
                            const headerStrong = a.querySelector('strong');
                            if (headerStrong) {
                                const name = headerStrong.innerText?.trim();
                                if (name && name.length > 1 && name.length < 60) author = name;
                            }
                        }

                        res.push({
                            platform: 'facebook',
                            group_name: gName, group_url: gUrl, post_url: postUrl,
                            author_name: author || 'Unknown', author_url: authorUrl, author_avatar: '',
                            content: txt.substring(0, 2000),
                            post_created_at: postedAt, time_raw: timeStr,
                            scraped_at: new Date().toISOString(), source_group: gName, item_type: 'post'
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

            if (i < groups.length - 1) await delay(5000 + Math.random() * 5000);
            if (i > 0 && i % 5 === 0) { const m = process.memoryUsage(); console.log(`${tag} 💾 RSS=${Math.round(m.rss / 1024 / 1024)}MB`); }
        }
        await page.close();

        // 🎭 Persona Cool-down — thư giãn sau khi quét xong
        const coolDownPage = await context.newPage();
        try {
            console.log(`${tag} 🎭 Quét xong! Đang thư giãn xoá dấu vết (Cool-down)...`);
            await runPersonaSession(coolDownPage, accUsername, 'medium');
        } catch (e) {
            console.warn(`${tag} ⚠️ Persona Cool-down error: ${e.message}`);
        } finally {
            await coolDownPage.close();
        }
    } catch (err) {
        console.error(`${tag} 💥 Fatal: ${err.message}`);
    } finally {
        try { if (context) await context.close(); } catch { }
        console.log(`${tag} 🏁 Done: ${posts.length} posts`);
    }
    return posts;
}

module.exports = { scrapeFacebookGroups };
