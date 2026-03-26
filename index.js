#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  FACEBOOK GROUP SCANNER — Entry Point                      ║
 * ║  Tự động quét Facebook Groups → Lọc từ khóa → Gửi Telegram ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * Cách chạy:
 *   node index.js          → Chạy cron (quét lặp lại mỗi 30 phút)
 *   node index.js --once   → Chạy 1 lần rồi thoát
 */
'use strict';
require('dotenv').config();

const http = require('http');
const cron = require('node-cron');
const config = require('./config');
const { scrapeGroups, commentOnPost } = require('./scraper');
const telegram = require('./telegram');
const { getCommentTemplates } = require('./sheets');

// ── Trạng thái scan ──────────────────────────────────────────────────────────
const scanInfo = { lastScan: null, totalScans: 0, totalMatched: 0, status: 'idle' };
let isScanning = false;

// Theo dõi template nào sẽ được gửi tiếp theo cho mỗi group (để xoay vòng)
const groupTemplateCounters = {};

// ── Kiểm tra cấu hình ───────────────────────────────────────────────────────
function validateConfig() {
    const errors = [];
    if (config.TARGET_GROUPS.length === 0) errors.push('TARGET_GROUPS trống');
    if (config.TARGET_KEYWORDS.length === 0) errors.push('TARGET_KEYWORDS trống');
    if (!config.TELEGRAM_BOT_TOKEN) errors.push('TELEGRAM_BOT_TOKEN thiếu');
    if (!config.TELEGRAM_CHAT_ID) errors.push('TELEGRAM_CHAT_ID thiếu');
    if (errors.length > 0) {
        console.error('❌ Cấu hình chưa đầy đủ:', errors.join(', '));
        return false;
    }
    return true;
}

async function runScan() {
    if (isScanning) {
        console.log('[Scanner] ⏳ Đang quét rồi — bỏ qua lần này');
        return;
    }

    isScanning = true;
    const startTime = Date.now();
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🔍 BẮT ĐẦU QUÉT — ${timestamp}`);
    console.log(`   Groups: ${config.TARGET_GROUPS.length} | Từ khóa: ${config.TARGET_KEYWORDS.length}`);
    console.log(`${'═'.repeat(60)}\n`);

    try {
        // Bước 0: Tải mẫu bình luận từ Google Sheets
        const commentTemplates = await getCommentTemplates();

        // Bước 1: Quét bài viết và tự động bình luận
        const onNewPost = async (post, browser) => {
            // Chỉ xử lý bài đăng trong vòng 60 phút (1 giờ)
            if (post.age_hours !== null && post.age_hours > 1) {
                return; // Bỏ qua hoàn toàn bài cũ
            }

            const matchedKeywords = config.matchKeywords(post.content);
            if (matchedKeywords.length > 0) {
                console.log(`[Scanner] ✨ Khớp từ khóa [${matchedKeywords.join(', ')}] tại: ${post.post_url}`);
                
                // Lấy danh sách bình luận (tối đa 5 cặp) cho nhóm này
                const templates = commentTemplates[(post.group_name || '').toLowerCase()];
                if (templates && templates.length > 0) {
                    console.log(`[Scanner] 💬 Bắt đầu gửi ${templates.length} bình luận cho bài viết...`);
                    
                    for (let i = 0; i < templates.length; i++) {
                        const { text, image } = templates[i];
                        
                        const success = await commentOnPost(browser, post.post_url, text, image);
                        
                        if (success && i < templates.length - 1) {
                            // Delay ngẫu nhiên giữa các comment cho cùng 1 bài
                            const wait = 12000 + Math.random() * 13000;
                            console.log(`[Scanner] 😴 Chờ ${(wait / 1000).toFixed(1)}s trước khi gửi comment tiếp theo...`);
                            await new Promise(r => setTimeout(r, wait));
                        }
                    }
                } else {
                    console.log(`[Scanner] ℹ️ Không có mẫu bình luận cho nhóm: ${post.group_name}`);
                }
            }
        };

        const posts = await scrapeGroups(config.TARGET_GROUPS, onNewPost);

        if (posts.length === 0) {
            console.log('[Scanner] 📭 Không có bài viết mới');
            isScanning = false;
            return;
        }

        // Bước 2: Lọc theo từ khóa để gửi Telegram
        // Đã lọc thêm điều kiện bài viết phải <= 60 phút (1 giờ)
        const matched = posts.filter(p => {
            if (p.age_hours !== null && p.age_hours > 1) return false;
            return config.matchKeywords(p.content).length > 0;
        });

        console.log(`[Scanner] 📊 Kết quả: ${posts.length} bài mới → ${matched.length} bài khớp từ khóa (< 60 phút)`);

        // Bước 3: Gửi Telegram
        if (matched.length > 0) {
            await telegram.sendBatch(matched, config.matchKeywords);
        }

        // Cập nhật trạng thái
        scanInfo.totalScans++;
        scanInfo.totalMatched += matched.length;
        scanInfo.lastScan = new Date().toISOString();
        scanInfo.status = 'idle';

        // Log tổng kết
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`\n✅ QUÉT XONG — ${elapsed}s | ${posts.length} bài | ${matched.length} gửi Telegram\n`);

    } catch (err) {
        console.error(`[Scanner] 💥 Lỗi: ${err.message}`);
        try {
            await telegram.sendSystemMessage(`❌ Lỗi quét: ${err.message}`);
        } catch { }
    } finally {
        isScanning = false;
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  📡 FACEBOOK GROUP SCANNER v1.0           ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`  Groups:    ${config.TARGET_GROUPS.length}`);
    console.log(`  Từ khóa:   ${config.TARGET_KEYWORDS.length}`);
    console.log(`  Chu kỳ:    ${config.SCAN_INTERVAL_MINUTES} phút`);
    console.log(`  Telegram:  ${config.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
    console.log('');

    if (!validateConfig()) {
        process.exit(1);
    }

    // Chạy --once mode (scan 1 lần rồi thoát)
    if (process.argv.includes('--once')) {
        console.log('🔧 Chế độ: Quét 1 lần (--once)\n');
        await runScan();
        process.exit(0);
    }

    // ── Mini HTTP Server — Render free tier cần bind port ─────────────────────
    const PORT = process.env.PORT || 10000;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            app: 'fb-scanner',
            status: 'running',
            uptime: `${Math.round(process.uptime())}s`,
            scan: scanInfo,
        }));
    });
    server.listen(PORT, () => {
        console.log(`🌐 Health-check: http://localhost:${PORT}`);
    });

    // Chạy cron mode
    const cronExpr = `*/${config.SCAN_INTERVAL_MINUTES} * * * *`;
    console.log(`⏰ Chế độ: Cron — quét mỗi ${config.SCAN_INTERVAL_MINUTES} phút (${cronExpr})`);
    console.log('   Nhấn Ctrl+C để dừng.\n');

    // Thông báo Telegram khởi động
    await telegram.sendSystemMessage(
        `🟢 Scanner đã khởi động!\n` +
        `📂 ${config.TARGET_GROUPS.length} groups | 🔑 ${config.TARGET_KEYWORDS.length} từ khóa\n` +
        `⏰ Chu kỳ: ${config.SCAN_INTERVAL_MINUTES} phút`
    );

    // Quét ngay lần đầu
    await runScan();

    // Lên lịch cron
    cron.schedule(cronExpr, () => {
        runScan().catch(err => console.error(`[Cron] Lỗi: ${err.message}`));
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Đang tắt...');
    try {
        await telegram.sendSystemMessage('🔴 Scanner đã tắt.');
    } catch { }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    try { await telegram.sendSystemMessage('🔴 Scanner đã tắt.'); } catch { }
    process.exit(0);
});

main().catch(err => {
    console.error(`💥 Fatal: ${err.message}`);
    process.exit(1);
});
