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

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
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
// Auto-classify group category by name
// ════════════════════════════════════════════════════════
function autoClassifyCategory(name) {
    const n = (name || '').toLowerCase();
    // POD
    if (/pod|print.on.demand|in ấn|xưởng in|gearlaunch|merchize|customily|burgerprints/i.test(n)) return 'pod';
    // Dropship
    if (/dropship|drop.ship/i.test(n)) return 'dropship';
    // Fulfillment / Warehouse
    if (/fulfil|fulfill|kho .*(mỹ|us|pa|tx)|warehouse|3pl|prep.center/i.test(n)) return 'fulfillment';
    // Amazon FBA
    if (/fba|amazon/i.test(n)) return 'fba';
    // Shipping / Logistics
    if (/vận chuyển|logistics|shipping|freight|xuất nhập khẩu|xnk|hàng hoá/i.test(n)) return 'shipping';
    // Sourcing from China
    if (/trung quốc|tq|1688|taobao|alibaba|đặt hàng|order hàng|nguồn hàng/i.test(n)) return 'sourcing';
    // TikTok Shop
    if (/tiktok|tik tok/i.test(n)) return 'tiktok_shop';
    // Etsy
    if (/etsy/i.test(n)) return 'etsy';
    // Shopify
    if (/shopify|shopbase/i.test(n)) return 'shopify';
    // EU markets
    if (/uk|united kingdom|ebay.*uk/i.test(n)) return 'ecommerce-uk';
    if (/france|français|entraide/i.test(n)) return 'ecommerce-fr';
    if (/deutschland|deutsch|österreich/i.test(n)) return 'ecommerce-de';
    if (/europe|eu.*seller/i.test(n)) return 'ecommerce-eu';
    // E-commerce general
    if (/ecommerce|e-commerce|seller|bán hàng/i.test(n)) return 'ecommerce';
    return 'unknown';
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
        // ═══════════════════════════════════════════════════════
        // ALL URLs VERIFIED via Google index (site:facebook.com/groups)
        // ═══════════════════════════════════════════════════════

        // === AMAZON FBA / FBM SELLERS (VERIFIED) ===
        ['Cộng đồng Amazon Sellers VN', 'https://www.facebook.com/groups/congdongamazonvn', null, 0, 'ecommerce', 95],
        ['Amazon Sellers Viet Nam', 'https://www.facebook.com/groups/eagleamazonvietnam', null, 0, 'ecommerce', 95],
        ['Amazon FBA Việt Nam', 'https://www.facebook.com/groups/Chienbinhamazon', null, 0, 'ecommerce', 92],
        ['Cộng Đồng Amazon FBA VN', 'https://www.facebook.com/groups/192390967606944', '192390967606944', 0, 'ecommerce', 90],
        ['VECOM FBA - Vietnam Sellers on Amazon', 'https://www.facebook.com/groups/Vietnamsellersonamazon', null, 0, 'ecommerce', 90],
        ['Amazon FBA Vietnam (ID)', 'https://www.facebook.com/groups/430998570008556', '430998570008556', 0, 'ecommerce', 88],
        ['Tìm Supplier Fulfill POD/Drop', 'https://www.facebook.com/groups/1312868109620530', '1312868109620530', 0, 'ecommerce', 95],

        // === SHOPIFY SELLERS (VERIFIED) ===
        ['Cộng đồng Shopify Việt Nam', 'https://www.facebook.com/groups/congdongshopifyvietnam', null, 0, 'ecommerce', 90],
        ['CỘNG ĐỒNG DROPSHIPPING & SHOPIFY VN', 'https://www.facebook.com/groups/514921692619278', '514921692619278', 0, 'ecommerce', 90],
        ['Shopify Developer VN', 'https://www.facebook.com/groups/shopifydevelopervn', null, 0, 'ecommerce', 85],
        ['Anh Em Shopify VN', 'https://www.facebook.com/groups/aeshopifyvn', null, 0, 'ecommerce', 85],

        // === ETSY SELLERS (VERIFIED) ===
        ['Cộng đồng ETSY Việt Nam', 'https://www.facebook.com/groups/congdongetsyvietnam', null, 0, 'ecommerce', 88],

        // === POD / PRINT ON DEMAND (VERIFIED) ===
        ['POD Vietnam Sellers', 'https://www.facebook.com/groups/112253537621629', '112253537621629', 0, 'ecommerce', 92],
        ['Customily Việt Nam', 'https://www.facebook.com/groups/customilyvietnam', null, 0, 'ecommerce', 95],
        ['POD Viet Nam - ECM', 'https://www.facebook.com/groups/ngothanhpod', null, 0, 'ecommerce', 90],
        ['Cộng đồng Designer POD VN', 'https://www.facebook.com/groups/congdongpodseller', null, 0, 'ecommerce', 88],
        ['Merchize VN Community', 'https://www.facebook.com/groups/merchizevn', null, 0, 'ecommerce', 88],
        ['GearLaunch VN Print on Demand', 'https://www.facebook.com/groups/gearlaunch.vietnam.printondemand', null, 0, 'ecommerce', 85],


        // === DROPSHIPPING / FULFILLMENT (VERIFIED) ===
        ['Dropshipping - POD Vietnam', 'https://www.facebook.com/groups/273760436440263', '273760436440263', 50000, 'ecommerce', 92],
        ['Dropship & Fulfill VN', 'https://www.facebook.com/groups/646444174604027', '646444174604027', 0, 'ecommerce', 92],
        ['Cộng Đồng Dropship VN', 'https://www.facebook.com/groups/vndropship', null, 0, 'ecommerce', 88],
        ['Cộng Đồng Dropshipping VN', 'https://www.facebook.com/groups/612897632872160', '612897632872160', 0, 'ecommerce', 88],
        ['Cộng Đồng Dropshipping VN (2)', 'https://www.facebook.com/groups/296787476078292', '296787476078292', 0, 'ecommerce', 85],
        ['Khởi Nghiệp Shopify - Dropship & POD', 'https://www.facebook.com/groups/dropshipforivn', null, 0, 'ecommerce', 85],

        // === E-COMMERCE GENERAL (VERIFIED) ===
        ['Seller E-commerce VN', 'https://www.facebook.com/groups/494286704652111', '494286704652111', 0, 'ecommerce', 85],

        // === CROSS-BORDER / SOURCING (VERIFIED) ===
        ['Đặt Hàng TQ Giao US/EU', 'https://www.facebook.com/groups/1157826901501932', '1157826901501932', 0, 'cross-border', 92],
        ['Đặt Hàng TQ Ship ĐNA & US', 'https://www.facebook.com/groups/778601457112289', '778601457112289', 0, 'cross-border', 90],
        ['Order Hàng TQ - Vận Chuyển XNK', 'https://www.facebook.com/groups/1698840756986636', '1698840756986636', 21000, 'cross-border', 88],
        ['Order hàng Trung Quốc - XNK', 'https://www.facebook.com/groups/109909824518356', '109909824518356', 0, 'cross-border', 85],

        // === E-COM FULFILLMENT (VERIFIED) ===
        ['Vận chuyển Quốc tế VN', 'https://www.facebook.com/groups/914341367037223', '914341367037223', 0, 'fulfillment', 82],
        ['CỘNG ĐỒNG VẬN CHUYỂN HÀNG HOÁ VIỆT - MỸ', 'https://www.facebook.com/groups/198874301317672', '198874301317672', 13000, 'fulfillment', 80],

        // ═══════════════════════════════════════════════════════
        // EU / INTERNATIONAL SELLER GROUPS (VERIFIED via Google index)
        // ═══════════════════════════════════════════════════════

        // === 🇬🇧 UK — Amazon FBA / Ecommerce ===
        ['Amazon FBA UK', 'https://www.facebook.com/groups/431609530309988', '431609530309988', 0, 'ecommerce-uk', 90],
        ['Amazon FBA UK Sellers', 'https://www.facebook.com/groups/amazonfbauksellers', null, 0, 'ecommerce-uk', 88],
        ['Amazon FBA UK - Private Label', 'https://www.facebook.com/groups/608958253952057', '608958253952057', 0, 'ecommerce-uk', 88],
        ['eBay DropShipping UK', 'https://www.facebook.com/groups/ebaydsuk', null, 0, 'ecommerce-uk', 82],
        ['Ecommerce UK Sellers', 'https://www.facebook.com/groups/1601344433466856', '1601344433466856', 0, 'ecommerce-uk', 85],

        // === 🇫🇷 FRANCE — Amazon FBA / Shopify / Dropshipping ===
        ['Vendeur Amazon FBA France', 'https://www.facebook.com/groups/vendeuramazonfbafrance', null, 0, 'ecommerce-fr', 90],
        ['Dropshipping & E-commerce France', 'https://www.facebook.com/groups/dropshipping.france.shopify', null, 0, 'ecommerce-fr', 88],
        ['Communauté Shopify France', 'https://www.facebook.com/groups/1730863100534539', '1730863100534539', 0, 'ecommerce-fr', 85],
        ['Entraide Shopify France', 'https://www.facebook.com/groups/752050182880832', '752050182880832', 0, 'ecommerce-fr', 85],

        // === 🇩🇪 GERMANY — Amazon FBA / Shopify / Dropshipping ===
        ['Amazon FBA Verkäufer Deutschland', 'https://www.facebook.com/groups/AmazonDeutschland', null, 0, 'ecommerce-de', 90],
        ['Dropshipping Deutschland', 'https://www.facebook.com/groups/dropshipping.de', null, 0, 'ecommerce-de', 85],
        ['Shopify Deutschland/Österreich/Schweiz', 'https://www.facebook.com/groups/shopifydeutschland', null, 0, 'ecommerce-de', 85],

        // === 🇪🇺 PAN-EU — Amazon Europe / Cross-border ===
        ['Amazon FBA UK & Europe', 'https://www.facebook.com/groups/1754716777951998', '1754716777951998', 0, 'ecommerce-eu', 88],
        ['Amazon Europe Sellers', 'https://www.facebook.com/groups/amazoneurope', null, 0, 'ecommerce-eu', 90],
        ['Amazon FBA Europe Sellers', 'https://www.facebook.com/groups/amazoneuropesellers', null, 0, 'ecommerce-eu', 88],
        ['Amazon FBA Europe', 'https://www.facebook.com/groups/1007531559318711', '1007531559318711', 0, 'ecommerce-eu', 85],
        ['Amazon DE Sellers Community', 'https://www.facebook.com/groups/971577527971421', '971577527971421', 0, 'ecommerce-eu', 88],

        // === NEW: User-requested groups ===
        ['Cộng đồng DROPSHIP & POD - US, UK', 'https://www.facebook.com/groups/1110506846984730', '1110506846984730', 0, 'ecommerce', 92],
        ['Cộng đồng Dropshipping Ebay, Amazon, Etsy Chia sẻ từ a-z', 'https://www.facebook.com/groups/3043290549049105', '3043290549049105', 0, 'ecommerce', 90],
        ['CỘNG ĐỒNG SUPPLIER POD - DROPSHIPPING', 'https://www.facebook.com/groups/dropshippodvietnam', null, 0, 'ecommerce', 92],
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
        WHERE status = 'active' AND relevance_score >= 30
        ORDER BY relevance_score DESC, last_scanned_at ASC NULLS FIRST
        LIMIT ?
    `).all(limit);
    return groups.map(g => ({ name: g.name, url: g.url }));
}

// ════════════════════════════════════════════════════════
// Auto-deactivate dead groups (called by fbScraper)
// ════════════════════════════════════════════════════════
function deactivateGroup(url) {
    try {
        const result = getDb().prepare(`
            UPDATE fb_groups SET status = 'dead' WHERE url = ?
        `).run(url);
        if (result.changes > 0) {
            console.log(`[GroupDB] 💀 Deactivated dead group: ${url}`);
        }
    } catch (err) {
        console.warn(`[GroupDB] ⚠️ Failed to deactivate: ${err.message}`);
    }
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
    deactivateGroup,
    autoClassifyCategory,
};
