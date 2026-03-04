/**
 * THG Lead Gen — Rotation Manager
 * 
 * Vấn đề: Mỗi scan đều quét CÙNG danh sách → data trùng, credits lãng phí
 * 
 * Giải pháp: Xoay vòng (rotation) — mỗi scan quét một tập khác nhau
 * 
 * VÍ DỤ với 10 groups, mỗi scan lấy 4:
 *   Scan 1 (8:00):  groups 0,1,2,3
 *   Scan 2 (8:30):  groups 4,5,6,7
 *   Scan 3 (9:00):  groups 8,9,0,1
 *   Scan 4 (9:30):  groups 2,3,4,5
 *   → Mỗi group được quét đều nhau, không bỏ sót
 * 
 * STATE: Lưu vào file JSON để persist qua restart
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/rotation_state.json');

// Đảm bảo thư mục tồn tại
function ensureDir() {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
    ensureDir();
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (e) { }
    return {
        fb_groups_index: 0,
        fb_competitors_index: 0,
        tt_hashtags_index: 0,
        ig_accounts_index: 0,
        last_reset: new Date().toDateString(),
        scan_count_today: 0,
    };
}

function saveState(state) {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Lấy slice tiếp theo từ list, xoay vòng
 * @param {Array} list - Toàn bộ danh sách
 * @param {number} currentIndex - Index hiện tại
 * @param {number} batchSize - Số item lấy mỗi lần
 * @returns {{ items, nextIndex }}
 */
function getRotatedBatch(list, currentIndex, batchSize) {
    if (!list.length) return { items: [], nextIndex: 0 };

    const size = Math.min(batchSize, list.length);
    const items = [];

    for (let i = 0; i < size; i++) {
        items.push(list[(currentIndex + i) % list.length]);
    }

    const nextIndex = (currentIndex + size) % list.length;
    return { items, nextIndex };
}

/**
 * Lấy batch tiếp theo cho từng platform, tự động cập nhật state
 */
function getNextBatch(platform, list, batchSize) {
    const state = loadState();

    // Reset count mỗi ngày mới
    const today = new Date().toDateString();
    if (state.last_reset !== today) {
        state.last_reset = today;
        state.scan_count_today = 0;
        // KHÔNG reset index — tiếp tục từ chỗ dừng hôm qua
        console.log(`[Rotation] 🔄 New day reset — scan count reset, indexes continue`);
    }

    const indexKey = `${platform}_index`;
    const currentIndex = state[indexKey] || 0;

    const { items, nextIndex } = getRotatedBatch(list, currentIndex, batchSize);

    // Cập nhật state
    state[indexKey] = nextIndex;
    state.scan_count_today = (state.scan_count_today || 0) + 1;
    saveState(state);

    const endIndex = (currentIndex + items.length - 1) % list.length;
    console.log(`[Rotation] 📍 ${platform}: items ${currentIndex}→${endIndex} (${items.length}/${list.length} total) | scan #${state.scan_count_today} today`);

    return items;
}

/**
 * Log trạng thái rotation hiện tại (cho debug)
 */
function logStatus() {
    const state = loadState();
    console.log(`[Rotation] 📊 Current state:`, JSON.stringify(state, null, 2));
}

/**
 * Reset index của một platform (dùng khi thêm/xóa item)
 */
function resetIndex(platform) {
    const state = loadState();
    state[`${platform}_index`] = 0;
    saveState(state);
    console.log(`[Rotation] 🔄 Reset ${platform} index to 0`);
}

module.exports = { getNextBatch, logStatus, resetIndex };
