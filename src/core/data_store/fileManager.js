/**
 * THG Data Manager — Daily JSON Export & Auto-Cleanup
 * 
 * - Exports leads to data/leads_YYYY-MM-DD.json (organized by day)
 * - Exports conversations to data/inbox_YYYY-MM-DD.json
 * - Auto-deletes files older than 7 days
 * - Keeps server clean and data easy to manage
 */

const fs = require('fs');
const path = require('path');
const database = require('./database');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const RETENTION_DAYS = 7;

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

function initDataFolder() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('[DataMgr] 📁 Created data/ folder');
    }
}

// ═══════════════════════════════════════════════════════════
//  SAVE LEAD TO DAILY FILE
// ═══════════════════════════════════════════════════════════

function saveLeadToFile(lead) {
    initDataFolder();
    const today = new Date().toISOString().split('T')[0];
    const fileName = `leads_${today}.json`;
    const filePath = path.join(DATA_DIR, fileName);

    const leadData = {
        platform: lead.platform,
        author_name: lead.author_name || 'Unknown',
        author_url: lead.author_url || '',
        author_avatar: lead.author_avatar || '',
        post_url: lead.post_url || '',
        content: lead.content,
        score: lead.score,
        category: lead.category,
        summary: lead.summary,
        urgency: lead.urgency,
        role: lead.role || '',
        buyer_signals: lead.buyerSignals || lead.buyer_signals || '',
        suggested_response: lead.suggested_response || '',
        post_created_at: lead.post_created_at || null,
        scraped_at: lead.scraped_at || new Date().toISOString(),
    };

    let currentData = [];

    // Read existing file if today's file already has data
    if (fs.existsSync(filePath)) {
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            currentData = JSON.parse(fileContent);
        } catch {
            currentData = [];
        }
    }

    // Avoid duplicates by URL
    const isDuplicate = currentData.some(item => item.post_url === lead.post_url || item.url === lead.post_url);
    if (!isDuplicate) {
        currentData.push(leadData);
        fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2), 'utf8');
        return true;
    }
    return false;
}

/**
 * Batch-save multiple leads to today's file
 */
function saveLeadsToFile(leads) {
    if (!leads || leads.length === 0) return 0;
    let saved = 0;
    for (const lead of leads) {
        if (saveLeadToFile(lead)) saved++;
    }
    if (saved > 0) {
        const today = new Date().toISOString().split('T')[0];
        console.log(`[DataMgr] 💾 ${saved} leads → data/leads_${today}.json`);
    }
    return saved;
}

// ═══════════════════════════════════════════════════════════
//  SAVE CONVERSATION TO DAILY FILE
// ═══════════════════════════════════════════════════════════

function saveConversationToFile(conv) {
    initDataFolder();
    const today = new Date().toISOString().split('T')[0];
    const fileName = `inbox_${today}.json`;
    const filePath = path.join(DATA_DIR, fileName);

    const convData = {
        timestamp: new Date().toISOString(),
        sender_name: conv.sender_name,
        sender_id: conv.sender_id,
        message: conv.message,
        ai_suggestion: conv.ai_suggestion,
        sale_reply: conv.sale_reply,
        intent: conv.intent,
        status: conv.status,
        platform: conv.platform,
    };

    let currentData = [];
    if (fs.existsSync(filePath)) {
        try {
            currentData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch { currentData = []; }
    }

    currentData.push(convData);
    fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2), 'utf8');
}

// ═══════════════════════════════════════════════════════════
//  AUTO-CLEANUP: Delete files older than 7 days
// ═══════════════════════════════════════════════════════════

function cleanOldData() {
    initDataFolder();
    console.log('[DataMgr] 🧹 Checking for old data files...');
    const files = fs.readdirSync(DATA_DIR);
    const today = new Date();
    let deleted = 0;

    for (const file of files) {
        // Only process our JSON files (leads_*.json, inbox_*.json)
        const match = file.match(/^(leads|inbox)_(\d{4}-\d{2}-\d{2})\.json$/);
        if (!match) continue;

        const fileDate = new Date(match[2]);
        if (isNaN(fileDate.getTime())) continue;

        const diffDays = Math.ceil((today - fileDate) / (1000 * 60 * 60 * 24));

        if (diffDays > RETENTION_DAYS) {
            try {
                fs.unlinkSync(path.join(DATA_DIR, file));
                console.log(`[DataMgr] 🗑️ Deleted: ${file} (${diffDays} days old)`);
                deleted++;
            } catch (err) {
                console.error(`[DataMgr] ✗ Failed to delete ${file}:`, err.message);
            }
        }
    }

    if (deleted > 0) {
        console.log(`[DataMgr] ✅ Cleaned ${deleted} old files`);
    } else {
        console.log('[DataMgr] ✅ No old files to clean');
    }

    // Also clean old DB records (conversations > 30 days, for DB hygiene)
    try {
        const result = database.db.prepare(
            "DELETE FROM conversations WHERE created_at < datetime('now', '-30 days')"
        ).run();
        if (result.changes > 0) {
            console.log(`[DataMgr] 🗑️ Purged ${result.changes} old conversations from DB`);
        }
    } catch { /* ignore */ }

    return deleted;
}

// ═══════════════════════════════════════════════════════════
//  LIST DATA FILES (for dashboard API)
// ═══════════════════════════════════════════════════════════

function listDataFiles() {
    initDataFolder();
    const files = fs.readdirSync(DATA_DIR);
    return files
        .filter(f => f.match(/^(leads|inbox)_\d{4}-\d{2}-\d{2}\.json$/))
        .map(file => {
            const filePath = path.join(DATA_DIR, file);
            const stat = fs.statSync(filePath);
            const match = file.match(/^(leads|inbox)_(\d{4}-\d{2}-\d{2})\.json$/);
            let itemCount = 0;
            try {
                itemCount = JSON.parse(fs.readFileSync(filePath, 'utf8')).length;
            } catch { /* ignore */ }
            return {
                name: file,
                type: match[1], // 'leads' or 'inbox'
                date: match[2],
                size: stat.size,
                items: itemCount,
            };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
}

function readDataFile(fileName) {
    const filePath = path.join(DATA_DIR, fileName);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { return null; }
}

module.exports = {
    initDataFolder,
    saveLeadToFile,
    saveLeadsToFile,
    saveConversationToFile,
    cleanOldData,
    listDataFiles,
    readDataFile,
};
