/**
 * THG Lead Gen — Scraper Worker (Standalone Process)
 * 
 * This process runs INDEPENDENTLY from the API server.
 * It polls the scan_queue table and runs the full pipeline:
 *   1. Poll scan_queue for PENDING jobs
 *   2. Claim job atomically
 *   3. Run Playwright scraper → classify → generate responses → save to DB
 *   4. Mark job DONE/ERROR
 *   5. Send Telegram digest
 * 
 * Usage:
 *   node src/workers/scraperWorker.js
 *   PM2: thg-scraper (see ecosystem.config.js)
 */
// ═══ Global Unhandled Rejection Handler ═══
// Playwright-extra stealth plugin fires async onPageCreated events
// that can throw AFTER the browser/context is closed (race condition).
// Without this handler, the process crashes with:
//   cdpSession.send: Target page, context or browser has been closed
process.on('unhandledRejection', (reason) => {
    const msg = String(reason?.message || reason || '');
    // Known benign errors from stealth plugin — suppress
    if (msg.includes('Target page, context or browser has been closed') ||
        msg.includes('cdpSession.send') ||
        msg.includes('page.addInitScript')) {
        console.warn(`[ScraperWorker] ⚠️ Suppressed stealth-plugin error: ${msg.substring(0, 120)}`);
        return;
    }
    console.error('[ScraperWorker] ❌ Unhandled rejection:', reason);
});

const config = require('../config');
const database = require('../data_store/database');
const { runFullScan } = require('../pipelines/scraperEngine');
const { classifyPosts } = require('../prompts/leadQualifier');
const { generateResponses } = require('../prompts/salesCopilot');
const { sendMessage } = require('../integrations/telegramBot');
const { cleanOldData, saveLeadsToFile } = require('../data_store/fileManager');

const POLL_INTERVAL = 5000; // 5 seconds
let isProcessing = false;

// ═══ Daily Digest Accumulator ═══
let pendingLeads = [];
let lastDigestDate = new Date().toISOString().slice(0, 10);

function escapeHtmlSimple(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegramDigest(leads, stats) {
    if (leads.length === 0) return;

    const byPlatform = {};
    leads.forEach(l => {
        byPlatform[l.platform] = (byPlatform[l.platform] || 0) + 1;
    });
    const platformEmojis = { facebook: '📘', instagram: '📷', tiktok: '🎵' };
    const platformLines = Object.entries(byPlatform)
        .map(([p, count]) => `  ${platformEmojis[p] || '🌐'} ${p}: ${count} lead`)
        .join('\n');

    const topLeads = [...leads].sort((a, b) => b.score - a.score).slice(0, 5);
    const topLeadLines = topLeads.map((l, i) => {
        const emoji = platformEmojis[l.platform] || '🌐';
        const author = (l.author_name || 'Unknown').substring(0, 25);
        const summary = (l.summary || '').substring(0, 80);
        const url = l.post_url ? `\n      🔗 <a href="${l.post_url}">Xem bài viết</a>` : '';
        return `  <b>${i + 1}.</b> ${emoji} [${l.score}đ] ${escapeHtmlSimple(author)}\n      💡 ${escapeHtmlSimple(summary)}${url}`;
    }).join('\n\n');

    const time = new Date().toLocaleString('vi-VN');
    const message = `
📊 <b>BÁO CÁO LEAD HÀNG NGÀY</b>
🕐 ${time}

🏆 <b>Tổng lead mới:</b> ${leads.length}

📱 <b>Theo nền tảng:</b>
${platformLines}

⭐ <b>Top ${topLeads.length} lead tiềm năng nhất:</b>

${topLeadLines}

${leads.length > 5 ? `\n📋 Còn ${leads.length - 5} lead khác → Xem chi tiết trên Dashboard` : ''}
  `.trim();

    const sent = await sendMessage(message);
    if (sent) console.log(`[ScraperWorker] ✅ Daily digest sent: ${leads.length} leads`);
    return sent;
}

/**
 * Main pipeline: scrape → classify → generate responses → save → notify
 * (Moved from index.js — now runs in this separate process)
 */
async function runPipeline(options = {}) {
    const startTime = Date.now();
    cleanOldData();

    console.log('\n' + '='.repeat(60));
    console.log(`[Pipeline] 🚀 Starting scan at ${new Date().toLocaleString()}`);
    console.log(`[Pipeline] 📡 Platforms: ${(options.platforms || config.ENABLED_PLATFORMS).join(', ')}`);
    console.log('='.repeat(60));

    const scanLog = database.insertScanLog.run({
        platform: 'all',
        keywords_used: JSON.stringify(config.ENABLED_PLATFORMS),
        posts_found: 0,
        leads_detected: 0,
        status: 'running',
    });
    const scanId = scanLog.lastInsertRowid;

    let totalLeads = 0;
    const stats = { totalLeads: 0, duration: 0, platforms: {} };

    try {
        // Step 1: Scrape all enabled platforms
        console.log('\n[Pipeline] 📡 Step 1: Scraping social media...');
        const scraped = await runFullScan(options);

        const allPosts = [];
        for (const [platform, posts] of Object.entries(scraped)) {
            stats.platforms[platform] = { posts: posts.length, leads: 0 };
            allPosts.push(...posts);
        }
        console.log(`[Pipeline] 📊 Total posts scraped: ${allPosts.length}`);

        if (allPosts.length === 0) {
            console.log('[Pipeline] ⚠️ No posts found, skipping classification');
            database.updateScanLog.run({ id: scanId, posts_found: 0, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }

        // Step 1.5: Filter old posts (>30 days)
        console.log('\n[Pipeline] 🔍 Step 1.5: Filtering old posts...');
        const MAX_POST_AGE_DAYS = 30;
        const nowMs = Date.now();
        const freshPosts = allPosts.filter(post => {
            const timeStr = (post.item_type === 'comment')
                ? (post.parent_created_at || post.post_created_at)
                : post.post_created_at;
            if (!timeStr) return true;
            const postTimeMs = new Date(timeStr).getTime();
            if (isNaN(postTimeMs)) return true;
            const ageDays = (nowMs - postTimeMs) / (1000 * 60 * 60 * 24);
            return ageDays <= MAX_POST_AGE_DAYS;
        });
        const oldDropped = allPosts.length - freshPosts.length;
        if (oldDropped > 0) {
            console.log(`[Pipeline] 🕐 Dropped ${oldDropped} posts older than ${MAX_POST_AGE_DAYS} days`);
        }

        if (freshPosts.length === 0) {
            console.log('[Pipeline] ℹ️ All posts too old, skipping classification');
            database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }

        // Step 2: Classify with AI
        console.log('\n[Pipeline] 🧠 Step 2: Classifying posts with AI...');
        const classified = await classifyPosts(freshPosts);

        // Apply Time-Decay Score Penalty
        classified.forEach(post => {
            if (post.score > 0) {
                let ageDays = 60;
                if (post.post_created_at) {
                    const postTimeMs = new Date(post.post_created_at).getTime();
                    if (!isNaN(postTimeMs)) ageDays = (nowMs - postTimeMs) / (1000 * 60 * 60 * 24);
                }
                let penaltyMultiplier = 1;
                if (ageDays > 90) penaltyMultiplier = 0.3;
                else if (ageDays > 30) penaltyMultiplier = 0.5;
                else if (ageDays > 14) penaltyMultiplier = 0.7;
                else if (ageDays > 7) penaltyMultiplier = 0.85;
                else if (ageDays > 3) penaltyMultiplier = 0.95;

                if (penaltyMultiplier < 1) {
                    const originalScore = post.score;
                    post.score = Math.round(originalScore * penaltyMultiplier);
                    const dateInfo = post.post_created_at ? `${Math.round(ageDays)}d` : 'no date (assume 60d)';
                    console.log(`[Decay] Post age ${dateInfo}: Score reduced ${originalScore} -> ${post.score}`);
                    post.summary = `[CŨ: ${Math.round(ageDays)} ngày] ` + post.summary;
                }
            }
        });

        // Filter: only BUYERS with good scores
        const buyers = classified.filter(p => p.role === 'buyer');
        const providers = classified.filter(p => p.role === 'provider');
        const irrelevant = classified.filter(p => p.role !== 'buyer' && p.role !== 'provider');
        const qualifiedLeads = buyers.filter(p => p.isLead && p.score >= config.LEAD_SCORE_THRESHOLD);

        console.log(`[Pipeline] 📊 Buyers: ${buyers.length} | Providers (skipped): ${providers.length} | Irrelevant: ${irrelevant.length}`);
        console.log(`[Pipeline] 🎯 Qualified leads (buyers with score ≥ ${config.LEAD_SCORE_THRESHOLD}): ${qualifiedLeads.length}`);

        if (qualifiedLeads.length === 0) {
            console.log('[Pipeline] ℹ️ No qualified leads found this scan');
            database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }

        // Step 3: Generate AI responses
        console.log('\n[Pipeline] 💬 Step 3: Generating AI responses...');
        const withResponses = await generateResponses(qualifiedLeads);

        // Step 4: Save to database (INSERT OR IGNORE handles dedup)
        console.log('\n[Pipeline] 💾 Step 4: Saving to database...');
        for (const lead of withResponses) {
            try {
                database.insertLead.run({
                    platform: lead.platform,
                    post_url: lead.post_url,
                    author_name: lead.author_name,
                    author_url: lead.author_url,
                    author_avatar: lead.author_avatar || '',
                    content: lead.content,
                    score: lead.score,
                    category: lead.category,
                    summary: lead.summary,
                    urgency: lead.urgency,
                    suggested_response: lead.suggested_response || '',
                    role: lead.role || 'buyer',
                    buyer_signals: lead.buyerSignals || '',
                    scraped_at: lead.scraped_at,
                    post_created_at: lead.post_created_at || lead.scraped_at,
                    profit_estimate: lead.profitEstimate || '',
                    gap_opportunity: lead.gapOpportunity || '',
                    pain_score: lead.painScore || 0,
                    spam_score: lead.spamScore || 0,
                    item_type: lead.item_type || 'post',
                });
                totalLeads++;
                if (stats.platforms[lead.platform]) stats.platforms[lead.platform].leads++;
            } catch (err) {
                if (!err.message.includes('UNIQUE constraint')) {
                    console.error(`[Pipeline] ✗ Error saving lead:`, err.message);
                }
            }
        }

        // Invalidate stats cache after inserting leads
        database.invalidateStatsCache();

        // Step 5: Export to daily JSON file
        console.log('\n[Pipeline] 💾 Step 5: Exporting to daily file...');
        saveLeadsToFile(withResponses);

        // Step 5.5: Auto-push leads to production VPS
        try {
            const { pushLeadsToProd } = require('../pipelines/pushLeads');
            const leadsForPush = withResponses.map(lead => ({
                source_url: lead.post_url,
                post_url: lead.post_url,
                author_name: lead.author_name,
                author_url: lead.author_url,
                content: lead.content,
                platform: lead.platform,
                group_name: lead.group_name || '',
                created_at: lead.post_created_at || lead.scraped_at,
            }));
            console.log(`\n[Pipeline] 🚀 Step 5.5: Pushing ${leadsForPush.length} leads to production...`);
            await pushLeadsToProd(leadsForPush);
        } catch (pushErr) {
            console.warn(`[Pipeline] ⚠️ Push to prod failed (not critical): ${pushErr.message}`);
        }

        // Step 6: Accumulate leads for daily Telegram digest
        stats.totalLeads = totalLeads;
        stats.duration = Math.round((Date.now() - startTime) / 1000);

        const qualifiedForTelegram = withResponses.filter(l => l.score >= config.LEAD_SCORE_THRESHOLD);
        pendingLeads.push(...qualifiedForTelegram);

        const today = new Date().toISOString().slice(0, 10);
        const shouldSendDigest = pendingLeads.length >= 3 || (lastDigestDate !== today && pendingLeads.length > 0);

        if (shouldSendDigest) {
            console.log(`\n[Pipeline] 📲 Step 6: Sending Telegram DIGEST (${pendingLeads.length} leads accumulated)...`);
            await sendTelegramDigest(pendingLeads, stats);
            pendingLeads.length = 0;
            lastDigestDate = today;
        } else {
            console.log(`[Pipeline] 📲 Digest pending: ${pendingLeads.length}/3 leads accumulated`);
        }

        database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: totalLeads, status: 'completed', error: null });

        console.log('\n' + '='.repeat(60));
        console.log(`[Pipeline] ✅ Scan complete! ${totalLeads} new leads saved (${stats.duration}s)`);
        for (const [p, s] of Object.entries(stats.platforms)) {
            console.log(`[Pipeline]    ${p}: ${s.posts} posts → ${s.leads} leads`);
        }
        console.log('='.repeat(60));

        return stats;
    } catch (err) {
        console.error('[Pipeline] ❌ Pipeline error:', err);
        database.updateScanLog.run({
            id: scanId,
            posts_found: Object.values(stats.platforms).reduce((s, p) => s + p.posts, 0),
            leads_detected: totalLeads, status: 'error', error: err.message,
        });
        return stats;
    }
}

/**
 * Poll scan_queue for pending jobs
 */
async function pollQueue() {
    if (isProcessing) return;

    const job = database.claimNextScan();
    if (!job) return;

    isProcessing = true;
    console.log(`\n[ScraperWorker] 🔒 Claimed job #${job.id} (${job.job_type})`);

    try {
        const options = {
            platforms: job.platforms ? job.platforms.split(',') : config.ENABLED_PLATFORMS,
            maxPosts: job.max_posts || config.MAX_POSTS_PER_SCAN || 200,
            ...job.options,
        };

        const result = await runPipeline(options);
        database.completeScan(job.id, result);
        console.log(`[ScraperWorker] ✅ Job #${job.id} completed`);
    } catch (err) {
        console.error(`[ScraperWorker] ❌ Job #${job.id} failed:`, err.message);
        database.failScan(job.id, err.message);
    } finally {
        isProcessing = false;
    }
}

// ═══ Main ═══
async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  🔧 THG Scraper Worker — Standalone Process         ║');
    console.log('║  Polls scan_queue → Playwright scrape → Classify    ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    // Initialize self-hosted scraper
    const scrapeMode = config.SCRAPE_MODE || 'sociavault';
    console.log(`[ScraperWorker] 🔧 Scrape Mode: ${scrapeMode.toUpperCase()}`);
    if (scrapeMode === 'self-hosted') {
        try {
            // 1. Load Webshare.io proxies (paid/free tier)
            try {
                const { loadWebshareIntoPool, autoAssignProxiesToAccounts } = require('../proxy/webshareFetcher');
                const count = await loadWebshareIntoPool();
                if (count > 0) {
                    await autoAssignProxiesToAccounts();
                }
            } catch (wsErr) {
                console.warn(`[ScraperWorker] ⚠️ Webshare init: ${wsErr.message}`);
            }

            // 2. Load free proxies as fallback
            const fbScraper = require('../agents/fbScraper');
            await fbScraper.loadFreeProxies();

            // 3. Auto-join groups for new accounts (never scanned before)
            try {
                const db = require('../data_store/database');
                const newAccounts = db.db.prepare(
                    `SELECT * FROM fb_accounts WHERE status='active' AND (last_scan IS NULL OR last_scan = '') LIMIT 3`
                ).all();

                if (newAccounts.length > 0) {
                    console.log(`[ScraperWorker] 🚪 Found ${newAccounts.length} new account(s) — auto-joining groups...`);
                    for (const acc of newAccounts) {
                        console.log(`[ScraperWorker] 🚪 Auto-joining for: ${acc.email}`);
                        try {
                            await fbScraper.autoJoinGroups(null, acc);
                            await fbScraper.closeBrowser();
                        } catch (joinErr) {
                            console.warn(`[ScraperWorker] ⚠️ Auto-join for ${acc.email}: ${joinErr.message}`);
                        }
                    }
                }
            } catch (joinErr) {
                console.warn(`[ScraperWorker] ⚠️ Auto-join init: ${joinErr.message}`);
            }

            console.log('[ScraperWorker] ✅ Self-hosted scraper ready');
        } catch (err) {
            console.warn(`[ScraperWorker] ⚠️ Proxy init failed: ${err.message}`);
        }
    }

    // Start polling
    console.log(`[ScraperWorker] 🔄 Polling scan_queue every ${POLL_INTERVAL / 1000}s...`);
    setInterval(pollQueue, POLL_INTERVAL);

    // Initial poll
    await pollQueue();
}

main().catch(err => {
    console.error('[ScraperWorker] Fatal error:', err);
    process.exit(1);
});
