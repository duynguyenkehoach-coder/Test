/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  CẤU HÌNH FACEBOOK SCANNER                                ║
 * ║  Sửa 2 mảng bên dưới theo nhu cầu của bạn                 ║
 * ╚═══════════════════════════════════════════════════════════╝
 */
require('dotenv').config();

// ════════════════════════════════════════════════════════════════
// ĐIỀN CÁC FACEBOOK GROUPS BẠN MUỐN QUÉT VÀO ĐÂY
// Mỗi group cần 2 thông tin: name (tên gợi nhớ) và url (link group)
// Tối đa 13 groups để tránh bị Facebook chặn
// ════════════════════════════════════════════════════════════════
const TARGET_GROUPS = [
    { name: 'PHÒNG TRỌ GÒ VẤP', url: 'https://www.facebook.com/share/g/1DEkXgMPwr/' },
    { name: 'PHÒNG TRỌ QUẬN 11', url: 'https://www.facebook.com/share/g/1Cr4Xb87b3/' },
    { name: 'PHÒNG TRỌ TÂN PHÚ', url: 'https://www.facebook.com/share/g/1DawXDDcyD/' },
    { name: 'PHÒNG TRỌ QUẬN 10', url: 'https://www.facebook.com/share/g/1D8Yp71Ciq/' },
    { name: 'PHÒNG TRỌ TÂN BÌNH', url: 'https://www.facebook.com/share/g/182xxqAWhE/' },
    { name: 'PHÒNG TRỌ TÂN BÌNH', url: 'https://www.facebook.com/share/g/14fpKk3Se3U/' },
    { name: 'Phòng Trọ Tân Bình, Tân Phú Giá Rẻ', url: 'https://www.facebook.com/share/g/1Htbu4gvKG/' },
    { name: 'Phòng Trọ Tân Phú', url: 'https://www.facebook.com/share/g/1BvxZZcEj2/' },
    { name: 'Phòng Trọ Bình Tân, Tân Phú Giá Rẻ', url: 'https://www.facebook.com/share/g/18JJMcCo2n/' },
    { name: 'Phòng trọ Tân Phú', url: 'https://www.facebook.com/share/g/1CgmUtE4Mk/' },
    { name: 'PHÒNG TRỌ GÒ VẤP', url: 'https://www.facebook.com/share/g/1HM5f6gTYM/' },
    { name: 'Phòng Trọ Gò Vấp, Tân Bình Giá Rẻ', url: 'https://www.facebook.com/share/g/1DzSk5LuEh/' },
    { name: 'Phòng Trọ Gò Vấp, Tân Bình Giá Rẻ', url: 'https://www.facebook.com/share/g/1DzNywuRsS/' },
];

// ════════════════════════════════════════════════════════════════
// TỪ KHÓA LỌC BÀI VIẾT
// Bài viết chứa BẤT KỲ từ khóa nào trong danh sách sẽ được gửi về Telegram
// Không phân biệt chữ hoa/thường, hỗ trợ tiếng Việt có dấu
// ════════════════════════════════════════════════════════════════
const TARGET_KEYWORDS = [
    'tìm phòng',
    'tìm trọ',
    'tìm khu vực',
];

// ════════════════════════════════════════════════════════════════
// HÀM LỌC TỪ KHÓA — Kiểm tra bài viết có chứa từ khóa không
// Trả về mảng các từ khóa khớp, hoặc mảng rỗng nếu không khớp
// ════════════════════════════════════════════════════════════════
function matchKeywords(text) {
    if (!text || TARGET_KEYWORDS.length === 0) return [];
    const lowerText = text.toLowerCase();
    return TARGET_KEYWORDS.filter(kw => lowerText.includes(kw.toLowerCase()));
}

// ════════════════════════════════════════════════════════════════
// CẤU HÌNH HỆ THỐNG (đọc từ .env — không cần sửa ở đây)
// ════════════════════════════════════════════════════════════════
module.exports = {
    TARGET_GROUPS,
    TARGET_KEYWORDS,
    matchKeywords,

    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    // Facebook
    FB_COOKIES: process.env.FB_COOKIES || '',

    // Tuỳ chọn
    SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '60', 10),
    MAX_POSTS_PER_GROUP: parseInt(process.env.MAX_POSTS_PER_GROUP || '30', 10),
    MAX_POST_AGE_DAYS: parseInt(process.env.MAX_POST_AGE_DAYS || '3', 10),

    // Google Sheets
    GOOGLE_SHEET_ID: '1TxzKr9K7opWIzrir4jRPUuh2ER6ggAmJhiBwM4LKQe8',
};
