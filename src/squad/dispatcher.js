/**
 * 🎖️ Squad Dispatcher — 5-Phase Cycle Commander
 * 
 * SINGLE PROCESS, SEQUENTIAL FLOW. Never parallel.
 * Warm-up → Broadcast → Scrape → Snipe → Cool-down
 * 
 * @module squad/dispatcher
 */
require('dotenv').config();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

const { runPersonaSession } = require('./agents/personaAgent');
const { sniperComment } = require('./agents/sniperAgent');
const { broadcastPost } = require('./agents/broadcasterAgent');
const { canAct } = require('./core/rateLimiter');
const squadDB = require('./core/squadDB');
const config = require('./squadConfig');
const accountManager = require('../agent/accountManager');
const { generateFingerprint } = require('../proxy/fingerprint');
const { isSessionHealthy } = require('../agents/fbSelfHeal');

chromium.use(StealthPlugin());

const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 600));

// ═══════════════════════════════════════════════════════
// Browser Context Factory (same logic as orchestrator)
// ═══════════════════════════════════════════════════════
async function createSquadContext(browser, account) {
    const accUsername = account.email.split('@')[0];
    const tag = `[Squad:${accUsername}]`;

    const fp = generateFingerprint({ region: 'US', accountId: account.email });

    // Sync UA if available
    const uaPath = path.join(__dirname, '..', '..', 'data', `ua_${accUsername}.txt`);
    let syncedUA = fp.userAgent;
    if (fs.existsSync(uaPath)) {
        syncedUA = fs.readFileSync(uaPath, 'utf8').trim();
    }

    const context = await browser.newContext({
        userAgent: syncedUA,
        viewport: fp.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Load cookies
    const cookieJsonPath = path.join(__dirname, '..', '..', 'data', `fb_cookies_${accUsername}.json`);
    if (fs.existsSync(cookieJsonPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
            const pwc = raw.filter(c => c.name && c.value && c.domain).map(c => ({
                name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
                httpOnly: !!c.httpOnly, secure: c.secure !== false,
                sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : 'Strict',
                ...(c.expirationDate ? { expires: c.expirationDate } : {}),
            }));
            await context.addCookies(pwc);
            console.log(`${tag} 🍪 Loaded ${pwc.length} cookies`);
        } catch (e) {
            console.warn(`${tag} ⚠️ Cookie error: ${e.message}`);
        }
    }

    return { context, tag };
}

async function validateSquadSession(context, tag) {
    const page = await context.newPage();
    try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        const hasNav = await page.waitForSelector(
            'div[role="navigation"], div[aria-label="Facebook"]',
            { timeout: 10000 }
        ).catch(() => null);
        const url = page.url();
        if (hasNav && !url.includes('/login') && !url.includes('checkpoint')) {
            await page.close();
            return true;
        }
        if (url.includes('checkpoint')) {
            console.warn(`${tag} 🚨 CHECKPOINT — account marked DEAD`);
        }
        await page.close();
        return false;
    } catch {
        try { await page.close(); } catch { }
        return false;
    }
}

// ═══════════════════════════════════════════════════════
// PHASE 1: WARM-UP (Persona camouflage)
// ═══════════════════════════════════════════════════════
async function phaseWarmUp(browser, accounts) {
    console.log('\n' + '═'.repeat(55));
    console.log('  🎭 PHASE 1: WARM-UP (Persona Camouflage)');
    console.log('═'.repeat(55));

    // Pick 1-2 random accounts for warm-up
    const warmupAccounts = accounts
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.min(2, accounts.length));

    for (const account of warmupAccounts) {
        const { context, tag } = await createSquadContext(browser, account);
        try {
            const valid = await validateSquadSession(context, tag);
            if (!valid) {
                console.log(`${tag} ❌ Session invalid → skip warm-up`);
                continue;
            }

            const page = await context.newPage();
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
            await delay(2000);

            console.log(`${tag} 🏠 Browsing feed...`);
            await runPersonaSession(page, tag, 'light');

            await page.close();
            console.log(`${tag} ✅ Warm-up done`);
        } catch (e) {
            console.error(`${tag} ❌ Warm-up error: ${e.message}`);
        } finally {
            await context.close();
        }
        await delay(3000);
    }
}

// ═══════════════════════════════════════════════════════
// PHASE 2: BROADCAST (1x/day, rotate accounts)
// ═══════════════════════════════════════════════════════
async function phaseBroadcast(browser, accounts) {
    console.log('\n' + '═'.repeat(55));
    console.log('  📻 PHASE 2: BROADCAST (PR Post)');
    console.log('═'.repeat(55));

    // Find an account that can post today
    let broadcastAccount = null;
    for (const acc of accounts) {
        const check = canAct(squadDB, acc.email, 'post');
        if (check.allowed) {
            broadcastAccount = acc;
            break;
        } else {
            console.log(`[Broadcast] ⏭️ ${acc.email.split('@')[0]}: ${check.reason}`);
        }
    }

    if (!broadcastAccount) {
        console.log('[Broadcast] 📭 All accounts exhausted post quota for today → skip');
        return;
    }

    const { context, tag } = await createSquadContext(browser, broadcastAccount);
    try {
        const valid = await validateSquadSession(context, tag);
        if (!valid) {
            console.log(`${tag} ❌ Session invalid → skip broadcast`);
            return;
        }

        // Pick random active group from groups.db
        let targetGroup = null;
        try {
            const groupDiscovery = require('../agent/groupDiscovery');
            const groups = groupDiscovery.getScanRotationList(200);
            if (groups.length > 0) {
                targetGroup = groups[Math.floor(Math.random() * groups.length)];
            }
        } catch { }

        if (!targetGroup) {
            console.log(`${tag} ⚠️ No target groups for broadcast`);
            return;
        }

        const page = await context.newPage();
        console.log(`${tag} 📻 Broadcasting to: ${targetGroup.name}`);

        const success = await broadcastPost(page, targetGroup.url, {
            templateName: 'promo',
            account: broadcastAccount.email,
        });

        if (success) {
            console.log(`${tag} 🚀 PR posted successfully!`);
        } else {
            console.log(`${tag} ⚠️ Post failed (group may restrict posting)`);
        }

        await page.close();
    } catch (e) {
        console.error(`${tag} ❌ Broadcast error: ${e.message}`);
    } finally {
        await context.close();
    }
}

// ═══════════════════════════════════════════════════════
// PHASE 3: SCRAPE (uses existing orchestrator)
// ═══════════════════════════════════════════════════════
async function phaseScrape() {
    console.log('\n' + '═'.repeat(55));
    console.log('  🔍 PHASE 3: SCRAPE (Orchestrator)');
    console.log('═'.repeat(55));

    try {
        const { scrapeFacebookGroups } = require('../scraper/orchestrator');
        const posts = await scrapeFacebookGroups(30);
        console.log(`[Scrape] ✅ Scraped ${posts ? posts.length : 0} posts total`);
        return posts || [];
    } catch (e) {
        console.error(`[Scrape] ❌ Scraper error: ${e.message}`);
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// PHASE 4: SNIPE (Comment on lead posts from task queue)
// ═══════════════════════════════════════════════════════
async function phaseSnipe(browser, accounts) {
    console.log('\n' + '═'.repeat(55));
    console.log('  🎯 PHASE 4: SNIPE (Comment Lead Posts)');
    console.log('═'.repeat(55));

    const pendingCount = squadDB.getPendingCount('comment');
    if (pendingCount === 0) {
        console.log('[Sniper] 📭 No pending comment tasks → skip');
        return;
    }
    console.log(`[Sniper] 🎯 ${pendingCount} pending targets in queue`);

    // Find accounts that can comment today
    const availableAccounts = accounts.filter(acc => {
        const check = canAct(squadDB, acc.email, 'comment');
        if (!check.allowed) {
            console.log(`[Sniper] ⏭️ ${acc.email.split('@')[0]}: ${check.reason}`);
        }
        return check.allowed;
    });

    if (availableAccounts.length === 0) {
        console.log('[Sniper] ⛔ No accounts available for comments today');
        return;
    }

    // Process tasks, round-robin across available accounts
    let accountIdx = 0;
    let processed = 0;
    const MAX_PER_CYCLE = 5; // Max comments per cycle to be safe

    while (processed < MAX_PER_CYCLE) {
        const task = squadDB.claimNextTask('comment');
        if (!task) break;

        const account = availableAccounts[accountIdx % availableAccounts.length];
        const accTag = `[Sniper:${account.email.split('@')[0]}]`;

        // Re-check rate limit (may have exhausted during this loop)
        const check = canAct(squadDB, account.email, 'comment');
        if (!check.allowed) {
            console.log(`${accTag} ⏭️ ${check.reason} → skip task #${task.id}`);
            squadDB.skipTask(task.id, check.reason);
            accountIdx++;
            continue;
        }

        const { context, tag } = await createSquadContext(browser, account);
        try {
            const valid = await validateSquadSession(context, tag);
            if (!valid) {
                console.log(`${accTag} ❌ Session invalid → skip`);
                squadDB.skipTask(task.id, 'Session invalid');
                continue;
            }

            const page = await context.newPage();
            console.log(`${accTag} 🎯 Targeting: ${task.target_url.substring(0, 70)}`);

            // Determine template based on keyword
            let templateName = 'default';
            if (task.keyword_matched) {
                const kw = task.keyword_matched.toLowerCase();
                if (kw.includes('fulfill') || kw.includes('kho')) templateName = 'fulfill';
                else if (kw.includes('ship') || kw.includes('chuyển')) templateName = 'ship';
            }

            const success = await sniperComment(page, task.target_url, {
                templateName,
                account: account.email,
            });

            if (success) {
                squadDB.completeTask(task.id, true, 'Comment posted');
                console.log(`${accTag} ✅ Target down! Task #${task.id} done`);
                processed++;
            } else {
                squadDB.completeTask(task.id, false, 'Comment failed');
                console.log(`${accTag} ⚠️ Miss. Task #${task.id} failed`);
            }

            await page.close();
        } catch (e) {
            console.error(`${accTag} ❌ Sniper error: ${e.message}`);
            squadDB.completeTask(task.id, false, e.message.substring(0, 100));
        } finally {
            await context.close();
        }

        accountIdx++;

        // Cooldown between comments (30-60s)
        if (processed < MAX_PER_CYCLE) {
            const coolSec = 30 + Math.random() * 30;
            console.log(`[Sniper] ⏳ Cooling ${Math.round(coolSec)}s before next target...`);
            await delay(coolSec * 1000);
        }
    }

    console.log(`[Sniper] 📊 Cycle result: ${processed} comments posted`);
}

// ═══════════════════════════════════════════════════════
// PHASE 5: COOL-DOWN (Persona wind-down)
// ═══════════════════════════════════════════════════════
async function phaseCoolDown(browser, accounts) {
    console.log('\n' + '═'.repeat(55));
    console.log('  🌙 PHASE 5: COOL-DOWN');
    console.log('═'.repeat(55));

    // Pick 1 random account
    const account = accounts[Math.floor(Math.random() * accounts.length)];
    const { context, tag } = await createSquadContext(browser, account);

    try {
        const valid = await validateSquadSession(context, tag);
        if (!valid) return;

        const page = await context.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(2000);

        console.log(`${tag} 🌙 Winding down... browsing feed, stories`);
        await runPersonaSession(page, tag, 'medium');

        await page.close();
        console.log(`${tag} ✅ Cool-down complete`);
    } catch (e) {
        console.error(`${tag} ❌ Cool-down error: ${e.message}`);
    } finally {
        await context.close();
    }
}

// ═══════════════════════════════════════════════════════
// MAIN: runCycle — Sequential 5-Phase Execution
// ═══════════════════════════════════════════════════════
async function runCycle() {
    const cycleStart = Date.now();
    console.log('\n' + '█'.repeat(55));
    console.log('  🎖️ SQUAD CYCLE — ' + new Date().toLocaleString('vi-VN'));
    console.log('█'.repeat(55));

    // Get all active accounts
    const accounts = accountManager.getAllAccounts().filter(a => a.status !== 'dead');
    if (accounts.length === 0) {
        console.log('[Squad] ⛔ No active accounts available');
        return;
    }
    console.log(`[Squad] 👥 ${accounts.length} active accounts`);

    // Print today's action summary
    const summary = squadDB.getTodaySummary();
    if (summary.length > 0) {
        console.log('[Squad] 📊 Today so far:');
        summary.forEach(s => console.log(`  ${s.account.split('@')[0]}: ${s.count}x ${s.action_type}`));
    }

    let browser = null;
    try {
        // Launch ONE browser for the entire cycle
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        });
        console.log('[Squad] 🌐 Browser launched');

        // ─── Phase 1: Warm-up ───
        await phaseWarmUp(browser, accounts);

        // ─── Phase 2: Broadcast (1x/day) ───
        await phaseBroadcast(browser, accounts);

        // ─── Phase 3: Scrape ───
        // IMPORTANT: This closes its OWN browser. Wait for it to fully finish.
        await phaseScrape();

        // ─── Phase 4: Snipe ───
        await phaseSnipe(browser, accounts);

        // ─── Phase 5: Cool-down ───
        await phaseCoolDown(browser, accounts);

    } catch (e) {
        console.error(`[Squad] ❌ Cycle failed: ${e.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch { }
        }
    }

    const elapsed = ((Date.now() - cycleStart) / 60000).toFixed(1);
    console.log('\n' + '█'.repeat(55));
    console.log(`  ✅ SQUAD CYCLE COMPLETE — ${elapsed} minutes`);
    console.log('█'.repeat(55) + '\n');
}

module.exports = { runCycle };
