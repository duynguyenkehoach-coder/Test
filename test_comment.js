/**
 * SCRIPT TEST COMMENT NHANH
 * Cách dùng: node test_comment.js "LINK_BAI_VIET"
 */
'use strict';
const { chromium } = require('playwright');
const { commentOnPost } = require('./scraper');
const { getCommentTemplates } = require('./sheets');
const config = require('./config');

async function runTest() {
    const postUrl = process.argv[2];
    if (!postUrl) {
        console.error('❌ Thiếu link bài viết! Ví dụ: node test_comment.js "https://facebook.com/posts/123"');
        process.exit(1);
    }

    console.log('🚀 Đang chạy thử nghiệm bình luận...');
    
    // 1. Lấy mẫu từ Sheet
    const allTemplates = await getCommentTemplates();
    const gvTemplates = allTemplates['phòng trọ gò vấp'];
    
    if (!gvTemplates || gvTemplates.length === 0) {
        console.error('❌ Không tìm thấy mẫu bình luận cho "phòng trọ gò vấp" trong Sheet!');
        process.exit(1);
    }

    console.log(`✅ Tìm thấy ${gvTemplates.length} mẫu bình luận.`);

    // 2. Khởi tạo trình duyệt
    const browser = await chromium.launch({ 
        headless: true // Chạy ẩn để an toàn, hoặc false nếu muốn xem tận mắt
    });

    try {
        for (let i = 0; i < gvTemplates.length; i++) {
            const { text, image } = gvTemplates[i];
            console.log(`[${i+1}/${gvTemplates.length}] Đang gửi: "${text.substring(0, 30)}..."`);
            
            const success = await commentOnPost(browser, postUrl, text, image);
            
            if (success) {
                console.log('   ✅ Thành công!');
            } else {
                console.log('   ❌ Thất bại!');
            }

            if (i < gvTemplates.length - 1) {
                const wait = 15000 + Math.random() * 10000;
                console.log(`😴 Chờ ${(wait/1000).toFixed(1)}s trước comment tiếp theo...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    } catch (err) {
        console.error('💥 Lỗi:', err.message);
    } finally {
        await browser.close();
        console.log('🏁 Hoàn tất thử nghiệm.');
    }
}

runTest();
