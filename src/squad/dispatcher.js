/**
 * 🎖️ Dispatcher — Multi-Agent Squad Commander
 * Central daemon that polls task queue and dispatches agents.
 * Run: npm run squad
 * 
 * @module squad/dispatcher
 */
require('dotenv').config();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

const squadDB = require('./core/squadDB');
const { canAct } = require('./core/rateLimiter');
const { sniperComment } = require('./agents/sniperAgent');
const { broadcastPost } = require('./agents/broadcasterAgent');
const config = require('./squadConfig');
const accountManager = require('../agent/accountManager');
const { generateFingerprint } = require('../proxy/fingerprint');

chromium.use(StealthPlugin());

// ═══ Browser Context Factory ═══

/**
 * Create an authenticated browser context for an account
 * Uses same cookie injection logic as scraper
 */
async function createAuthContext(browser, account) {
    const accEmail = account.email;
    const accUsername = accEmail.split('@')[0];
    const fp = generateFingerprint({ region: 'US', accountId: accEmail });

    // UA sync
    const uaPath = path.join(__dirname, '..', '..', 'data', `ua_${accUsername}.txt`);
    let ua = fp.userAgent;
    if (fs.existsSync(uaPath)) {
        ua = fs.readFileSync(uaPath, 'utf8').trim();
    }

    const context = await browser.newContext({
        userAgent: ua,
        viewport: fp.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Load cookies (same priority as scraper)
    const cookieJsonPath = path.join(__dirname, '..', '..', 'data', `fb_cookies_${accUsername}.json`);
    const sessionDir = path.join(__dirname, '..', '..', 'data', 'fb_sessions');
    const sessionPath = path.join(sessionDir, `${accEmail.replace(/[@.]/g, '_')}.json`);
    const ssPath = path.join(__dirname, '..', '..', 'data', 'sessions', `${accUsername}_auth.json`);
    let loaded = false;

    // Priority 1: StorageState
    if (fs.existsSync(ssPath)) {
        try {
            await context.close();
            const ssContext = await browser.newContext({
                storageState: ssPath,
                userAgent: ua, viewport: fp.viewport,
                locale: 'en-US', timezoneId: 'America/New_York',
            });
            console.log(`[Dispatcher] 🔑 StorageState loaded for ${accUsername}`);
            return ssContext;
        } catch (e) {
            console.warn(`[Dispatcher] ⚠️ StorageState error: ${e.message}`);
        }
    }

    // Priority 2: Cookie JSON file
    if (fs.existsSync(cookieJsonPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
            const pwc = raw.filter(c => c.name && c.value && c.domain).map(c => ({
                name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
                httpOnly: !!c.httpOnly, secure: c.secure !== false,
                sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None',
                ...(c.expirationDate ? { expires: c.expirationDate } : {}),
            }));
            await context.addCookies(pwc);
            loaded = true;
            console.log(`[Dispatcher] 🍪 Cookies loaded for ${accUsername} (${pwc.length})`);
        } catch (e) { console.warn(`[Dispatcher] ⚠️ Cookie error: ${e.message}`); }
    }

    // Priority 3: Session file
    if (!loaded && fs.existsSync(sessionPath)) {
        try {
            const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            if (saved.length > 0) {
                await context.addCookies(saved);
                console.log(`[Dispatcher] 📂 Session loaded for ${accUsername}`);
            }
        } catch { }
    }

    return context;
}

/**
 * Validate session — check if context is logged in
 */
async function validateSession(context, accUsername) {
    const testPage = await context.newPage();
    try {
        await testPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
        const hasNav = await testPage.$('div[role="navigation"], div[aria-label="Facebook"]');
        const url = testPage.url();
        const valid = hasNav && !url.includes('/login') && !url.includes('checkpoint');
        await testPage.close();
        return valid;
    } catch (e) {
        try { await testPage.close(); } catch { }
        return false;
    }
}

// ═══ Mission Runner ═══

async function runMission(browser) {
    // Get pending tasks
    const pendingComments = squadDB.getPendingCount('comment');
    const pendingPosts = squadDB.getPendingCount('post');

    if (pendingComments === 0 && pendingPosts === 0) {
        console.log(`[Dispatcher] 😴 Không có nhiệm vụ. Biệt đội nghỉ ngơi...`);
        return;
    }

    console.log(`[Dispatcher] 📋 Queue: ${pendingComments} comments, ${pendingPosts} posts`);

    // Get available accounts
    const accounts = accountManager.getActiveAccounts
        ? accountManager.getActiveAccounts()
        : [accountManager.getNextAccount()].filter(Boolean);

    if (accounts.length === 0) {
        console.log(`[Dispatcher] ❌ Không có tài khoản nào sẵn sàng`);
        return;
    }

    // Process tasks for each account
    for (const account of accounts) {
        const accTag = `[${account.email.split('@')[0]}]`;

        // Try comment tasks first
        const commentCheck = canAct(squadDB, account.email, 'comment');
        if (commentCheck.allowed && pendingComments > 0) {
            const task = squadDB.claimNextTask('comment');
            if (task) {
                console.log(`\n${accTag} 🎯 Sniper Mission #${task.id}: ${task.target_url.substring(0, 60)}`);
                let context = null;
                try {
                    context = await createAuthContext(browser, account);
                    const isValid = await validateSession(context, account.email.split('@')[0]);
                    if (!isValid) {
                        console.warn(`${accTag} ❌ Session không hợp lệ — bỏ qua`);
                        squadDB.skipTask(task.id, 'Session invalid');
                        await context.close();
                        continue;
                    }

                    // Random delay before action (2-5 min)
                    const preDelay = 120000 + Math.random() * 180000;
                    console.log(`${accTag} ⏳ Chờ ${(preDelay / 60000).toFixed(1)} phút trước khi hành động...`);
                    await new Promise(r => setTimeout(r, preDelay));

                    const page = await context.newPage();
                    const success = await sniperComment(page, task.target_url, {
                        templateName: task.content_template || 'default',
                        account: account.email,
                    });
                    await page.close();

                    squadDB.completeTask(task.id, success, success ? 'OK' : 'FAILED');
                    console.log(`${accTag} ${success ? '✅ Mục tiêu đã bị hạ!' : '❌ Ám sát thất bại'}`);
                } catch (e) {
                    console.error(`${accTag} ❌ Mission error: ${e.message}`);
                    squadDB.completeTask(task.id, false, e.message);
                } finally {
                    if (context) try { await context.close(); } catch { }
                }
            }
        } else if (!commentCheck.allowed) {
            console.log(`${accTag} 🛑 Comment blocked: ${commentCheck.reason}`);
        }

        // Try post tasks
        const postCheck = canAct(squadDB, account.email, 'post');
        if (postCheck.allowed && pendingPosts > 0) {
            const task = squadDB.claimNextTask('post');
            if (task) {
                console.log(`\n${accTag} 📻 Broadcaster Mission #${task.id}: ${task.target_url}`);
                let context = null;
                try {
                    context = await createAuthContext(browser, account);
                    const isValid = await validateSession(context, account.email.split('@')[0]);
                    if (!isValid) {
                        console.warn(`${accTag} ❌ Session không hợp lệ — bỏ qua`);
                        squadDB.skipTask(task.id, 'Session invalid');
                        await context.close();
                        continue;
                    }

                    const page = await context.newPage();
                    const success = await broadcastPost(page, task.target_url, {
                        templateName: task.content_template || 'promo',
                        account: account.email,
                    });
                    await page.close();

                    squadDB.completeTask(task.id, success, success ? 'OK' : 'FAILED');
                    console.log(`${accTag} ${success ? '🚀 Bài PR đã lên sóng!' : '❌ Phát sóng thất bại'}`);
                } catch (e) {
                    console.error(`${accTag} ❌ Broadcast error: ${e.message}`);
                    squadDB.completeTask(task.id, false, e.message);
                } finally {
                    if (context) try { await context.close(); } catch { }
                }
            }
        } else if (!postCheck.allowed) {
            console.log(`${accTag} 🛑 Post blocked: ${postCheck.reason}`);
        }
    }
}

// ═══ Main Loop ═══

async function startSquad() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  🎖️  THG Multi-Agent Squad — DISPATCHER              ║');
    console.log('║  Sniper 🎯  +  Broadcaster 📻                       ║');
    console.log(`║  Poll interval: ${config.POLL_INTERVAL / 60000} min                            ║`);
    console.log('╚══════════════════════════════════════════════════════╝');

    // Show today's summary
    const summary = squadDB.getTodaySummary();
    if (summary.length > 0) {
        console.log('\n📊 Báo cáo hôm nay:');
        for (const s of summary) {
            console.log(`   ${s.account}: ${s.count} ${s.action_type}(s)`);
        }
    }

    // Show queue
    const queue = squadDB.getQueueStats();
    if (queue.length > 0) {
        console.log('\n📋 Queue status:');
        for (const q of queue) {
            console.log(`   ${q.task_type} [${q.status}]: ${q.count}`);
        }
    }

    // Run first check immediately
    let browser = null;
    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        console.log('\n[Dispatcher] 🌐 Browser launched');

        // Initial run
        await runMission(browser);

        // Poll loop
        const interval = setInterval(async () => {
            console.log(`\n[Dispatcher] 🔄 Polling queue... (${new Date().toLocaleTimeString()})`);
            try {
                await runMission(browser);
            } catch (e) {
                console.error(`[Dispatcher] 💥 Mission critical error: ${e.message}`);
                // Restart browser if crashed
                try { await browser.close(); } catch { }
                browser = await chromium.launch({
                    headless: true,
                    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
                    args: ['--no-sandbox', '--disable-dev-shm-usage'],
                });
            }
        }, config.POLL_INTERVAL);

        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n[Dispatcher] 🛑 Shutdown signal received...');
            clearInterval(interval);
            try { await browser.close(); } catch { }
            process.exit(0);
        });
    } catch (e) {
        console.error(`[Dispatcher] 💥 Fatal: ${e.message}`);
        if (browser) try { await browser.close(); } catch { }
    }
}

// Auto-start when run directly
if (require.main === module) {
    startSquad().catch(console.error);
}

module.exports = { startSquad, runMission };
