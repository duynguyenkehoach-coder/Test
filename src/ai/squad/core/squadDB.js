/**
 * Squad Database — Task queue + Action log for Multi-Agent Squad
 * Uses existing leads.db (same database instance).
 * 
 * @module squad/core/squadDB
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'leads.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ═══ Create Squad Tables ═══
db.exec(`
    CREATE TABLE IF NOT EXISTS squad_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT NOT NULL,
        target_url TEXT,
        content_template TEXT DEFAULT '',
        assigned_account TEXT DEFAULT '',
        status TEXT DEFAULT 'PENDING',
        result TEXT DEFAULT '',
        error TEXT DEFAULT '',
        lead_id INTEGER DEFAULT 0,
        keyword_matched TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_squad_tasks_status ON squad_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_squad_tasks_type ON squad_tasks(task_type);
    CREATE INDEX IF NOT EXISTS idx_squad_tasks_url ON squad_tasks(target_url);

    CREATE TABLE IF NOT EXISTS squad_action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_url TEXT DEFAULT '',
        success INTEGER DEFAULT 1,
        comment_text TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_squad_log_account ON squad_action_log(account);
    CREATE INDEX IF NOT EXISTS idx_squad_log_type ON squad_action_log(action_type);
    CREATE INDEX IF NOT EXISTS idx_squad_log_date ON squad_action_log(created_at);
`);

// ═══ Task Queue Functions ═══

/**
 * Push a new task into the queue (from Scraper pipeline)
 * Uses INSERT OR IGNORE to prevent duplicate targets.
 */
function pushTask(taskType, targetUrl, opts = {}) {
    try {
        // Check for existing PENDING task with same URL
        const existing = db.prepare(
            `SELECT id FROM squad_tasks WHERE target_url = ? AND status = 'PENDING'`
        ).get(targetUrl);
        if (existing) return null; // Already queued

        const result = db.prepare(`
            INSERT INTO squad_tasks (task_type, target_url, content_template, assigned_account, lead_id, keyword_matched)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            taskType,
            targetUrl,
            opts.template || '',
            opts.account || '',
            opts.leadId || 0,
            opts.keyword || ''
        );
        console.log(`[SquadDB] 📥 Task #${result.lastInsertRowid}: ${taskType} → ${targetUrl.substring(0, 60)}`);
        return result.lastInsertRowid;
    } catch (e) {
        console.warn(`[SquadDB] ⚠️ pushTask error: ${e.message}`);
        return null;
    }
}

/**
 * Get next pending task (atomic claim)
 * @param {string} taskType - 'comment' or 'post' (optional filter)
 */
function claimNextTask(taskType = null) {
    let query = `SELECT * FROM squad_tasks WHERE status = 'PENDING'`;
    if (taskType) query += ` AND task_type = ?`;
    query += ` ORDER BY created_at ASC LIMIT 1`;

    const task = taskType
        ? db.prepare(query).get(taskType)
        : db.prepare(query).get();

    if (!task) return null;

    // Atomically set to RUNNING
    db.prepare(`UPDATE squad_tasks SET status = 'RUNNING', processed_at = datetime('now') WHERE id = ?`)
        .run(task.id);

    return task;
}

/**
 * Complete a task — mark as DONE or FAILED
 */
function completeTask(taskId, success, result = '') {
    db.prepare(`
        UPDATE squad_tasks SET status = ?, result = ?, processed_at = datetime('now') WHERE id = ?
    `).run(success ? 'DONE' : 'FAILED', result, taskId);
}

/**
 * Skip a task (rate limit, account unavailable, etc.)
 */
function skipTask(taskId, reason = '') {
    db.prepare(`
        UPDATE squad_tasks SET status = 'PENDING', result = ? WHERE id = ?
    `).run(reason, taskId);
}

/**
 * Get queue stats
 */
function getQueueStats() {
    return db.prepare(`
        SELECT status, task_type, COUNT(*) as count 
        FROM squad_tasks GROUP BY status, task_type
    `).all();
}

/**
 * Get pending task count
 */
function getPendingCount(taskType = null) {
    if (taskType) {
        return db.prepare(`SELECT COUNT(*) as c FROM squad_tasks WHERE status = 'PENDING' AND task_type = ?`).get(taskType).c;
    }
    return db.prepare(`SELECT COUNT(*) as c FROM squad_tasks WHERE status = 'PENDING'`).get().c;
}

// ═══ Action Log Functions (for Rate Limiting) ═══

/**
 * Log a completed action
 */
function logAction(account, actionType, targetUrl, success = true, commentText = '') {
    db.prepare(`
        INSERT INTO squad_action_log (account, action_type, target_url, success, comment_text)
        VALUES (?, ?, ?, ?, ?)
    `).run(account, actionType, targetUrl, success ? 1 : 0, commentText);
}

/**
 * Get action count for today
 */
function getActionCountToday(account, actionType) {
    return db.prepare(`
        SELECT COUNT(*) as c FROM squad_action_log
        WHERE account = ? AND action_type = ? AND date(created_at) = date('now') AND success = 1
    `).get(account, actionType).c;
}

/**
 * Get last action of a specific type for an account
 */
function getLastAction(account, actionType) {
    return db.prepare(`
        SELECT * FROM squad_action_log
        WHERE account = ? AND action_type = ? AND success = 1
        ORDER BY created_at DESC LIMIT 1
    `).get(account, actionType);
}

/**
 * Get today's action summary per account
 */
function getTodaySummary() {
    return db.prepare(`
        SELECT account, action_type, COUNT(*) as count
        FROM squad_action_log
        WHERE date(created_at) = date('now') AND success = 1
        GROUP BY account, action_type
    `).all();
}

module.exports = {
    pushTask, claimNextTask, completeTask, skipTask,
    getQueueStats, getPendingCount,
    logAction, getActionCountToday, getLastAction, getTodaySummary,
    db,
};
