const cron = require('node-cron');
const config = require('./config');
const { runFullScan } = require('./scraper');
const { classifyPosts } = require('./classifier');
const { generateResponses } = require('./responder');
const { sendMessage, notifyAlert } = require('./notifier');
const database = require('./database');
const { startServer } = require('./server');
const { cleanOldData, saveLeadsToFile } = require('./dataManager');

// ═══ Daily Digest Accumulator ═══
// Leads are buffered here. Digest is sent when: ≥15 leads OR new day starts.
let pendingLeads = [];
let lastDigestDate = new Date().toISOString().slice(0, 10);

/**
 * Send a Telegram digest with all accumulated leads
 */
async function sendTelegramDigest(leads, stats) {
    if (leads.length === 0) return;

    // Group by platform
    const byPlatform = {};
    leads.forEach(l => {
        byPlatform[l.platform] = (byPlatform[l.platform] || 0) + 1;
    });
    const platformEmojis = { facebook: '📘', instagram: '📷', reddit: '🟠', twitter: '🐦', tiktok: '🎵' };
    const platformLines = Object.entries(byPlatform)
        .map(([p, count]) => `  ${platformEmojis[p] || '🌐'} ${p}: ${count} lead`)
        .join('\n');

    // Sort by score desc, take top 5
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
    if (sent) {
        console.log(`[Notifier] ✅ Daily digest sent: ${leads.length} leads`);
    }
    return sent;
}

function escapeHtmlSimple(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Main pipeline: scrape → classify → generate responses → save → notify
 */
async function runPipeline(options = {}) {
    const startTime = Date.now();

    // 🧹 Auto-cleanup old data files (>7 days)
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

        // Flatten all posts from all platforms
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

        // Step 1.5: Dedup — Remove posts already in database BEFORE wasting AI credits
        console.log('\n[Pipeline] 🔍 Step 1.5: Deduplicating against existing database...');
        const existingUrls = database.getExistingPostUrls();
        const existingHashes = database.getExistingContentHashes();

        const newPosts = allPosts.filter(post => {
            // Check by URL first (most reliable)
            if (post.post_url && existingUrls.has(post.post_url)) return false;
            // Fallback: check by content fingerprint (first 100 chars)
            const contentHash = (post.content || '').substring(0, 100);
            if (contentHash && existingHashes.has(contentHash)) return false;
            return true;
        });

        const dupeCount = allPosts.length - newPosts.length;
        console.log(`[Pipeline] 🔍 Dedup: ${dupeCount} duplicates removed, ${newPosts.length} NEW posts → AI`);

        if (newPosts.length === 0) {
            console.log('[Pipeline] ℹ️ All posts already in database, skipping classification');
            database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }

        // Step 2: Classify with AI
        console.log('\n[Pipeline] 🧠 Step 2: Classifying posts with AI...');
        const classified = await classifyPosts(newPosts);

        // Apply Time-Decay Score Penalty
        const nowMs = Date.now();
        classified.forEach(post => {
            if (post.score > 0 && post.post_created_at) {
                const postTimeMs = new Date(post.post_created_at).getTime();
                const ageDays = (nowMs - postTimeMs) / (1000 * 60 * 60 * 24);

                let penaltyMultiplier = 1;
                if (ageDays > 30) penaltyMultiplier = 0.2; // -80% if older than 1 month
                else if (ageDays > 7) penaltyMultiplier = 0.5;  // -50% if older than 1 week
                else if (ageDays > 3) penaltyMultiplier = 0.8;  // -20% if older than 3 days

                if (penaltyMultiplier < 1) {
                    const originalScore = post.score;
                    post.score = Math.round(originalScore * penaltyMultiplier);
                    console.log(`[Decay] Post age ${Math.round(ageDays)}d: Score reduced ${originalScore} -> ${post.score}`);
                    post.summary = `[CŨ: Đăng ${Math.round(ageDays)} ngày trước] ` + post.summary;
                }
            }
        });

        // Filter: only BUYERS with good scores (exclude providers/competitors)
        const buyers = classified.filter(p => p.role === 'buyer');
        const providers = classified.filter(p => p.role === 'provider');
        const qualifiedLeads = buyers.filter(p => p.isLead && p.score >= config.LEAD_SCORE_THRESHOLD);

        console.log(`[Pipeline] 📊 Buyers: ${buyers.length} | Providers (skipped): ${providers.length} | Irrelevant: ${classified.length - buyers.length - providers.length}`);
        console.log(`[Pipeline] 🎯 Qualified leads (buyers with score ≥ ${config.LEAD_SCORE_THRESHOLD}): ${qualifiedLeads.length}`);

        if (qualifiedLeads.length === 0) {
            console.log('[Pipeline] ℹ️ No qualified leads found this scan');
            database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }

        // Step 3: Generate AI responses
        console.log('\n[Pipeline] 💬 Step 3: Generating AI responses...');
        const withResponses = await generateResponses(qualifiedLeads);

        // Step 4: Save to database
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
                });
                totalLeads++;
                if (stats.platforms[lead.platform]) stats.platforms[lead.platform].leads++;
            } catch (err) {
                if (!err.message.includes('UNIQUE constraint')) {
                    console.error(`[Pipeline] ✗ Error saving lead:`, err.message);
                }
            }
        }

        // Step 5: Export to daily JSON file
        console.log('\n[Pipeline] 💾 Step 5: Exporting to daily file...');
        saveLeadsToFile(withResponses);

        // Step 6: Accumulate leads for daily Telegram digest (NOT every scan)
        stats.totalLeads = totalLeads;
        stats.duration = Math.round((Date.now() - startTime) / 1000);

        // Add qualified leads to pending digest
        const qualifiedForTelegram = withResponses.filter(l => l.score >= config.LEAD_SCORE_THRESHOLD);
        pendingLeads.push(...qualifiedForTelegram);

        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const shouldSendDigest = pendingLeads.length >= 15 || (lastDigestDate !== today && pendingLeads.length > 0);

        if (shouldSendDigest) {
            console.log(`\n[Pipeline] 📲 Step 6: Sending Telegram DIGEST (${pendingLeads.length} leads accumulated)...`);
            await sendTelegramDigest(pendingLeads, stats);
            pendingLeads.length = 0; // Clear after sending
            lastDigestDate = today;
        } else {
            console.log(`[Pipeline] 📲 Digest pending: ${pendingLeads.length}/15 leads accumulated (send khi đủ 15 hoặc cuối ngày)`);
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
 * Main entry point
 */
async function main() {
    const args = process.argv.slice(2);

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  🔍 THG Lead Detection Tool v2.0                    ║');
    console.log('║  FB • IG • Reddit • Twitter/X • TikTok              ║');
    console.log('║  Powered by Apify + OpenAI + Telegram               ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    // Parse platform flags
    const platformFlags = args.filter(a => a.startsWith('--platform='));
    const platformOptions = platformFlags.length
        ? { platforms: platformFlags.map(f => f.split('=')[1]) }
        : {};

    if (args.includes('--scan-once')) {
        console.log('[Main] Running single scan...');
        await runPipeline(platformOptions);
        console.log('[Main] Done.');
        process.exit(0);
    }

    // Start dashboard server
    startServer();

    // Schedule periodic scans
    console.log(`[Main] ⏰ Scheduling scans: ${config.CRON_SCHEDULE}`);
    const scanJob = cron.schedule(config.CRON_SCHEDULE, async () => {
        console.log('[Cron] Triggered scheduled scan...');
        await runPipeline();
    });

    global.getNextScanTime = () => {
        if (!scanJob) return null;
        // Depending on node-cron version, there might be ways to get next date, or we compute it.
        // Quickest way for node-cron is using the cron date parser, but since it's "every 30 mins":
        return null; // Will calculate in server.js instead to avoid node-cron internals
    };

    console.log(`[Main] 🟢 System ready! Platforms: ${config.ENABLED_PLATFORMS.join(', ')}`);
    console.log(`[Main] Dashboard: http://localhost:${config.PORT}`);
    console.log('[Main] Use --scan-once to run immediately');
    console.log('[Main] Use --platform=reddit to scan single platform');
}

main().catch(err => {
    console.error('[Main] Fatal error:', err);
    process.exit(1);
});

module.exports = { runPipeline };
