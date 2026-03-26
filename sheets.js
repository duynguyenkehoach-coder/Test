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
        const response = await axios.get(url, { timeout: 10000 });
        const csvData = response.data;

        // Parse CSV đơn giản
        // Layout: Group name, T1, I1, T2, I2, T3, I3, T4, I4, T5, I5 (11 cột)
        const lines = csvData.split(/\r?\n/).filter(line => line.trim().length > 0);
        const templates = {};

        lines.forEach((line, index) => {
            // Sử dụng regex để split CSV bảo toàn dấu ngoặc kép
            const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            
            if (parts.length >= 2) {
                const groupNameOrig = parts[0].replace(/^"|"$/g, '').trim();
                // Bỏ qua dòng tiêu đề hoặc dòng trống
                if (!groupNameOrig || groupNameOrig.toLowerCase() === 'group name') return;
                const groupName = groupNameOrig.toLowerCase();

                const pairs = [];
                // Lấy tối đa 5 cặp (cột 1-2, 3-4, 5-6, 7-8, 9-10)
                for (let i = 1; i <= 9; i += 2) {
                    const text = parts[i]?.replace(/^"|"$/g, '').trim() || '';
                    const image = parts[i+1]?.replace(/^"|"$/g, '').trim() || '';
                    
                    if (text || image) {
                        pairs.push({ text, image });
                    }
                }

                if (pairs.length > 0) {
                    templates[groupName] = pairs;
                }
            }
        });

        console.log(`[Sheets] ✅ Đã tải mẫu bình luận cho ${Object.keys(templates).length} nhóm.`);
        return templates;
    } catch (error) {
        console.error(`[Sheets] ❌ Lỗi khi tải Sheet: ${error.message}`);
        return {};
    }
}

module.exports = { getCommentTemplates };
