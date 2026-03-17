/**
 * CrawBot Account Manager v1.0
 * 
 * Quản lý nhiều tài khoản Facebook cho hệ thống quét tự động:
 * - Xoay vòng (rotate) tài khoản theo trạng thái sức khỏe
 * - Gán proxy 1:1 cho mỗi tài khoản (tránh Chain-ban)
 * - Phát hiện và xử lý Checkpoint tự động
 * - Cửa sổ thời gian hoạt động (8h - 23h VN)
 * - Hành vi giống người dùng thật (Like dạo, nghỉ ngơi)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const db = require('../../core/data_store/database');

// ─── Activity Time Window ─────────────────────────────────────────────────
// Quét giờ seller Việt Kiều Mỹ active (23h VN → 13h VN hôm sau = 8am-10pm ET)
const ACTIVE_HOUR_START = 23;  // 23h VN = 8am ET
const ACTIVE_HOUR_END = 13;  // 13h VN = 10pm ET hôm trước
const SESSIONS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'fb_sessions');

// ─── DB Migration: tạo bảng fb_accounts nếu chưa có ────────────────────
function ensureAccountsTable() {
    db.db.exec(`
        CREATE TABLE IF NOT EXISTS fb_accounts (
            id          TEXT PRIMARY KEY,
            email       TEXT NOT NULL UNIQUE,
            password    TEXT NOT NULL,
            proxy_url   TEXT DEFAULT '',
            status      TEXT DEFAULT 'active',
            -- active | checkpoint | banned | resting
            checkpoint_count INTEGER DEFAULT 0,
            last_used   TEXT DEFAULT '',
            last_scan   TEXT DEFAULT '',
            session_path TEXT DEFAULT '',
            trust_score INTEGER DEFAULT 100,
            -- 100 = fresh, drops on checkpoint, recovers on rest
            notes       TEXT DEFAULT '',
            created_at  TEXT DEFAULT (datetime('now'))
        );
    `);

    // Seed tài khoản từ .env — hỗ trợ nhiều account:
    // FB_ACCOUNT_1_EMAIL, FB_ACCOUNT_1_PASSWORD (mới)
    // FB_EMAIL, FB_PASSWORD (cũ — compat)
    const accountsToSeed = [];

    // Multi-account format: FB_ACCOUNT_1_EMAIL, FB_ACCOUNT_2_EMAIL, ...
    let i = 1;
    while (process.env[`FB_ACCOUNT_${i}_EMAIL`]) {
        accountsToSeed.push({
            id: `account_${i}`,
            email: process.env[`FB_ACCOUNT_${i}_EMAIL`],
            password: process.env[`FB_ACCOUNT_${i}_PASSWORD`] || '',
        });
        i++;
    }

    // Legacy single-account format (backwards compat)
    if (accountsToSeed.length === 0 && process.env.FB_EMAIL) {
        accountsToSeed.push({
            id: 'default',
            email: process.env.FB_EMAIL,
            password: process.env.FB_PASSWORD || '',
        });
    }

    for (const acct of accountsToSeed) {
        const sessionPath = path.join(SESSIONS_DIR, `${acct.email.replace(/[^a-z0-9]/gi, '_')}.json`);
        db.db.prepare(`
            INSERT OR IGNORE INTO fb_accounts (id, email, password, proxy_url, session_path)
            VALUES (?, ?, ?, ?, ?)
        `).run(acct.id, acct.email, acct.password, '', sessionPath);
        console.log(`[AccountManager] 📋 Seeded: ${acct.email}`);
    }
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

ensureAccountsTable();

// Migration: link FB account to Sales person
try { db.db.exec(`ALTER TABLE fb_accounts ADD COLUMN sales_name TEXT DEFAULT ''`); } catch { }

// ─── Get account linked to a Sales name ──────────────────────────────────
function getAccountBySalesName(salesName) {
    return db.db.prepare(
        `SELECT * FROM fb_accounts WHERE sales_name = ? AND status = 'active' LIMIT 1`
    ).get(salesName);
}

function linkAccountToSales(email, salesName) {
    db.db.prepare(`UPDATE fb_accounts SET sales_name = ? WHERE email = ?`).run(salesName, email);
    console.log(`[AccountManager] 🔗 ${email} → ${salesName}`);
}

// ─── Time Window Check ───────────────────────────────────────────────────
function isInActiveWindow() {
    // VN time = UTC + 7
    const vnHour = (new Date().getUTCHours() + 7) % 24;
    // Active: 23h-23h59 (buổi tối VN) HOẶC 0h-13h59 (sáng VN = sáng ET)
    return vnHour >= ACTIVE_HOUR_START || vnHour <= ACTIVE_HOUR_END;
}

/**
 * Lấy tài khoản tốt nhất để sử dụng ngay bây giờ.
 * Ưu tiên: trust_score cao → ít dùng gần đây → proxy sẵn sàng
 * @returns {object|null} account row or null
 */
function getNextAccount(options = {}) {
    const account = db.db.prepare(`
        SELECT * FROM fb_accounts
        WHERE status = 'active'
          AND trust_score > 20
        ORDER BY trust_score DESC, last_used ASC
        LIMIT 1
    `).get();

    if (!account) {
        // Kiểm tra có tài khoản đang resting có thể phục hồi không
        const resting = db.db.prepare(`
            SELECT * FROM fb_accounts
            WHERE status = 'resting'
              AND datetime(last_used) < datetime('now', '-4 hours')
            LIMIT 1
        `).get();

        if (resting) {
            console.log(`[AccountManager] 🔄 Phục hồi tài khoản ${resting.email} (đã nghỉ đủ)`);
            db.db.prepare(`UPDATE fb_accounts SET status='active', trust_score=MIN(trust_score+30, 100) WHERE id=?`).run(resting.id);
            return resting;
        }

        console.log('[AccountManager] ❌ Không có tài khoản nào sẵn sàng!');
        return null;
    }

    // Đánh dấu tài khoản đang được dùng
    db.db.prepare(`UPDATE fb_accounts SET last_used=datetime('now') WHERE id=?`).run(account.id);
    console.log(`[AccountManager] ✅ Dùng tài khoản: ${account.email} (trust=${account.trust_score}, proxy=${account.proxy_url || 'none'})`);
    return account;
}

/**
 * Báo cáo tài khoản bị Checkpoint — giảm trust, tạm dừng dùng
 * @param {string} accountId
 */
function reportCheckpoint(accountId) {
    const acc = db.db.prepare('SELECT * FROM fb_accounts WHERE id=?').get(accountId);
    if (!acc) return;

    const newCheckpointCount = (acc.checkpoint_count || 0) + 1;
    const newTrust = Math.max(0, (acc.trust_score || 100) - 40);
    const newStatus = newTrust <= 20 ? 'banned' : 'resting';

    db.db.prepare(`
        UPDATE fb_accounts
        SET status=?, trust_score=?, checkpoint_count=?, last_used=datetime('now')
        WHERE id=?
    `).run(newStatus, newTrust, newCheckpointCount, accountId);

    console.log(`[AccountManager] 🚨 CHECKPOINT: ${acc.email} → status=${newStatus}, trust=${newTrust}, count=${newCheckpointCount}`);

    if (newStatus === 'banned') {
        console.log(`[AccountManager] 💀 ${acc.email} bị BAN — đã bị checkpoint ${newCheckpointCount} lần. Loại khỏi vòng quay.`);
    } else {
        console.log(`[AccountManager] 😴 ${acc.email} đang REST — sẽ phục hồi sau 4 giờ`);
    }
}

/**
 * Báo cáo quét thành công — tăng trust score nhẹ
 * @param {string} accountId
 * @param {number} postsFound
 */
function reportSuccess(accountId, postsFound = 0) {
    db.db.prepare(`
        UPDATE fb_accounts
        SET trust_score = MIN(trust_score + 5, 100),
            last_scan = datetime('now'),
            last_used = datetime('now')
        WHERE id=?
    `).run(accountId);

    const acc = db.db.prepare('SELECT email, trust_score FROM fb_accounts WHERE id=?').get(accountId);
    if (acc) {
        console.log(`[AccountManager] 📈 ${acc.email}: +5 trust → ${acc.trust_score} (${postsFound} posts)`);
    }
}

/**
 * Lấy session path cho account
 * @param {object} account 
 * @returns {string}
 */
function getSessionPath(account) {
    if (account.session_path && account.session_path.trim()) {
        return account.session_path.trim();
    }
    return path.join(SESSIONS_DIR, `${account.email.replace(/[^a-z0-9]/gi, '_')}.json`);
}

/**
 * Thêm tài khoản mới vào pool
 * @param {object} opts - { email, password, proxyUrl, notes }
 */
function addAccount({ email, password, proxyUrl = '', notes = '' }) {
    const id = `acc_${Date.now()}`;
    const sessionPath = path.join(SESSIONS_DIR, `${email.replace(/[^a-z0-9]/gi, '_')}.json`);

    db.db.prepare(`
        INSERT OR REPLACE INTO fb_accounts (id, email, password, proxy_url, session_path, notes)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, email, password, proxyUrl || '', sessionPath, notes);

    console.log(`[AccountManager] ➕ Thêm tài khoản: ${email} (proxy: ${proxyUrl || 'none'})`);
    return id;
}

/**
 * Xem trạng thái toàn bộ pool tài khoản
 * @returns {object[]}
 */
function getPoolStatus() {
    return db.db.prepare(`
        SELECT email, status, trust_score, checkpoint_count,
               last_scan, proxy_url,
               CASE WHEN proxy_url != '' THEN '✅' ELSE '❌' END as has_proxy
        FROM fb_accounts
        ORDER BY trust_score DESC
    `).all();
}

/**
 * Đặt lại trạng thái tài khoản về active (dùng thủ công sau khi giải checkpoint)
 * @param {string} email
 */
function resetAccount(email) {
    db.db.prepare(`
        UPDATE fb_accounts
        SET status='active', trust_score=70, checkpoint_count=0
        WHERE email=?
    `).run(email);
    console.log(`[AccountManager] 🔄 Reset ${email} → active, trust=70`);
}

/**
 * Human-like: Thỉnh thoảng cho bot nghỉ (simulate off-peak)
 * Xác suất 10% mỗi phiên: account tự nghỉ 30-60 phút
 * @param {string} accountId
 * @returns {boolean} true = account đang nghỉ, bỏ qua phiên này
 */
function shouldRest(accountId) {
    if (Math.random() < 0.1) {
        db.db.prepare(`UPDATE fb_accounts SET status='resting', last_used=datetime('now','-3.5 hours') WHERE id=?`).run(accountId);
        const acc = db.db.prepare('SELECT email FROM fb_accounts WHERE id=?').get(accountId);
        console.log(`[AccountManager] 😴 ${acc?.email}: Nghỉ ngẫu nhiên (giống người thật)`);
        return true;
    }
    return false;
}

/**
 * Get ALL active accounts (for splitting groups across accounts)
 * @returns {object[]} array of active account rows
 */
function getActiveAccounts() {
    const accounts = db.db.prepare(`
        SELECT * FROM fb_accounts
        WHERE status = 'active'
          AND trust_score > 20
        ORDER BY trust_score DESC
    `).all();

    // Also recover resting accounts that have rested enough
    const resting = db.db.prepare(`
        SELECT * FROM fb_accounts
        WHERE status = 'resting'
          AND datetime(last_used) < datetime('now', '-4 hours')
    `).all();

    for (const acc of resting) {
        db.db.prepare(`UPDATE fb_accounts SET status='active', trust_score=MIN(trust_score+30, 100) WHERE id=?`).run(acc.id);
        accounts.push({ ...acc, status: 'active' });
    }

    return accounts;
}

module.exports = {
    getNextAccount,
    getActiveAccounts,
    getAccountBySalesName,
    linkAccountToSales,
    reportCheckpoint,
    reportSuccess,
    getSessionPath,
    addAccount,
    getPoolStatus,
    resetAccount,
    shouldRest,
    isInActiveWindow,
    SESSIONS_DIR,
};
