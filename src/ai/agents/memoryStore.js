/**
 * THG Agent — Memory Store
 * 
 * Stores past classifications + human feedback in SQLite.
 * Provides similar-post lookup for dynamic prompt building.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data_store', 'thg_leads.db');

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        initTables();
    }
    return db;
}

function initTables() {
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS classification_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_hash TEXT,
            platform TEXT DEFAULT 'unknown',
            score INTEGER DEFAULT 0,
            role TEXT DEFAULT 'unknown',
            service_match TEXT DEFAULT 'None',
            reasoning TEXT DEFAULT '',
            human_feedback TEXT DEFAULT NULL,
            correct_role TEXT DEFAULT NULL,
            correct_score INTEGER DEFAULT NULL,
            feedback_note TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            feedback_at DATETIME DEFAULT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_memory_hash ON classification_memory(content_hash);
        CREATE INDEX IF NOT EXISTS idx_memory_feedback ON classification_memory(human_feedback);
        CREATE INDEX IF NOT EXISTS idx_memory_role ON classification_memory(role);
    `);
    console.log('[MemoryStore] ✅ Tables ready');
}

/**
 * Generate simple hash of content for dedup
 */
function contentHash(text) {
    const normalized = (text || '').toLowerCase().trim().substring(0, 200);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(36);
}

/**
 * Save a classification result to memory
 */
function saveClassification(post, result) {
    try {
        const content = (post.content || '').substring(0, 1000);
        const hash = contentHash(content);

        // Skip if already exists
        const existing = getDb().prepare('SELECT id FROM classification_memory WHERE content_hash = ?').get(hash);
        if (existing) return existing.id;

        const stmt = getDb().prepare(`
            INSERT INTO classification_memory (content, content_hash, platform, score, role, service_match, reasoning)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            content, hash,
            post.platform || 'unknown',
            result.score || 0,
            result.role || result.author_role || 'unknown',
            result.category || result.service_match || 'None',
            result.summary || result.reasoning || ''
        );
        return info.lastInsertRowid;
    } catch (err) {
        console.warn('[MemoryStore] ⚠️ Save failed:', err.message);
        return null;
    }
}

/**
 * Save human feedback for a classification
 */
function saveFeedback(memoryId, feedback) {
    try {
        const stmt = getDb().prepare(`
            UPDATE classification_memory 
            SET human_feedback = ?, correct_role = ?, correct_score = ?, 
                feedback_note = ?, feedback_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(
            feedback.type,
            feedback.correct_role || null,
            feedback.correct_score || null,
            feedback.note || null,
            memoryId
        );
        return true;
    } catch (err) {
        console.warn('[MemoryStore] ⚠️ Feedback save failed:', err.message);
        return false;
    }
}

/**
 * Save feedback by content text (use content_hash to find record in classification_memory)
 * This is needed because leads.db and thg_leads.db have different auto-increment IDs.
 */
function saveFeedbackByContent(content, feedback) {
    try {
        const hash = contentHash(content);
        const stmt = getDb().prepare(`
            UPDATE classification_memory 
            SET human_feedback = ?, correct_role = ?, correct_score = ?, 
                feedback_note = ?, feedback_at = CURRENT_TIMESTAMP
            WHERE content_hash = ?
        `);
        const result = stmt.run(
            feedback.type,
            feedback.correct_role || null,
            feedback.correct_score || null,
            feedback.note || null,
            hash
        );
        if (result.changes === 0) {
            // Record not in memory yet — insert it now with feedback
            const insertStmt = getDb().prepare(`
                INSERT INTO classification_memory (content, content_hash, platform, human_feedback, correct_role, correct_score, feedback_note, feedback_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            insertStmt.run(
                (content || '').substring(0, 1000),
                hash,
                feedback.platform || 'unknown',
                feedback.type,
                feedback.correct_role || null,
                feedback.correct_score || null,
                feedback.note || null
            );
        }
        return true;
    } catch (err) {
        console.warn('[MemoryStore] ⚠️ saveFeedbackByContent failed:', err.message);
        return false;
    }
}

/**
 * Find past classifications with human feedback, for few-shot examples
 * Returns up to N examples that had feedback
 */
function getFeedbackExamples(topN = 5) {
    try {
        const rows = getDb().prepare(`
            SELECT content, score, role, service_match, reasoning, 
                   human_feedback, correct_role, correct_score
            FROM classification_memory
            WHERE human_feedback IS NOT NULL
            ORDER BY feedback_at DESC
            LIMIT ?
        `).all(topN);
        return rows;
    } catch (err) {
        return [];
    }
}

/**
 * Get stats about classification memory
 */
function getMemoryStats() {
    try {
        const total = getDb().prepare('SELECT COUNT(*) as count FROM classification_memory').get();
        const withFeedback = getDb().prepare('SELECT COUNT(*) as count FROM classification_memory WHERE human_feedback IS NOT NULL').get();
        const buyers = getDb().prepare('SELECT COUNT(*) as count FROM classification_memory WHERE score >= 60').get();
        const providers = getDb().prepare('SELECT COUNT(*) as count FROM classification_memory WHERE score = 0').get();
        return {
            total: total.count,
            withFeedback: withFeedback.count,
            buyers: buyers.count,
            providers: providers.count,
        };
    } catch (err) {
        return { total: 0, withFeedback: 0, buyers: 0, providers: 0 };
    }
}

/**
 * Get recent buyer classifications for memory context
 */
function getRecentBuyers(limit = 5) {
    try {
        return getDb().prepare(`
            SELECT content, score, service_match, reasoning
            FROM classification_memory
            WHERE score >= 60 AND role IN ('seller_ecom', 'buyer', 'unknown')
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit);
    } catch (err) {
        return [];
    }
}

/**
 * Get recent feedback history for dashboard display
 */
function getFeedbackHistory(limit = 20) {
    try {
        return getDb().prepare(`
            SELECT id, SUBSTR(content, 1, 120) as preview, platform,
                   human_feedback, correct_role, feedback_note, feedback_at,
                   score, role
            FROM classification_memory
            WHERE human_feedback IS NOT NULL
            ORDER BY feedback_at DESC
            LIMIT ?
        `).all(limit);
    } catch (err) {
        return [];
    }
}

// Initialize on load
try { getDb(); } catch (e) { console.warn('[MemoryStore] ⚠️ Init failed:', e.message); }

module.exports = {
    saveClassification,
    saveFeedback,
    saveFeedbackByContent,
    getFeedbackExamples,
    getFeedbackHistory,
    getMemoryStats,
    getRecentBuyers,
    contentHash,
};
