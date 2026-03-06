/**
 * THG Group Discovery Agent
 * 
 * Kho dữ liệu FB groups — nền tảng để thay SociaVault dần dần.
 * Lưu trữ 100+ groups với relevance scoring, auto-discovery, và sync với scan rotation.
 * 
 * Schema: fb_groups (id, name, url, group_id, member_count, category, relevance_score, status, discovered_at, last_scanned_at)
 */

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'groups.db');

let _db = null;
function getDb() {
    if (_db) return _db;
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    initSchema();
    return _db;
}

function initSchema() {
    _db.exec(`
        CREATE TABLE IF NOT EXISTS fb_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT UNIQUE NOT NULL,
            group_id TEXT,
            member_count INTEGER DEFAULT 0,
            category TEXT DEFAULT 'unknown',
            relevance_score INTEGER DEFAULT 50,
            status TEXT DEFAULT 'active',
            notes TEXT DEFAULT '',
            discovered_at TEXT DEFAULT (datetime('now')),
            last_scanned_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fsg_status ON fb_groups(status);
        CREATE INDEX IF NOT EXISTS idx_fsg_cat ON fb_groups(category);
        CREATE INDEX IF NOT EXISTS idx_fsg_score ON fb_groups(relevance_score);
    `);
    // Seed data nếu chưa có
    const count = _db.prepare('SELECT COUNT(*) as c FROM fb_groups').get().c;
    if (count === 0) {
        seedGroups();
        console.log('[GroupDB] 🌱 Seeded', _db.prepare('SELECT COUNT(*) as c FROM fb_groups').get().c, 'groups');
    }
}

// ════════════════════════════════════════════════════════
// CRUD Operations
// ════════════════════════════════════════════════════════

function upsertGroup(group) {
    const stmt = _db.prepare(`
        INSERT INTO fb_groups (name, url, group_id, member_count, category, relevance_score, notes)
        VALUES (@name, @url, @group_id, @member_count, @category, @relevance_score, @notes)
        ON CONFLICT(url) DO UPDATE SET
            name = excluded.name,
            group_id = COALESCE(excluded.group_id, fb_groups.group_id),
            member_count = CASE WHEN excluded.member_count > 0 THEN excluded.member_count ELSE fb_groups.member_count END,
            relevance_score = excluded.relevance_score
    `);
    return stmt.run({
        name: group.name,
        url: group.url,
        group_id: extractGroupId(group.url),
        member_count: group.member_count || 0,
        category: group.category || 'unknown',
        relevance_score: group.relevance_score || 50,
        notes: group.notes || '',
    });
}

function extractGroupId(url) {
    if (!url) return null;
    const match = url.match(/\/groups\/(\d+)/);
    return match ? match[1] : null;
}

function getActiveGroups(limit = 50) {
    return getDb().prepare(`
        SELECT * FROM fb_groups 
        WHERE status = 'active' AND relevance_score >= 40
        ORDER BY relevance_score DESC, last_scanned_at ASC NULLS FIRST
        LIMIT ?
    `).all(limit);
}

function getTopGroups(limit = 20) {
    return getDb().prepare(`
        SELECT * FROM fb_groups 
        WHERE status = 'active'
        ORDER BY relevance_score DESC
        LIMIT ?
    `).all(limit);
}

function markScanned(url) {
    getDb().prepare(`UPDATE fb_groups SET last_scanned_at = datetime('now') WHERE url = ?`).run(url);
}

function updateScore(url, score) {
    getDb().prepare(`UPDATE fb_groups SET relevance_score = ? WHERE url = ?`).run(score, url);
}

function setStatus(url, status) {
    getDb().prepare(`UPDATE fb_groups SET status = ? WHERE url = ?`).run(status, url);
}

function getStats() {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM fb_groups').get().c;
    const active = db.prepare("SELECT COUNT(*) as c FROM fb_groups WHERE status = 'active'").get().c;
    const byCategory = db.prepare('SELECT category, COUNT(*) as c FROM fb_groups GROUP BY category ORDER BY c DESC').all();
    const highScore = db.prepare('SELECT COUNT(*) as c FROM fb_groups WHERE relevance_score >= 70').get().c;
    return { total, active, highScore, byCategory };
}

function getAllGroups(filters = {}) {
    const db = getDb();
    let q = 'SELECT * FROM fb_groups WHERE 1=1';
    const params = [];
    if (filters.category) { q += ' AND category = ?'; params.push(filters.category); }
    if (filters.status) { q += ' AND status = ?'; params.push(filters.status); }
    q += ' ORDER BY relevance_score DESC, name ASC';
    if (filters.limit) { q += ' LIMIT ?'; params.push(filters.limit); }
    return db.prepare(q).all(...params);
}

// ════════════════════════════════════════════════════════
// SEED DATA — 107 groups discovered by browser agent
// Categories: logistics | tq-goods | viet-kieu | ecommerce | marketplace
// Relevance: 80-95 = Tier1 (buyer intent cao), 60-79 = Tier2, 40-59 = Tier3
// ════════════════════════════════════════════════════════

function seedGroups() {
    const insert = _db.prepare(`
        INSERT OR IGNORE INTO fb_groups (name, url, group_id, member_count, category, relevance_score)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const groups = [
        // === LOGISTICS / SHIPPING (Cat 1) — Relevance 70-90 ===
        ['Vận Chuyển Mỹ - Việt & Quốc Tế', 'https://www.facebook.com/groups/ship.viet.my', null, 75000, 'logistics', 85],
        ['Mua Hộ Order Vận Chuyển Hàng Mỹ', 'https://www.facebook.com/groups/vanchuyenhangmy', null, 108000, 'logistics', 88],
        ['CỘNG ĐỒNG VẬN CHUYỂN HÀNG HOÁ VIỆT - MỸ', 'https://www.facebook.com/groups/198874301317672', '198874301317672', 13000, 'logistics', 90],
        ['GỬI HÀNG ĐI MỸ', 'https://www.facebook.com/groups/511057606227863', '511057606227863', 15000, 'logistics', 92],
        ['Vận Chuyển Hàng Hóa Quốc Tế - Mỹ, Úc, CA', 'https://www.facebook.com/groups/1769375073378312', '1769375073378312', 33000, 'logistics', 85],
        ['VẬN CHUYỂN HÀNG ĐI MỸ - ÚC - CANADA', 'https://www.facebook.com/groups/2733989140224151', '2733989140224151', 0, 'logistics', 82],
        ['Gửi Hàng Đi Mỹ - Úc - Canada - Châu Âu', 'https://www.facebook.com/groups/2485669168339896', '2485669168339896', 0, 'logistics', 82],
        ['Vận Chuyển Quốc Tế', 'https://www.facebook.com/groups/369902271922489', '369902271922489', 0, 'logistics', 78],
        ['HỘI VẬN CHUYỂN HÀNG HÓA QUỐC TẾ', 'https://www.facebook.com/groups/hoivanchuyenhanghoaquocte', null, 36000, 'logistics', 80],
        ['VẬN CHUYỂN HÀNG HÓA QUỐC TẾ', 'https://www.facebook.com/groups/vanchuyenhhqt', null, 42000, 'logistics', 80],
        ['VẬN CHUYỂN QUỐC TẾ', 'https://www.facebook.com/groups/vanchuyenquocte.hcm', null, 21000, 'logistics', 78],
        ['CHUYỂN PHÁT NHANH QUỐC TẾ', 'https://www.facebook.com/groups/chuyenphatnhanhquocte.hcm', null, 12000, 'logistics', 75],
        ['Vận Chuyển Hàng Mỹ Việt Giá Rẻ', 'https://www.facebook.com/groups/2347372242199015', '2347372242199015', 0, 'logistics', 83],
        ['Gửi hàng đi Mỹ', 'https://www.facebook.com/groups/701183890614920', '701183890614920', 0, 'logistics', 82],
        ['Gửi hàng đi Mỹ - Canada - Úc - NZ', 'https://www.facebook.com/groups/2272449176537942', '2272449176537942', 0, 'logistics', 80],
        ['Gửi hàng đi Mỹ,Úc,Canada,Nhật Bản,...', 'https://www.facebook.com/groups/guihangdimyre', null, 0, 'logistics', 78],
        ['Gửi Hàng Đi Mỹ (2)', 'https://www.facebook.com/groups/guihangdimy', null, 0, 'logistics', 78],
        ['Gửi hàng đi Mỹ, Úc, Canada, Pháp...', 'https://www.facebook.com/groups/356310528854487', '356310528854487', 0, 'logistics', 76],
        ['Gửi hàng đi Mỹ, Úc, Canada giá rẻ', 'https://www.facebook.com/groups/965976281069076', '965976281069076', 0, 'logistics', 76],
        ['Gửi Hàng Đi Mỹ giá rẻ (2)', 'https://www.facebook.com/groups/1600769086782925', '1600769086782925', 0, 'logistics', 74],

        // === TQ GOODS / NHẬP HÀNG (Cat 2) — Relevance 75-90 ===
        ['TỰ ORDER HÀNG TRUNG QUỐC - VẬN CHUYỂN', 'https://www.facebook.com/groups/818557785724151', '818557785724151', 158000, 'tq-goods', 90],
        ['Hội Oder Taobao, 1688, Quảng Châu', 'https://www.facebook.com/groups/383383542305976', '383383542305976', 194000, 'tq-goods', 92],
        ['Order Hàng TQ - Vận Chuyển XNK', 'https://www.facebook.com/groups/1698840756986636', '1698840756986636', 21000, 'tq-goods', 88],
        ['Vận Chuyển Hàng Hoá Quốc Tế (TQ)', 'https://www.facebook.com/groups/200385268215972', '200385268215972', 0, 'tq-goods', 78],
        ['Order hàng Trung Quốc - XNK', 'https://www.facebook.com/groups/109909824518356', '109909824518356', 0, 'tq-goods', 80],
        ['Nhập Hàng Trung Quốc Giá Xưởng', 'https://www.facebook.com/groups/nhaphangtrungiaxuong', null, 0, 'tq-goods', 78],
        ['NHẬP HÀNG TRUNG QUỐC', 'https://www.facebook.com/groups/435317583994171', '435317583994171', 0, 'tq-goods', 76],
        ['Kinh Nghiệm Nhập Hàng Trung Quốc', 'https://www.facebook.com/groups/hangquangchau24h.vn', null, 0, 'tq-goods', 74],
        ['Cộng Đồng Nhập Khẩu Chính Ngạch TQ', 'https://www.facebook.com/groups/xnkchinhngachtrungquoc', null, 0, 'tq-goods', 76],
        ['NHẬP HÀNG TRUNG QUỐC - TRUNG VIỆT', 'https://www.facebook.com/groups/nhaphangtrungquoc1688.vn', null, 0, 'tq-goods', 76],
        ['Vận Chuyển Hàng TQ Về Việt Nam', 'https://www.facebook.com/groups/278168523699221', '278168523699221', 0, 'tq-goods', 74],
        ['WLT NHẬP HÀNG TRUNG QUỐC CHÍNH NGẠCH', 'https://www.facebook.com/groups/orderhangquocte.com0363688761', null, 0, 'tq-goods', 65],
        ['Vận Chuyển Hàng TQ Về VN (2)', 'https://www.facebook.com/groups/730577794450448', '730577794450448', 0, 'tq-goods', 72],

        // === VIỆT KIỀU / CỘNG ĐỒNG (Cat 3) — Relevance 60-85 ===
        ['CỘNG ĐỒNG NGƯỜI VIỆT TẠI MỸ', 'https://www.facebook.com/groups/VietnamUSA', null, 112000, 'viet-kieu', 85],
        ['HỘI NGƯỜI VIỆT TẠI MỸ', 'https://www.facebook.com/groups/NguoiVietTaiMy', null, 36000, 'viet-kieu', 82],
        ['Người Việt Tại Mỹ', 'https://www.facebook.com/groups/573930679829173', '573930679829173', 59000, 'viet-kieu', 82],
        ['CỘNG ĐỒNG NGƯỜI VIỆT TẠI MỸ (USA)', 'https://www.facebook.com/groups/1415834722204275', '1415834722204275', 15000, 'viet-kieu', 80],
        ['Người Việt tại Texas USA', 'https://www.facebook.com/groups/453760238397047', '453760238397047', 21000, 'viet-kieu', 78],
        ['Cộng Đồng Người Việt Tại Texas', 'https://www.facebook.com/groups/855654204997742', '855654204997742', 14000, 'viet-kieu', 76],
        ['Người Việt Qua Texas', 'https://www.facebook.com/groups/880114806135806', '880114806135806', 8000, 'viet-kieu', 72],
        ['Người Việt San Antonio, Houston. Texas', 'https://www.facebook.com/groups/2370456419930799', '2370456419930799', 0, 'viet-kieu', 70],
        ['Người Việt California', 'https://www.facebook.com/groups/nvca16', null, 185000, 'viet-kieu', 85],
        ['Người Việt Ở Cali', 'https://www.facebook.com/groups/nnguoivietocali', null, 175000, 'viet-kieu', 85],
        ['Người Việt California (2)', 'https://www.facebook.com/groups/553046501564243', '553046501564243', 72000, 'viet-kieu', 82],
        ['Cộng đồng người Việt ở California', 'https://www.facebook.com/groups/congdongnguoivietocalifornia7', null, 139000, 'viet-kieu', 83],
        ['CHỢ NGƯỜI VIỆT TẠI CALIFORNIA', 'https://www.facebook.com/groups/chonguoiviettaicalifornia', null, 2600, 'viet-kieu', 70],
        ['CỘNG ĐỒNG NGƯỜI VIỆT TẠI GEORGIA', 'https://www.facebook.com/groups/2167065630139164', '2167065630139164', 0, 'viet-kieu', 65],
        ['Cộng đồng người Việt ở Georgia', 'https://www.facebook.com/groups/1130116142283766', '1130116142283766', 0, 'viet-kieu', 65],
        ['Người Việt Florida', 'https://www.facebook.com/groups/nguoivietfloridaus', null, 0, 'viet-kieu', 68],
        ['CỘNG ĐỒNG NGƯỜI VIỆT TẠI FLORIDA', 'https://www.facebook.com/groups/congdongnguoivietnamtaiflorida', null, 0, 'viet-kieu', 68],
        ['CỘNG ĐỒNG NGƯỜI VIỆT TẠI FLORIDA (2)', 'https://www.facebook.com/groups/2986035325038064', '2986035325038064', 0, 'viet-kieu', 66],
        ['Người Việt tại New York', 'https://www.facebook.com/groups/nguoiviettainewyorkusa', null, 0, 'viet-kieu', 68],
        ['CỘNG ĐỒNG NGƯỜI VIỆT TẠI NEW YORK', 'https://www.facebook.com/groups/705567617732009', '705567617732009', 0, 'viet-kieu', 68],
        ['CLB Người Việt tại New York - USA', 'https://www.facebook.com/groups/clbnguoiviettainewyork', null, 0, 'viet-kieu', 66],
        ['Người Việt tại California (GA)', 'https://www.facebook.com/groups/746114972440757', '746114972440757', 0, 'viet-kieu', 75],
        ['Người Việt tại Texas (ID)', 'https://www.facebook.com/groups/1462647001235516', '1462647001235516', 0, 'viet-kieu', 72],
        ['Vietnamese in America', 'https://www.facebook.com/groups/912111470098935', '912111470098935', 0, 'viet-kieu', 72],
        ['Việt Kiều Khắp Nơi', 'https://www.facebook.com/groups/329985287029', '329985287029', 0, 'viet-kieu', 75],
        ['Hội du học sinh VN tại Mỹ', 'https://www.facebook.com/groups/VietnamStudent.USA', null, 0, 'viet-kieu', 65],
        ['HỘI DU HỌC SINH VN TẠI MỸ', 'https://www.facebook.com/groups/326397573871586', '326397573871586', 0, 'viet-kieu', 65],
        ['HỘI DU HỌC SINH VN TẠI MỸ (2)', 'https://www.facebook.com/groups/3851671961729107', '3851671961729107', 0, 'viet-kieu', 64],
        ['Người Việt ở San Jose', 'https://www.facebook.com/groups/ngivitsanjose', null, 0, 'viet-kieu', 70],
        ['Cộng đồng người Việt tại Greensboro NC', 'https://www.facebook.com/groups/577034233473789', '577034233473789', 0, 'viet-kieu', 60],

        // === E-COMMERCE / FULFILLMENT (Cat 4) — Relevance 75-95 ===
        ['Amazon Seller Việt Nam', 'https://www.facebook.com/groups/amazonsellervietnam', null, 200000, 'ecommerce', 90],
        ['Cộng Đồng Amazon Seller VN', 'https://www.facebook.com/groups/congdongamazonsellervietnam', null, 100000, 'ecommerce', 90],
        ['Dropshipping - POD Vietnam', 'https://www.facebook.com/groups/273760436440263', '273760436440263', 50000, 'ecommerce', 88],
        ['Cộng đồng Shopify Việt Nam', 'https://www.facebook.com/groups/congdongshopifyvietnam', null, 0, 'ecommerce', 82],
        ['Shopify Việt Nam', 'https://www.facebook.com/groups/shopifyvn', null, 0, 'ecommerce', 80],
        ['Etsy Việt Nam', 'https://www.facebook.com/groups/etsyvietnam', null, 0, 'ecommerce', 78],
        ['Cộng đồng ETSY Việt Nam', 'https://www.facebook.com/groups/congdongetsyvietnam', null, 0, 'ecommerce', 76],
        ['eBay & Etsy Việt Nam', 'https://www.facebook.com/groups/ebayetsyvietnam', null, 0, 'ecommerce', 74],
        // Existing groups confirmed working
        ['Tìm Supplier Fulfill POD/Drop', 'https://www.facebook.com/groups/1312868109620530', '1312868109620530', 0, 'ecommerce', 92],
        ['Dropship & Fulfill VN', 'https://www.facebook.com/groups/646444174604027', '646444174604027', 0, 'ecommerce', 88],
        ['TikTok Shop US Underground', 'https://www.facebook.com/groups/1631859190422638', '1631859190422638', 0, 'ecommerce', 88],
        ['Seller E-commerce VN', 'https://www.facebook.com/groups/494286704652111', '494286704652111', 0, 'ecommerce', 80],
        ['Cộng đồng Amazon VN', 'https://www.facebook.com/groups/congdongamazonvn', null, 0, 'ecommerce', 82],
        ['POD Vietnam Sellers', 'https://www.facebook.com/groups/112253537621629', '112253537621629', 0, 'ecommerce', 80],
        ['Amazon FBA Vietnam', 'https://www.facebook.com/groups/430998570008556', '430998570008556', 0, 'ecommerce', 82],
        ['Shopify & Dropship VN', 'https://www.facebook.com/groups/514921692619278', '514921692619278', 0, 'ecommerce', 78],

        // === MARKETPLACE / CHỢ VIỆT (Cat 5) — Relevance 60-78 ===
        ['Chợ mua bán Việt-Mỹ', 'https://www.facebook.com/groups/394365487374435', '394365487374435', 3300, 'marketplace', 75],
        ['Hội Mua Bán - Vận Chuyển Mỹ Việt', 'https://www.facebook.com/groups/muabanvanchuyenmyviet', null, 0, 'marketplace', 72],
        ['Kinh Doanh Online Việt', 'https://www.facebook.com/groups/kinhdoanhonlineviet', null, 0, 'marketplace', 65],
        ['HỘI KINH DOANH ONLINE', 'https://www.facebook.com/groups/hoikinhdoanhonline', null, 0, 'marketplace', 62],
        ['Cộng Đồng Bán Hàng Online VN', 'https://www.facebook.com/groups/congtien.vn', null, 0, 'marketplace', 62],
        ['CHỢ KINH DOANH ONLINE', 'https://www.facebook.com/groups/chokinhdoanhonlinevietnam', null, 0, 'marketplace', 60],
        ['Chợ Việt Tại Mỹ - USA', 'https://www.facebook.com/groups/choviettaimyusa', null, 0, 'marketplace', 72],
        ['Chợ Việt Tại Mỹ - USA (2)', 'https://www.facebook.com/groups/nguoiviettaimyusaa', null, 0, 'marketplace', 70],
        ['Người Việt Mua Bán Tại Houston', 'https://www.facebook.com/groups/nguoivietmuabantaihoustontexasusa', null, 0, 'marketplace', 68],
        ['Người Việt Mua Bán Houston (2)', 'https://www.facebook.com/groups/1759332501538277', '1759332501538277', 0, 'marketplace', 66],
        ['Người Việt Bolsa / OC', 'https://www.facebook.com/groups/943184966968506', '943184966968506', 0, 'marketplace', 68],
        ['Người Việt Bolsa / OC (2)', 'https://www.facebook.com/groups/586925666725063', '586925666725063', 0, 'marketplace', 66],
        ['Người Việt Bolsa/Orange County', 'https://www.facebook.com/groups/nguoivietorangecounty', null, 0, 'marketplace', 65],
        ['Vietnamese in OC / Người Việt quận Cam', 'https://www.facebook.com/groups/1260392491241184', '1260392491241184', 0, 'marketplace', 65],
        ['Hội Người Việt Bolsa / Orange County', 'https://www.facebook.com/groups/759047485018056', '759047485018056', 0, 'marketplace', 65],
        ['Người Việt San Jose - Mua Bán', 'https://www.facebook.com/groups/425102139960929', '425102139960929', 0, 'marketplace', 65],
        ['Mua Bán Tại San Jose California', 'https://www.facebook.com/groups/1090116142283766', '1090116142283766', 0, 'marketplace', 63],
        // Existing confirmed
        ['Đặt Hàng TQ Giao US/EU', 'https://www.facebook.com/groups/1157826901501932', '1157826901501932', 0, 'tq-goods', 92],
        ['Đặt Hàng TQ Ship ĐNA & US', 'https://www.facebook.com/groups/778601457112289', '778601457112289', 0, 'tq-goods', 90],
        ['Vận chuyển Quốc tế VN', 'https://www.facebook.com/groups/914341367037223', '914341367037223', 0, 'logistics', 82],
        ['Du học sinh VN tại Mỹ', 'https://www.facebook.com/groups/888744671201380', '888744671201380', 0, 'viet-kieu', 70],
        ['Cộng Đồng Người Việt tại Mỹ', 'https://www.facebook.com/groups/238061523539498', '238061523539498', 0, 'viet-kieu', 78],
        ['Người Việt NC USA', 'https://www.facebook.com/groups/696936451159951', '696936451159951', 0, 'viet-kieu', 72],
    ];

    const insertMany = _db.transaction((rows) => {
        for (const [name, url, group_id, member_count, category, relevance_score] of rows) {
            insert.run(name, url, group_id, member_count, category, relevance_score);
        }
    });
    insertMany(groups);
}

// ════════════════════════════════════════════════════════
// Sync top groups → config.FB_TARGET_GROUPS dynamically
// Called by scraperEngine to always use DB-driven list
// ════════════════════════════════════════════════════════
function getScanRotationList(limit = 30) {
    const groups = getDb().prepare(`
        SELECT name, url FROM fb_groups
        WHERE status = 'active' AND relevance_score >= 60 AND group_id IS NOT NULL
        ORDER BY relevance_score DESC, last_scanned_at ASC NULLS FIRST
        LIMIT ?
    `).all(limit);
    return groups.map(g => ({ name: g.name, url: g.url }));
}

module.exports = {
    getDb,
    upsertGroup,
    getActiveGroups,
    getTopGroups,
    getAllGroups,
    getScanRotationList,
    markScanned,
    updateScore,
    setStatus,
    getStats,
    extractGroupId,
};
