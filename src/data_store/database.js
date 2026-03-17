const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'leads.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    post_url TEXT UNIQUE,
    author_name TEXT,
    author_url TEXT,
    content TEXT,
    score INTEGER DEFAULT 0,
    category TEXT,
    summary TEXT,
    urgency TEXT DEFAULT 'low',
    suggested_response TEXT,
    status TEXT DEFAULT 'new',
    scraped_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT,
    keywords_used TEXT,
    posts_found INTEGER DEFAULT 0,
    leads_detected INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT DEFAULT 'running',
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS sv_credit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT,
    platform TEXT,
    source TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    sender_name TEXT DEFAULT 'Unknown',
    message TEXT NOT NULL,
    ai_suggestion TEXT,
    sale_reply TEXT,
    intent TEXT DEFAULT 'general',
    status TEXT DEFAULT 'pending',
    platform TEXT DEFAULT 'facebook',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score);
  CREATE INDEX IF NOT EXISTS idx_leads_platform ON leads(platform);
  CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);
  CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'sales',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`);

// ── Seed admin account from .env if users table is empty ──────────────────
(async () => {
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count === 0) {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPass = process.env.ADMIN_PASSWORD;
      const adminName = process.env.ADMIN_NAME || 'Admin';
      if (adminEmail && adminPass) {
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash(adminPass, 12);
        db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(adminName, adminEmail.toLowerCase(), hash, 'admin');
        console.log(`[Auth] Admin account seeded: ${adminEmail}`);
      }
    }
  } catch (e) { /* bcrypt not yet available on first require */ }
})();

// --- raw_leads staging table (CrawBot async pipeline) ---
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT UNIQUE NOT NULL,
      author      TEXT DEFAULT '',
      author_url  TEXT DEFAULT '',
      content     TEXT NOT NULL,
      platform    TEXT DEFAULT 'facebook',
      group_name  TEXT DEFAULT '',
      scraped_at  TEXT DEFAULT (datetime('now')),
      received_at TEXT DEFAULT (datetime('now')),
      status      TEXT DEFAULT 'PENDING',
      -- PENDING | PROCESSING | QUALIFIED | REJECTED
      reject_reason TEXT DEFAULT '',
      score       INTEGER DEFAULT 0,
      assigned_to TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_raw_leads_status ON raw_leads(status);
    CREATE INDEX IF NOT EXISTS idx_raw_leads_url    ON raw_leads(url);
  `);
} catch { /* table already exists */ }

// --- Scan Queue table (IPC between API server and Scraper Worker) ---
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type    TEXT NOT NULL DEFAULT 'FULL_SCAN',
      status      TEXT DEFAULT 'PENDING',
      platforms   TEXT DEFAULT 'facebook',
      max_posts   INTEGER DEFAULT 200,
      options     TEXT DEFAULT '{}',
      result      TEXT DEFAULT '',
      error       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      started_at  TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scan_queue_status ON scan_queue(status);
  `);
} catch { /* table already exists */ }

// --- Schema migration: add role & buyer_signals columns if missing ---
try {
  db.exec(`ALTER TABLE leads ADD COLUMN role TEXT DEFAULT 'irrelevant'`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN buyer_signals TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_role ON leads(role)`);
} catch { /* ignore */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN notes TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN contacted_at TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN converted_at TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN post_created_at TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN author_avatar TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN assigned_to TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN claimed_by TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN claimed_at TEXT`);
} catch { /* column already exists */ }

// --- Lead Bank columns (Phase: Data Collection) ---
try {
  db.exec(`ALTER TABLE leads ADD COLUMN pain_point TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN service_match TEXT DEFAULT 'None'`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN verification_status TEXT DEFAULT 'waiting'`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN original_post TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN source_group TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_verification ON leads(verification_status)`);
} catch { /* ignore */ }
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_service ON leads(service_match)`);
} catch { /* ignore */ }

// --- Multi-Sales Tracking & Revenue columns ---
try {
  db.exec(`ALTER TABLE leads ADD COLUMN deal_value REAL DEFAULT 0`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN winner_staff TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN closed_at TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN profit_estimate TEXT DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN gap_opportunity TEXT DEFAULT ''`);
} catch { /* column already exists */ }

// --- AI Language Targeting column ---
try {
  db.exec(`ALTER TABLE leads ADD COLUMN language TEXT DEFAULT 'foreign'`);
  // One-time data migration for existing rows (if they haven't been tagged yet)
  const isVietnamese = (text) => {
    if (!text) return false;
    return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
  };
  const unclassified = db.prepare("SELECT id, content FROM leads WHERE language = 'foreign'").all();
  if (unclassified.length > 0) {
    db.transaction(() => {
      const updateLang = db.prepare("UPDATE leads SET language = 'vietnamese' WHERE id = ?");
      for (const lead of unclassified) {
        if (isVietnamese(lead.content)) {
          updateLang.run(lead.id);
        }
      }
    })();
  }
} catch { /* column already exists or migration failed */ }

// --- Sales Activities table (interaction timeline) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    staff_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    note TEXT DEFAULT '',
    deal_value REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sa_lead ON sales_activities(lead_id);
  CREATE INDEX IF NOT EXISTS idx_sa_staff ON sales_activities(staff_name);
  CREATE INDEX IF NOT EXISTS idx_sa_action ON sales_activities(action_type);
`);

// --- Forbidden Keywords table (dynamic provider blocklist) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS forbidden_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL,
    category TEXT DEFAULT 'provider',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default forbidden keywords (INSERT OR IGNORE = safe to re-run)
const seedKeywords = [
  // Provider self-promotion
  ['bên mình nhận', 'provider'], ['bên em nhận', 'provider'],
  ['bên mình chuyên', 'provider'], ['bên em chuyên', 'provider'],
  ['chúng tôi chuyên', 'provider'], ['chúng mình chuyên', 'provider'],
  ['dịch vụ của bên mình', 'provider'], ['dịch vụ bên mình', 'provider'],
  // Pricing / catalog signals
  ['bảng giá', 'provider'], ['chiết khấu', 'provider'],
  ['tuyển sỉ', 'provider'], ['tuyển đại lý', 'provider'],
  ['hoa hồng', 'provider'], ['ưu đãi hấp dẫn', 'provider'],
  // Contact / CTA signals
  ['inbox báo giá', 'provider'], ['liên hệ báo giá', 'provider'],
  ['pm báo giá', 'provider'], ['nhắn tin báo giá', 'provider'],
  ['xin số điện thoại', 'provider'], ['để lại sđt', 'provider'],
  // Competitor service phrases
  ['hỗ trợ ship', 'provider'], ['nhận đặt hàng hộ', 'provider'],
  ['mua hàng hộ', 'provider'], ['checkout hộ', 'provider'],
  ['thanh toán hộ', 'provider'], ['agent tìm nguồn', 'provider'],
  ['fulfillment service', 'provider'], ['kho bãi chuyên nghiệp', 'provider'],
  // Spam/marketing
  ['xin phép ad', 'provider'], ['xin phép admin và', 'provider'],
];

const insertKw = db.prepare(`INSERT OR IGNORE INTO forbidden_keywords (keyword, category) VALUES (?, ?)`);
for (const [kw, cat] of seedKeywords) {
  try { insertKw.run(kw, cat); } catch (_) { }
}

// pain_score and spam_score on leads
try {
  db.exec(`ALTER TABLE leads ADD COLUMN pain_score INTEGER DEFAULT 0`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN spam_score INTEGER DEFAULT 0`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN item_type TEXT DEFAULT 'post'`);
} catch { /* column already exists */ }

// ─── Personal Agent Profiles ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_profiles (
    name        TEXT PRIMARY KEY,
    tone        TEXT DEFAULT 'friendly',
    personal_note TEXT DEFAULT '',
    deals_note  TEXT DEFAULT '',
    takeover    INTEGER DEFAULT 0,
    auto_reply  INTEGER DEFAULT 0,
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Seed 5 default profiles (INSERT OR IGNORE = safe to re-run)
const SALES_TEAM = ['Trang', 'Min', 'Moon', 'Lê Huyền', 'Ngọc Huyền'];
const seedAgent = db.prepare(`
  INSERT OR IGNORE INTO agent_profiles (name) VALUES (?)
`);
for (const name of SALES_TEAM) {
  try { seedAgent.run(name); } catch (_) { }
}

const getAgentProfiles = () =>
  db.prepare(`SELECT * FROM agent_profiles ORDER BY name`).all();

const getAgentProfile = (name) =>
  db.prepare(`SELECT * FROM agent_profiles WHERE name = ?`).get(name);

const saveAgentProfile = (name, { tone, personal_note, deals_note }) =>
  db.prepare(`
    UPDATE agent_profiles
    SET tone = @tone, personal_note = @personal_note, deals_note = @deals_note,
        updated_at = datetime('now')
    WHERE name = @name
  `).run({ name, tone: tone || 'friendly', personal_note: personal_note || '', deals_note: deals_note || '' });

const toggleAgentTakeover = (name) => {
  const row = getAgentProfile(name);
  if (!row) return null;
  const next = row.takeover ? 0 : 1;
  db.prepare(`UPDATE agent_profiles SET takeover = ?, updated_at = datetime('now') WHERE name = ?`).run(next, name);
  return next;
};

// ─── Migrations: extend agent_profiles ────────────────────────────────────
try { db.exec(`ALTER TABLE agent_profiles ADD COLUMN mode TEXT DEFAULT 'learning'`); } catch { }
try { db.exec(`ALTER TABLE agent_profiles ADD COLUMN avatar TEXT DEFAULT ''`); } catch { }

// ─── Chat History (source for style learning) ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_name  TEXT    NOT NULL,
    lead_id     INTEGER DEFAULT 0,
    direction   TEXT    NOT NULL,   -- 'sales' | 'customer'
    message     TEXT    NOT NULL,
    is_teaching INTEGER DEFAULT 0,  -- 1 = Sales đánh dấu "Dạy Agent"
    created_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_sales ON chat_history(sales_name, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_teach ON chat_history(sales_name, is_teaching);
`);

// ─── Sales Styles (AI-extracted tone profiles) ─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_styles (
    sales_name      TEXT PRIMARY KEY,
    tone_profile    TEXT DEFAULT '{}',   -- JSON: greeting, pronouns, icons, formality, avg_length
    writing_samples TEXT DEFAULT '[]',   -- JSON array: 10-20 câu mẫu tốt nhất
    sample_count    INTEGER DEFAULT 0,
    last_extracted  TEXT DEFAULT '',
    updated_at      TEXT DEFAULT (datetime('now'))
  );
`);

// Seed styles row for each agent (safe to re-run)
const seedStyle = db.prepare(`INSERT OR IGNORE INTO sales_styles (sales_name) VALUES (?)`);
for (const name of SALES_TEAM) {
  try { seedStyle.run(name); } catch (_) { }
}

// ─── chat_history helpers ──────────────────────────────────────────────────
const logChatMessage = (salesName, leadId, direction, message, isTeaching = 0) =>
  db.prepare(`
    INSERT INTO chat_history (sales_name, lead_id, direction, message, is_teaching)
    VALUES (?, ?, ?, ?, ?)
  `).run(salesName, leadId || 0, direction, message, isTeaching ? 1 : 0);

const getRecentChats = (salesName, limit = 50) =>
  db.prepare(`
    SELECT * FROM chat_history
    WHERE sales_name = ? AND direction = 'sales'
    ORDER BY created_at DESC LIMIT ?
  `).all(salesName, limit);

const getTeachingSamples = (salesName) =>
  db.prepare(`
    SELECT message FROM chat_history
    WHERE sales_name = ? AND is_teaching = 1 AND direction = 'sales'
    ORDER BY created_at DESC LIMIT 20
  `).all(salesName).map(r => r.message);

const markTeachingSample = (chatId) =>
  db.prepare(`UPDATE chat_history SET is_teaching = 1 WHERE id = ?`).run(chatId);

const getSalesStyle = (salesName) =>
  db.prepare(`SELECT * FROM sales_styles WHERE sales_name = ?`).get(salesName);

const saveSalesStyle = (salesName, toneProfile, writingSamples, sampleCount) =>
  db.prepare(`
    UPDATE sales_styles
    SET tone_profile = ?, writing_samples = ?, sample_count = ?,
        last_extracted = datetime('now'), updated_at = datetime('now')
    WHERE sales_name = ?
  `).run(JSON.stringify(toneProfile), JSON.stringify(writingSamples), sampleCount, salesName);


// ─── Gamification: Sales Performance & Points ─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_performance (
    name         TEXT PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    deals_closed INTEGER DEFAULT 0,
    total_revenue REAL   DEFAULT 0,
    rank_level   TEXT    DEFAULT 'ROOKIE',
    streak_days  INTEGER DEFAULT 0,
    last_action  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS points_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_name   TEXT    NOT NULL,
    action_type  TEXT    NOT NULL,
    points       INTEGER NOT NULL DEFAULT 0,
    deal_value   REAL    DEFAULT 0,
    lead_id      INTEGER DEFAULT 0,
    note         TEXT    DEFAULT '',
    created_at   TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plog_sales ON points_log(sales_name);
  CREATE INDEX IF NOT EXISTS idx_plog_ts    ON points_log(created_at);
`);

// Seed 5 sales into performance table
const seedPerf = db.prepare(`INSERT OR IGNORE INTO sales_performance (name) VALUES (?)`);
for (const name of SALES_TEAM) {
  try { seedPerf.run(name); } catch (_) { }
}

const RANK_THRESHOLDS = [
  { level: 'HUNTER', min: 3000 },
  { level: 'LEGEND', min: 1500 },
  { level: 'ELITE', min: 500 },
  { level: 'ROOKIE', min: 0 },
];

function getRankLevel(points) {
  return RANK_THRESHOLDS.find(r => points >= r.min)?.level || 'ROOKIE';
}

function awardPoints(salesName, actionType, points, { dealValue = 0, leadId = 0, note = '' } = {}) {
  // Insert log entry
  db.prepare(`
    INSERT INTO points_log (sales_name, action_type, points, deal_value, lead_id, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(salesName, actionType, points, dealValue, leadId, note);

  // Ensure row exists
  db.prepare(`INSERT OR IGNORE INTO sales_performance (name) VALUES (?)`).run(salesName);

  // Update totals
  const isCloseDeal = actionType === 'CLOSE_DEAL';
  db.prepare(`
    UPDATE sales_performance
    SET total_points  = total_points + ?,
        deals_closed  = deals_closed + ?,
        total_revenue = total_revenue + ?,
        last_action   = datetime('now')
    WHERE name = ?
  `).run(points, isCloseDeal ? 1 : 0, dealValue, salesName);

  // Recompute rank
  const row = db.prepare(`SELECT total_points FROM sales_performance WHERE name = ?`).get(salesName);
  if (row) {
    const newRank = getRankLevel(row.total_points);
    db.prepare(`UPDATE sales_performance SET rank_level = ? WHERE name = ?`).run(newRank, salesName);
  }

  return { salesName, actionType, points, dealValue };
}

const getLeaderboard = () => {
  const rankings = db.prepare(`
    SELECT name, total_points, deals_closed, total_revenue, rank_level, streak_days, last_action
    FROM sales_performance
    ORDER BY total_points DESC
  `).all();
  const recentLog = db.prepare(`
    SELECT * FROM points_log ORDER BY created_at DESC LIMIT 30
  `).all();
  return { rankings, recentLog };
};

const getPointsLog = (limit = 20) =>
  db.prepare(`SELECT * FROM points_log ORDER BY created_at DESC LIMIT ?`).all(limit);

// --- Prepared statements ---


const _insertLeadStmt = db.prepare(`
  INSERT OR IGNORE INTO leads (platform, post_url, author_name, author_url, author_avatar, content, score, category, summary, urgency, suggested_response, role, buyer_signals, scraped_at, post_created_at, profit_estimate, gap_opportunity, pain_score, spam_score, item_type, language)
  VALUES (@platform, @post_url, @author_name, @author_url, @author_avatar, @content, @score, @category, @summary, @urgency, @suggested_response, @role, @buyer_signals, @scraped_at, @post_created_at, @profit_estimate, @gap_opportunity, @pain_score, @spam_score, @item_type, @language)
`);

const insertLead = {
  run: (lead) => {
    const isVietnamese = (text) => {
      if (!text) return false;
      return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
    };
    const lang = lead.language || (isVietnamese(lead.content) ? 'vietnamese' : 'foreign');
    return _insertLeadStmt.run({ ...lead, language: lang });
  }
};

// Dashboard columns — only fields needed for list view (skip heavy content/suggested_response)
const LEADS_LIST_COLS = `id, platform, author_name, author_url, author_avatar, post_url,
  score, category, summary, urgency, status, role, source_group,
  assigned_to, claimed_by, claimed_at, deal_value, winner_staff,
  pain_score, spam_score, item_type, notes, language, created_at, post_created_at`;

const getLeads = (filters = {}) => {
  let query = `SELECT ${LEADS_LIST_COLS} FROM leads WHERE 1=1`;
  const params = {};

  // ── GLOBAL: Always exclude NotRelevant + error leads from dashboard ──
  query += " AND (category IS NULL OR category != 'NotRelevant')";
  query += " AND (summary IS NULL OR summary NOT LIKE '%Lỗi phân tích%')";
  query += " AND role != 'provider'";

  if (filters.platform) {
    query += ' AND platform = @platform';
    params.platform = filters.platform;
  }
  if (filters.language) {
    query += ' AND language = @language';
    params.language = filters.language;
  }
  if (filters.category) {
    const cat = filters.category;
    // Support both exact DB values ('THG Fulfillment') and nav shorthand ('Fulfill')
    if (cat === 'THG Fulfillment' || cat === 'Fulfill') {
      query += " AND category IN ('THG Fulfillment', 'Fulfillment', 'POD', 'Dropship', 'THG Fulfill')";
    } else if (cat === 'THG Express' || cat === 'Express') {
      query += " AND category IN ('THG Express', 'Express')";
    } else if (cat === 'THG Warehouse' || cat === 'Warehouse') {
      query += " AND category IN ('THG Warehouse', 'Warehouse')";
    } else if (cat === 'General') {
      query += " AND (category IN ('General') OR category IS NULL OR category = '')";
    } else {
      // Fallback: LIKE search so partial names still match
      query += ' AND category LIKE @category';
      params.category = `%${cat}%`;
    }
  }
  if (filters.status) {
    query += ' AND status = @status';
    params.status = filters.status;
  } else if (filters.exclude_ignored === 'true' || filters.exclude_ignored === true) {
    query += " AND status != 'ignored'";
  }
  if (filters.minScore) {
    query += ' AND score >= @minScore';
    params.minScore = filters.minScore;
  }
  if (filters.search) {
    query += ' AND (content LIKE @search OR summary LIKE @search OR author_name LIKE @search)';
    params.search = `%${filters.search}%`;
  }
  if (filters.role) {
    query += ' AND role = @role';
    params.role = filters.role;
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT @limit';
    params.limit = filters.limit;
  }
  if (filters.offset) {
    query += ' OFFSET @offset';
    params.offset = filters.offset;
  }

  return db.prepare(query).all(params);
};

const getLeadById = db.prepare('SELECT * FROM leads WHERE id = ?');

const updateLeadStatus = db.prepare(`
  UPDATE leads SET status = @status, notes = COALESCE(@notes, notes),
  suggested_response = COALESCE(@suggested_response, suggested_response),
  contacted_at = CASE WHEN @status = 'contacted' AND contacted_at IS NULL THEN datetime('now') ELSE contacted_at END,
  converted_at = CASE WHEN @status = 'converted' AND converted_at IS NULL THEN datetime('now') ELSE converted_at END,
  updated_at = datetime('now') WHERE id = @id
`);

// ── Optimized getStats() — 4 queries instead of 7 (CTE aggregation) ──────────
const _statsSummary = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN language = 'vietnamese' THEN 1 ELSE 0 END) as totalViet,
    SUM(CASE WHEN language = 'foreign' THEN 1 ELSE 0 END) as totalForeign,
    SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today,
    SUM(CASE WHEN score >= 80 THEN 1 ELSE 0 END) as highValue,
    ROUND(AVG(CASE WHEN score > 0 THEN score END)) as avgScore
  FROM leads WHERE status != 'ignored'
`);
const _statsByStatus = db.prepare("SELECT status, COUNT(*) as count FROM leads WHERE status != 'ignored' GROUP BY status");
const _statsByPlatform = db.prepare("SELECT platform, COUNT(*) as count FROM leads WHERE status != 'ignored' GROUP BY platform");
const _statsByCategory = db.prepare("SELECT category, COUNT(*) as count FROM leads WHERE status != 'ignored' GROUP BY category");

const getStats = () => {
  const summary = _statsSummary.get();
  const byStatus = _statsByStatus.all();
  const byPlatform = _statsByPlatform.all();
  const byCategory = _statsByCategory.all();

  return {
    total: summary.total || 0,
    totalViet: summary.totalViet || 0,
    totalForeign: summary.totalForeign || 0,
    today: summary.today || 0,
    highValue: summary.highValue || 0,
    avgScore: Math.round(summary.avgScore || 0),
    byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
    byPlatform: Object.fromEntries(byPlatform.map(r => [r.platform, r.count])),
    byCategory: Object.fromEntries(byCategory.map(r => [r.category || 'unknown', r.count])),
  };
};

// ── Stats Cache (TTL 30s) — avoids re-querying on every dashboard poll ────────
let _statsCache = null;
let _statsCacheTime = 0;
const STATS_CACHE_TTL = 30_000; // 30 seconds

const getStatsCached = () => {
  const now = Date.now();
  if (_statsCache && (now - _statsCacheTime) < STATS_CACHE_TTL) return _statsCache;
  _statsCache = getStats();
  _statsCacheTime = now;
  return _statsCache;
};

// Invalidate cache when leads change (called after insert/update/delete)
const invalidateStatsCache = () => { _statsCache = null; _statsCacheTime = 0; };

const insertScanLog = db.prepare(`
  INSERT INTO scan_logs (platform, keywords_used, posts_found, leads_detected, status)
  VALUES (@platform, @keywords_used, @posts_found, @leads_detected, @status)
`);

const updateScanLog = db.prepare(`
  UPDATE scan_logs SET posts_found = @posts_found, leads_detected = @leads_detected,
  finished_at = datetime('now'), status = @status, error = @error WHERE id = @id
`);

const getRecentScans = db.prepare(`
  SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT 20
`);

// --- Conversation statements ---

const insertConversation = db.prepare(`
  INSERT INTO conversations (sender_id, sender_name, message, ai_suggestion, intent, platform)
  VALUES (@sender_id, @sender_name, @message, @ai_suggestion, @intent, @platform)
`);

const getConversations = (filters = {}) => {
  let query = 'SELECT * FROM conversations WHERE 1=1';
  const params = {};
  if (filters.status) {
    query += ' AND status = @status';
    params.status = filters.status;
  }
  if (filters.platform) {
    query += ' AND platform = @platform';
    params.platform = filters.platform;
  }
  query += ' ORDER BY created_at DESC';
  if (filters.limit) {
    query += ' LIMIT @limit';
    params.limit = filters.limit;
  }
  return db.prepare(query).all(params);
};

const getConversationById = db.prepare('SELECT * FROM conversations WHERE id = ?');

const updateConversation = db.prepare(`
  UPDATE conversations SET sale_reply = @sale_reply, status = @status, updated_at = datetime('now')
  WHERE id = @id
`);

const getConversationStats = () => {
  const total = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  const pending = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = 'pending'").get();
  const replied = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = 'replied'").get();
  return { total: total.count, pending: pending.count, replied: replied.count };
};

const getAnalytics = () => {
  // Leads per day (last 14 days)
  const leadsPerDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM leads WHERE created_at >= date('now', '-14 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all();

  // Conversion funnel
  const funnel = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads GROUP BY status
  `).all();

  // Platform distribution
  const platforms = db.prepare(`
    SELECT platform, COUNT(*) as count FROM leads GROUP BY platform ORDER BY count DESC
  `).all();

  // Score distribution
  const scoreRanges = db.prepare(`
    SELECT
      SUM(CASE WHEN score >= 80 THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN score >= 60 AND score < 80 THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN score < 60 THEN 1 ELSE 0 END) as low
    FROM leads
  `).get();

  // Avg score per day
  const avgScorePerDay = db.prepare(`
    SELECT date(created_at) as day, ROUND(AVG(score)) as avg_score, COUNT(*) as count
    FROM leads WHERE created_at >= date('now', '-14 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all();

  return { leadsPerDay, funnel, platforms, scoreRanges, avgScorePerDay };
};

// --- Deduplication: DB-level via UNIQUE constraint on post_url ---
// INSERT OR IGNORE handles dedup at disk level (no RAM needed).
// Legacy functions kept as lightweight stubs for backward compatibility.
const getExistingPostUrls = () => {
  // DEPRECATED: Use INSERT OR IGNORE instead of pre-loading all URLs into RAM.
  // Kept for backward compat — returns empty Set to skip JS-side dedup.
  return new Set();
};

const getExistingContentHashes = () => {
  // DEPRECATED: Use INSERT OR IGNORE instead of pre-loading all hashes into RAM.
  return new Set();
};

// ── Scan Queue helpers (IPC between API server ↔ Scraper Worker) ─────────────
const enqueueScan = (jobType = 'FULL_SCAN', options = {}) => {
  return db.prepare(`
    INSERT INTO scan_queue (job_type, platforms, max_posts, options)
    VALUES (?, ?, ?, ?)
  `).run(
    jobType,
    options.platforms ? (Array.isArray(options.platforms) ? options.platforms.join(',') : options.platforms) : 'facebook',
    options.maxPosts || 200,
    JSON.stringify(options)
  );
};

const claimNextScan = () => {
  // Atomically claim the oldest PENDING job
  const job = db.prepare(`SELECT * FROM scan_queue WHERE status = 'PENDING' ORDER BY id ASC LIMIT 1`).get();
  if (!job) return null;
  db.prepare(`UPDATE scan_queue SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?`).run(job.id);
  return { ...job, options: JSON.parse(job.options || '{}') };
};

const completeScan = (id, result = {}) => {
  db.prepare(`UPDATE scan_queue SET status = 'DONE', result = ?, finished_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(result), id);
};

const failScan = (id, error = '') => {
  db.prepare(`UPDATE scan_queue SET status = 'ERROR', error = ?, finished_at = datetime('now') WHERE id = ?`)
    .run(String(error), id);
};

const getScanQueueStatus = () => {
  return db.prepare(`SELECT status, COUNT(*) as count FROM scan_queue GROUP BY status`).all();
};

// --- SociaVault Credits ---
const logCreditUsage = (endpoint, platform, source) => {
  return db.prepare(`
    INSERT INTO sv_credit_logs (endpoint, platform, source, timestamp)
    VALUES (?, ?, ?, datetime('now'))
  `).run(endpoint, platform, source);
};

const getCreditStats = () => {
  const today = db.prepare(`
    SELECT COUNT(*) as count FROM sv_credit_logs
    WHERE date(timestamp) = date('now')
  `).get().count;

  const total = db.prepare(`SELECT COUNT(*) as count FROM sv_credit_logs`).get().count;

  const thisMonth = db.prepare(`
    SELECT COUNT(*) as count FROM sv_credit_logs
    WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
  `).get().count;

  const firstCall = db.prepare(`SELECT timestamp FROM sv_credit_logs ORDER BY id ASC LIMIT 1`).get()?.timestamp || null;
  const lastCall = db.prepare(`SELECT timestamp FROM sv_credit_logs ORDER BY id DESC LIMIT 1`).get()?.timestamp || null;

  const platformsRows = db.prepare(`
    SELECT platform, COUNT(*) as count FROM sv_credit_logs
    GROUP BY platform ORDER BY count DESC
  `).all();

  const by_platform = {};
  for (const r of platformsRows) {
    by_platform[r.platform] = r.count;
  }

  return {
    today,
    total_logged: total,
    this_month: thisMonth,
    first_call: firstCall,
    last_call: lastCall,
    by_platform
  };
};

const getCreditLog = () => {
  return db.prepare(`
    SELECT * FROM sv_credit_logs 
    ORDER BY id DESC LIMIT 500
  `).all();
};

module.exports = {
  db,
  insertLead,
  getLeads,
  getLeadById,
  updateLeadStatus,
  getStats,
  getStatsCached,
  invalidateStatsCache,
  getAnalytics,
  insertScanLog,
  updateScanLog,
  getRecentScans,
  // Conversations
  insertConversation,
  getConversations,
  getConversationById,
  updateConversation,
  getConversationStats,
  // Credits
  logCreditUsage,
  getCreditStats,
  getCreditLog,
  // Deduplication (deprecated — use INSERT OR IGNORE)
  getExistingPostUrls,
  getExistingContentHashes,
  // Agent Profiles
  getAgentProfiles,
  getAgentProfile,
  saveAgentProfile,
  toggleAgentTakeover,
  // Gamification
  awardPoints,
  getLeaderboard,
  getPointsLog,
  // Chat history & style learning
  logChatMessage,
  getRecentChats,
  getTeachingSamples,
  markTeachingSample,
  getSalesStyle,
  saveSalesStyle,
  // Scan Queue (IPC)
  enqueueScan,
  claimNextScan,
  completeScan,
  failScan,
  getScanQueueStatus,
};


