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

// Hub-Worker mode: poll VPS for jobs instead of local DB
const HUB_URL = process.env.HUB_URL || '';
const WORKER_AUTH_KEY = process.env.WORKER_AUTH_KEY || 'thg_worker_2026';
let axios;
try { axios = require('axios'); } catch { axios = null; }

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

        // Step 1.5: Filter old posts (within last 2 days only — fresh leads)
        console.log('\n[Pipeline] 🔍 Step 1.5: Filtering old posts (last 2 days only)...');
        const MAX_AGE_DAYS = 2; // Only keep posts from today or yesterday
        const cutoffMs = Date.now() - (MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
        const freshPosts = allPosts.filter(post => {
            const timeStr = (post.item_type === 'comment')
                ? (post.parent_created_at || post.post_created_at)
                : post.post_created_at;
            if (!timeStr) return true; // No date → assume fresh (scraper just grabbed it)
            const postDate = new Date(timeStr);
            if (isNaN(postDate.getTime())) return true;
            return postDate.getTime() >= cutoffMs;
        });
        const oldDropped = allPosts.length - freshPosts.length;
        if (oldDropped > 0) {
            console.log(`[Pipeline] 🕐 Dropped ${oldDropped} posts older than ${MAX_AGE_DAYS} days (keeping only fresh leads)`);
        }

        if (freshPosts.length === 0) {
            console.log('[Pipeline] ℹ️ No posts from current month, skipping classification');
            database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }
        // Step 1.7: Keyword pre-filter — only keep posts about THG's services
        console.log('\n[Pipeline] 🔑 Step 1.7: Keyword pre-filter (POD/dropship/fulfillment/logistics)...');
        const THG_KEYWORDS = [
            // === POD / Print on Demand ===
            'pod', 'print on demand', 'print-on-demand', 'printondemand',
            'xưởng in', 'in áo', 'in ấn', 'in sản phẩm', 'mockup', 'dtg', 'dtf',
            'all over print', 'alloverprint', 'sublimation',
            // === Dropship ===
            'dropship', 'drop ship', 'dropshipping', 'drop shipping',
            // === Fulfillment / Warehouse / 3PL ===
            'fulfillment', 'fulfilment', 'fulfill', 'fulfil',
            '3pl', 'third party logistics', 'kho hàng', 'lưu kho', 'kho mỹ', 'kho us',
            'kho pa', 'kho tx', 'kho ca', 'warehouse', 'warehousing',
            'prep center', 'prep service', 'fba prep', 'fbm',
            'cross dock', 'cross-dock', 'pick and pack', 'pick & pack',
            // === Amazon FBA ===
            'fba', 'amazon fba', 'ship to amazon', 'gửi amazon', 'send to fba',
            'amazon warehouse', 'amazon seller', 'amazon us',
            // === Shipping / Logistics / Vận chuyển ===
            'ship đi mỹ', 'ship sang mỹ', 'gửi hàng mỹ', 'gửi đi mỹ',
            'ship us', 'ship to us', 'ship to usa', 'shipping to us',
            'vận chuyển', 'van chuyen', 'logistics', 'freight', 'cargo',
            'đường biển', 'đường hàng không', 'air freight', 'sea freight',
            'lcl', 'fcl', 'ddp', 'ddu', 'epacket',
            'thông quan', 'customs', 'customs clearance', 'hải quan',
            'xuất khẩu', 'xuat khau', 'export',
            // === Shipping to UK/EU ===
            'ship uk', 'ship to uk', 'gửi anh', 'gửi đức', 'ship germany', 'ship france',
            'amazon.de', 'amazon.co.uk', 'amazon.fr', 'amazon eu',
            'fulfillment uk', 'fulfillment eu', 'kho châu âu',
            // === Sourcing from China ===
            'order từ trung', 'hàng trung quốc', 'hàng tq', 'nguồn hàng tq',
            'mua hàng trung', 'đặt hàng trung', 'nhà cung cấp trung',
            '1688', 'taobao', 'alibaba', 'yiwu', 'canton fair',
            'sourcing', 'supplier', 'nguồn hàng',
            // === Need/Search signals ===
            'cần tìm', 'tìm bên', 'ai biết', 'giới thiệu', 'cho hỏi',
            'giúp mình', 'mình đang', 'mình cần', 'cần đi hàng',
            'tìm đối tác', 'xin giá', 'báo giá', 'quote',
        ];

        const keywordRegex = new RegExp(THG_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

        // Job/hiring keywords to EXCLUDE even if THG keywords match
        const JOB_EXCLUSION_KEYWORDS = [
            'tìm việc', 'tuyển dụng', 'hiring', 'job opening', 'remote job',
            'tuyển nhân viên', 'cần tuyển', 'tìm nhân sự', 'ứng tuyển',
            'cv', 'resume', 'salary', 'lương', 'mức lương',
            'cần thêm việc', 'xin việc', 'freelance', 'part.?time', 'full.?time',
            'roas\\s*\\d', 'ads\\s*fb', 'chạy ads', 'facebook ads', 'quảng cáo fb',
            'google ads', 'tiktok ads', 'media buyer', 'performance marketing',
        ];
        const jobExcludeRegex = new RegExp(JOB_EXCLUSION_KEYWORDS.join('|'), 'i');

        // --- (A) VAT / Tax / Compliance exclusion ---
        const VAT_TAX_KEYWORDS = [
            'thuế nhập khẩu', 'thuế xuất khẩu', 'thuế vat', 'vat refund',
            'khai báo hải quan', 'hồ sơ hải quan', 'thủ tục hải quan',
            'ioss', 'eori', 'tariff', 'biểu thuế', 'mã hs',
            'luật nhập khẩu', 'luật xuất khẩu', 'quy định nhập khẩu',
            'compliance', 'regulation', 'certificate of origin', 'c/o',
            'fda approval', 'cpsc', 'thuế chống bán phá giá', 'anti.?dumping',
            'customs duty', 'duty rate', 'import duty', 'thuế quan',
            'khai thuế', 'hoàn thuế', 'tax refund', 'tax compliance',
        ];
        const vatExcludeRegex = new RegExp(VAT_TAX_KEYWORDS.join('|'), 'i');

        // --- (B) Provider / Advertiser exclusion (subtle wording) ---
        const PROVIDER_AD_KEYWORDS = [
            'giải pháp gửi hàng', 'giải pháp ship', 'giải pháp vận chuyển',
            'giải pháp logistics', 'giải pháp fulfillment',
            'ưu đãi .{0,15}(ship|gửi|vận)', 'khuyến mãi', 'chiết khấu',
            'liên hệ ngay', 'đăng ký ngay', 'tham khảo ngay',
            'hãy liên hệ', 'gọi ngay', 'inbox ngay', 'ib ngay',
            'nhận ship .*hàng', 'nhận gửi .*hàng', 'nhận vận chuyển',
            'chuyên nhận', 'chúng tôi chuyên', 'bên em chuyên', 'bên mình chuyên',
            'bên em nhận', 'bên mình nhận', 'đơn vị vận chuyển',
            'xin phép admin', 'xin phép ad',
            'cam kết giao', 'cam kết.*nhanh', 'cam kết.*uy tín',
            'cước phí cạnh tranh', 'giá cạnh tranh', 'giá tốt nhất',
            'chỉ từ \\d+k', 'chỉ từ \\d+đ', 'chỉ từ \\$',
            'nhận từ 1 đơn', 'không giới hạn', 'free packing',
            'zalo:\\s*0', 'hotline:', 'sđt:', 'liên hệ sđt',
            'dạ em nhận', 'em chuyên nhận',
            'seller nên biết.*:', 'seller cần biết.*:',
            'ready to scale', 'just launched', 'our warehouse', 'free quote',
            'get started today', 'contact us', 'whatsapp.*\\+',
        ];
        const providerAdRegex = new RegExp(PROVIDER_AD_KEYWORDS.join('|'), 'i');

        // --- (C) Knowledge-sharing / Info post exclusion ---
        const KNOWLEDGE_SHARE_KEYWORDS = [
            'chia sẻ kinh nghiệm', 'chia sẻ kiến thức', 'chia sẻ cho.*anh.chị',
            'bài viết tổng hợp', 'tổng hợp.*kinh nghiệm',
            'hướng dẫn.*chi tiết', 'hướng dẫn.*cách',
            'tip.*seller', 'tips.*cho', 'mẹo.*bán hàng',
            'tutorial', 'step.by.step', 'how to.*guide',
            'kinh nghiệm.*năm', 'tổng kết.*năm',
            'review .*dịch vụ', 'so sánh.*dịch vụ', 'top \\d+.*dịch vụ',
            'danh sách.*đơn vị', 'list.*đơn vị',
        ];
        const knowledgeShareRegex = new RegExp(KNOWLEDGE_SHARE_KEYWORDS.join('|'), 'i');

        // --- (D) Wrong shipping route exclusion ---
        // THG only: VN→World, CN→World (especially US)
        // Exclude posts asking to ship FROM other countries
        const WRONG_ROUTE_KEYWORDS = [
            'từ nhật', 'from japan', 'gửi.{0,10}từ nhật', 'ship.{0,10}từ nhật',
            'từ hàn', 'from korea', 'gửi.{0,10}từ hàn', 'ship.{0,10}từ hàn',
            'từ thái', 'from thailand', 'gửi.{0,10}từ thái', 'ship.{0,10}từ thái',
            'từ đài loan', 'from taiwan', 'gửi.{0,10}từ đài',
            'từ úc', 'from australia', 'gửi.{0,10}từ úc',
            'từ đức', 'from germany', 'gửi.{0,10}từ đức',
            'từ anh', 'from uk', 'gửi.{0,10}từ anh',
            'từ pháp', 'from france', 'gửi.{0,10}từ pháp',
            'từ canada', 'from canada', 'gửi.{0,10}từ canada',
            'từ singapore', 'from singapore',
            'từ malaysia', 'from malaysia',
            'từ ấn độ', 'from india',
            'nhật.{0,5}(qua|sang|về).{0,5}(mỹ|úc|việt|canada)',
            'hàn.{0,5}(qua|sang|về).{0,5}(mỹ|úc|việt|canada)',
            'thái.{0,5}(qua|sang|về).{0,5}(mỹ|úc|việt|canada)',
        ];
        const wrongRouteRegex = new RegExp(WRONG_ROUTE_KEYWORDS.join('|'), 'i');

        const relevantPosts = freshPosts.filter(post => {
            const text = (post.content || '').toLowerCase();
            const group = (post.group_name || post.source_group || '').toLowerCase();
            // Must match THG keywords
            if (!keywordRegex.test(text) && !keywordRegex.test(group)) return false;
            // Must NOT match any exclusion filters
            if (jobExcludeRegex.test(text)) return false;
            if (vatExcludeRegex.test(text)) return false;
            if (providerAdRegex.test(text)) return false;
            if (knowledgeShareRegex.test(text)) return false;
            if (wrongRouteRegex.test(text)) return false;
            return true;
        });

        const kwDropped = freshPosts.length - relevantPosts.length;
        console.log(`[Pipeline] 🔑 Kept ${relevantPosts.length} relevant posts, dropped ${kwDropped} off-topic`);

        if (relevantPosts.length === 0) {
            console.log('[Pipeline] ℹ️ No keyword-matched posts, skipping classification');
            database.updateScanLog.run({ id: scanId, posts_found: allPosts.length, leads_detected: 0, status: 'completed', error: null });
            return stats;
        }

        // Step 2: Classify with AI
        console.log('\n[Pipeline] 🧠 Step 2: Classifying posts with AI...');
        const classified = await classifyPosts(relevantPosts);

        // Apply Time-Decay Score Penalty
        const nowMs = Date.now();
        classified.forEach(post => {
            if (post.score > 0) {
                // Default 0 = assume fresh (we scrape CHRONOLOGICAL feed, posts are recent)
                let ageDays = 0;
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
                    const dateInfo = post.post_created_at ? `${Math.round(ageDays)}d` : 'no date (assume fresh)';
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

        // Step 5: Export to daily JSON file (only quality content)
        console.log('\n[Pipeline] 💾 Step 5: Exporting to daily file...');
        const qualityLeads = withResponses.filter(lead => {
            const c = (lead.content || '').trim();
            // Remove FB navigation noise
            const cleaned = c.replace(/\b(Facebook|Like|Comment|Share|See translation|All reactions|View more.*|Follow|\d+ comments?|\d+ shares?)\b/gi, '').trim();
            if (cleaned.length < 50) return false;
            // Reject if 50%+ of lines are just "Facebook"  
            const lines = c.split('\n').filter(l => l.trim());
            const fbLines = lines.filter(l => /^\s*Facebook\s*$/i.test(l));
            if (lines.length > 3 && fbLines.length / lines.length > 0.5) return false;
            return true;
        });
        if (qualityLeads.length < withResponses.length) {
            console.log(`[Pipeline] 🧹 Filtered: ${withResponses.length} → ${qualityLeads.length} leads (removed ${withResponses.length - qualityLeads.length} garbage)`);
        }
        saveLeadsToFile(qualityLeads);

        // Step 5.5: Auto-push leads to production VPS
        try {
            const { pushLeadsToProd } = require('../pipelines/pushLeads');
            const leadsForPush = qualityLeads.map(lead => ({
                source_url: lead.post_url,
                post_url: lead.post_url,
                author_name: lead.author_name,
                author_url: lead.author_url,
                content: lead.content,
                platform: lead.platform,
                group_name: lead.group_name || '',
                created_at: lead.post_created_at || lead.scraped_at,
            }));
            if (leadsForPush.length > 0) {
                console.log(`\n[Pipeline] 🚀 Step 5.5: Pushing ${leadsForPush.length} quality leads to production...`);
                await pushLeadsToProd(leadsForPush);
            } else {
                console.log(`\n[Pipeline] ⚠️ Step 5.5: No quality leads to push`);
            }
        } catch (pushErr) {
            console.warn(`[Pipeline] ⚠️ Push to prod failed (not critical): ${pushErr.message}`);
        }

        // Step 5.6: Push high quality leads to Sniper Squad Agent Queue
        try {
            const sDB = require('../squad/core/squadDB');
            const sniperLeads = qualityLeads.filter(l => l.score >= 80);
            for (const lead of sniperLeads) {
                sDB.pushTask('comment', lead.post_url, {
                    leadId: 0,
                    keyword: 'AI Classified',
                });
            }
            if (sniperLeads.length > 0) {
                console.log(`\n[Pipeline] 🎯 Step 5.6: Pushed ${sniperLeads.length} leads to Sniper Agent Queue`);
            }
        } catch (e) {
            console.warn(`[Pipeline] ⚠️ Failed to push to Sniper Queue: ${e.message}`);
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
 * Poll scan_queue for pending jobs (local or remote via HUB_URL)
 */
async function pollQueue() {
    if (isProcessing) return;

    let job = null;
    let isRemote = false;

    if (HUB_URL && axios) {
        // ═══ REMOTE MODE: Poll VPS Hub for jobs ═══
        try {
            const resp = await axios.get(`${HUB_URL}/api/worker/jobs`, {
                headers: { 'x-thg-auth-key': WORKER_AUTH_KEY },
                timeout: 10000,
            });
            job = resp.data?.job || null;
            if (job) isRemote = true;
        } catch (err) {
            // Silent fail — Hub might be temporarily unreachable
            if (!err.message?.includes('ECONNREFUSED')) {
                console.warn(`[Worker] ⚠️ Hub poll error: ${err.message}`);
            }
        }
    }

    // ═══ LOCAL MODE FALLBACK: Poll local SQLite scan_queue if no remote job ═══
    if (!job) {
        job = database.claimNextScan();
        isRemote = false;
    }

    if (!job) return;

    isProcessing = true;
    console.log(`\n[ScraperWorker] 🔒 Claimed job #${job.id} (${job.job_type}) ${isRemote ? '← from VPS Hub' : ''}`);

    try {
        const options = {
            platforms: job.platforms ? job.platforms.split(',') : config.ENABLED_PLATFORMS,
            maxPosts: job.max_posts || config.MAX_POSTS_PER_SCAN || 200,
            ...job.options,
        };

        const result = await runPipeline(options);

        if (isRemote) {
            // Report completion + send leads back to VPS Hub
            await reportToHub(job.id, 'done', result);
        } else {
            database.completeScan(job.id, result);
        }
        console.log(`[ScraperWorker] ✅ Job #${job.id} completed`);
    } catch (err) {
        console.error(`[ScraperWorker] ❌ Job #${job.id} failed:`, err.message);
        if (isRemote) {
            await reportToHub(job.id, 'error', null, err.message);
        } else {
            database.failScan(job.id, err.message);
        }
    } finally {
        isProcessing = false;
    }
}

/**
 * Report job results back to VPS Hub
 */
async function reportToHub(jobId, status, result, error) {
    if (!HUB_URL || !axios) return;
    try {
        // Collect all leads saved during this pipeline run
        let posts = [];
        try {
            // Get leads from the last scan — widened to 2h because scans can take 60+ minutes
            const rows = database.db.prepare(
                `SELECT * FROM leads WHERE scraped_at > datetime('now', '-2 hours') ORDER BY id DESC LIMIT 200`
            ).all();
            posts = rows;
        } catch { }

        await axios.post(`${HUB_URL}/api/worker/jobs/${jobId}/complete`, {
            status,
            result: result || {},
            error: error || null,
            posts,
        }, {
            headers: { 'x-thg-auth-key': WORKER_AUTH_KEY },
            timeout: 30000,
        });
        console.log(`[Worker] 📡 Reported job #${jobId} to Hub (${posts.length} leads sent)`);
    } catch (err) {
        console.warn(`[Worker] ⚠️ Hub report failed: ${err.message}. Leads saved locally.`);
    }
}

// ═══ Main ═══
async function main() {
    const isRemoteWorker = !!(HUB_URL && axios);

    console.log('╔══════════════════════════════════════════════════════╗');
    if (isRemoteWorker) {
        console.log('║  🏠 THG Scraper Worker — LAPTOP MODE (Remote)       ║');
        console.log(`║  Polls Hub: ${HUB_URL.substring(0, 40).padEnd(40)} ║`);
    } else {
        console.log('║  🔧 THG Scraper Worker — Standalone Process         ║');
        console.log('║  Polls scan_queue → Playwright scrape → Classify    ║');
    }
    console.log('╚══════════════════════════════════════════════════════╝');

    // Initialize self-hosted scraper
    const scrapeMode = config.SCRAPE_MODE || 'sociavault';
    console.log(`[ScraperWorker] 🔧 Scrape Mode: ${scrapeMode.toUpperCase()}`);
    if (scrapeMode === 'self-hosted') {
        try {
            try {
                const db = require('../data_store/database');
                db.db.prepare("UPDATE fb_accounts SET proxy_url = NULL WHERE proxy_url IS NOT NULL").run();
                console.log('[ScraperWorker] ⚡ Cleared proxy_url — using direct connect');
            } catch (e) { }

            const fbScraper = require('../scraper');
            await fbScraper.loadFreeProxies();
            console.log('[ScraperWorker] ✅ Self-hosted scraper ready');
        } catch (err) {
            console.warn(`[ScraperWorker] ⚠️ Proxy init failed: ${err.message}`);
        }
    }

    // Start polling
    const pollTarget = isRemoteWorker ? `VPS Hub (${HUB_URL})` : 'local scan_queue';
    console.log(`[ScraperWorker] 🔄 Polling ${pollTarget} every ${POLL_INTERVAL / 1000}s...`);
    setInterval(pollQueue, POLL_INTERVAL);

    // Initial poll
    await pollQueue();
}

main().catch(err => {
    console.error('[ScraperWorker] Fatal error:', err);
    process.exit(1);
});
