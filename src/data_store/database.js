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
`);

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


const insertLead = db.prepare(`
  INSERT OR IGNORE INTO leads (platform, post_url, author_name, author_url, author_avatar, content, score, category, summary, urgency, suggested_response, role, buyer_signals, scraped_at, post_created_at, profit_estimate, gap_opportunity, pain_score, spam_score)
  VALUES (@platform, @post_url, @author_name, @author_url, @author_avatar, @content, @score, @category, @summary, @urgency, @suggested_response, @role, @buyer_signals, @scraped_at, @post_created_at, @profit_estimate, @gap_opportunity, @pain_score, @spam_score)
`);

const getLeads = (filters = {}) => {
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = {};

  if (filters.platform) {
    query += ' AND platform = @platform';
    params.platform = filters.platform;
  }
  if (filters.category) {
    if (filters.category === 'Fulfill') {
      query += " AND category IN ('THG Fulfillment', 'Fulfillment', 'POD', 'Dropship', 'THG Fulfill')";
    } else if (filters.category === 'Express') {
      query += " AND category IN ('THG Express', 'Express')";
    } else if (filters.category === 'Warehouse') {
      query += " AND category IN ('THG Warehouse', 'Warehouse')";
    } else if (filters.category === 'General') {
      query += " AND (category IN ('General', 'NotRelevant') OR category IS NULL OR category = '')";
    } else {
      query += ' AND category = @category';
      params.category = filters.category;
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

const getStats = () => {
  const total = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status != 'ignored'").get();
  const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM leads WHERE status != 'ignored' GROUP BY status").all();
  const byPlatform = db.prepare("SELECT platform, COUNT(*) as count FROM leads WHERE status != 'ignored' GROUP BY platform").all();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM leads WHERE status != 'ignored' GROUP BY category").all();
  const avgScore = db.prepare("SELECT AVG(score) as avg_score FROM leads WHERE score > 0 AND status != 'ignored'").get();
  const today = db.prepare("SELECT COUNT(*) as count FROM leads WHERE date(created_at) = date('now') AND status != 'ignored'").get();
  const highValue = db.prepare("SELECT COUNT(*) as count FROM leads WHERE score >= 80 AND status != 'ignored'").get();

  return {
    total: total.count,
    today: today.count,
    highValue: highValue.count,
    avgScore: Math.round(avgScore.avg_score || 0),
    byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
    byPlatform: Object.fromEntries(byPlatform.map(r => [r.platform, r.count])),
    byCategory: Object.fromEntries(byCategory.map(r => [r.category || 'unknown', r.count])),
  };
};

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

// --- Deduplication: Get all known post URLs and content hashes ---
const getExistingPostUrls = () => {
  const rows = db.prepare(`SELECT post_url FROM leads WHERE post_url IS NOT NULL AND post_url != ''`).all();
  return new Set(rows.map(r => r.post_url));
};

const getExistingContentHashes = () => {
  const rows = db.prepare(`SELECT SUBSTR(content, 1, 100) as hash FROM leads WHERE content IS NOT NULL`).all();
  return new Set(rows.map(r => r.hash));
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
  // Deduplication
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
  db,
};


