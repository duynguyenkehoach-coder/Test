/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  GOOGLE SHEETS INTEGRATION                                ║
 * ║  Lấy mẫu bình luận từ Google Sheets (CSV export)          ║
 * ╚═══════════════════════════════════════════════════════════╝
 */
'use strict';
const axios = require('axios');
const config = require('./config');

/**
 * Tải dữ liệu từ Google Sheet và chuyển thành object map
 * @returns {Promise<Object>} Map { GroupName: CommentText }
 */
async function getCommentTemplates() {
    if (!config.GOOGLE_SHEET_ID) {
        console.warn('[Sheets] ⚠️ GOOGLE_SHEET_ID không tồn tại');
        return {};
    }

    const url = `https://docs.google.com/spreadsheets/d/${config.GOOGLE_SHEET_ID}/export?format=csv`;
    
    try {
        console.log('[Sheets] 📥 Đang tải mẫu bình luận từ Google Sheets...');
        const response = await axios.get(url, { timeout: 15000 });
        const csvData = response.data;

        const { parse } = require('csv-parse/sync');
        const records = parse(csvData, {
            columns: false,
            skip_empty_lines: true,
            trim: true
        });

        const templates = {};

        records.forEach((parts, index) => {
            // Bỏ qua dòng tiêu đề (thường là dòng đầu tiên)
            if (index === 0) return;
            
            if (parts.length >= 2) {
                const groupNameOrig = parts[0].trim();
                // Bỏ qua dòng trống hoặc không có tên
                if (!groupNameOrig || groupNameOrig.toLowerCase() === 'group name') return;
                const groupName = groupNameOrig.toLowerCase();

                const pairs = [];
                // Lấy tối đa 5 cặp (cột 1-2, 3-4, 5-6, 7-8, 9-10)
                for (let i = 1; i <= 9; i += 2) {
                    const text = parts[i]?.trim() || '';
                    const image = parts[i+1]?.trim() || '';
                    
                    if (text || image) {
                        pairs.push({ text, image });
                    }
                }

                if (pairs.length > 0) {
                    templates[groupName] = pairs;
                }
            }
        });

        console.log(`[Sheets] ✅ Đã tải mẫu bình luận cho ${Object.keys(templates).length} nhóm:`);
        Object.keys(templates).forEach(k => console.log(`   - ${k}`));
        
        return templates;
    } catch (err) {
        console.error(`[Sheets] ❌ Lỗi khi tải mẫu từ Google Sheets: ${err.message}`);
        return {};
    }
}

module.exports = { getCommentTemplates };
