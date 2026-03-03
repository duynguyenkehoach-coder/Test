const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
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

// --- Prepared statements ---

const insertLead = db.prepare(`
  INSERT OR IGNORE INTO leads (platform, post_url, author_name, author_url, author_avatar, content, score, category, summary, urgency, suggested_response, role, buyer_signals, scraped_at, post_created_at)
  VALUES (@platform, @post_url, @author_name, @author_url, @author_avatar, @content, @score, @category, @summary, @urgency, @suggested_response, @role, @buyer_signals, @scraped_at, @post_created_at)
`);

const getLeads = (filters = {}) => {
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = {};

  if (filters.platform) {
    query += ' AND platform = @platform';
    params.platform = filters.platform;
  }
  if (filters.category) {
    query += ' AND category = @category';
    params.category = filters.category;
  }
  if (filters.status) {
    query += ' AND status = @status';
    params.status = filters.status;
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
  const total = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all();
  const byPlatform = db.prepare('SELECT platform, COUNT(*) as count FROM leads GROUP BY platform').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM leads GROUP BY category').all();
  const avgScore = db.prepare('SELECT AVG(score) as avg_score FROM leads WHERE score > 0').get();
  const today = db.prepare("SELECT COUNT(*) as count FROM leads WHERE date(created_at) = date('now')").get();
  const highValue = db.prepare('SELECT COUNT(*) as count FROM leads WHERE score >= 80').get();

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
  // Deduplication
  getExistingPostUrls,
  getExistingContentHashes,
};
