/**
 * 🎯 Custom Audience Exporter — Facebook Ads Retargeting
 * 
 * Xuất leads score 80+ thành file CSV chuẩn Facebook Custom Audience.
 * Upload lên Facebook Ads Manager → chạy quảng cáo nhắm vào leads đã lọc.
 * 
 * Facebook Custom Audience hỗ trợ formats:
 * - UID (Facebook User ID) — extracted từ author_url
 * - External ID — dùng lead ID
 * - Page Scoped User ID
 * 
 * @module agent/strategies/audienceExporter
 */
'use strict';

const fs = require('fs');
const path = require('path');
const database = require('../../core/data_store/database');

const EXPORT_DIR = path.join(__dirname, '..', '..', '..', 'data', 'exports');

/**
 * Extract Facebook UID from author_url
 * Facebook URLs: facebook.com/profile.php?id=123456 or facebook.com/username
 * @param {string} url
 * @returns {string|null}
 */
function extractFacebookUID(url) {
    if (!url) return null;
    // Pattern 1: /profile.php?id=123456789
    const idMatch = url.match(/profile\.php\?id=(\d+)/);
    if (idMatch) return idMatch[1];
    // Pattern 2: /username or /people/name/123456789
    const peopleMatch = url.match(/\/people\/[^/]+\/(\d+)/);
    if (peopleMatch) return peopleMatch[1];
    // Pattern 3: numeric-only path segment
    const numMatch = url.match(/facebook\.com\/(\d{5,})/);
    if (numMatch) return numMatch[1];
    // Pattern 4: username (for potential matching)
    const usernameMatch = url.match(/facebook\.com\/([a-zA-Z0-9.]+)\/?$/);
    if (usernameMatch && usernameMatch[1] !== 'profile.php') return usernameMatch[1];
    return null;
}

/**
 * Export leads as Facebook Custom Audience CSV
 * @param {object} opts
 * @param {number} opts.minScore - minimum lead score (default 80)
 * @param {string} opts.language - 'vietnamese' | 'foreign' | 'all' (default 'all')
 * @param {string} opts.category - filter by category (optional)
 * @param {string} opts.format - 'uid' | 'full' (default 'full')
 * @returns {{ filePath: string, count: number, leads: object[] }}
 */
function exportAudience(opts = {}) {
    const { minScore = 80, language = 'all', category = null, format = 'full' } = opts;

    // Ensure export dir exists
    if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

    // Query leads
    let query = `SELECT id, author_name, author_url, post_url, score, category, language, content, summary
                 FROM leads WHERE score >= ? AND role = 'buyer' AND status != 'ignored'`;
    const params = [minScore];

    if (language !== 'all') {
        query += ` AND language = ?`;
        params.push(language);
    }
    if (category) {
        query += ` AND category LIKE ?`;
        params.push(`%${category}%`);
    }

    query += ` ORDER BY score DESC`;

    const leads = database.db.prepare(query).all(...params);
    console.log(`[AudienceExporter] 🎯 Found ${leads.length} leads (score >= ${minScore})`);

    if (leads.length === 0) {
        return { filePath: null, count: 0, leads: [] };
    }

    // Build CSV
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const fileName = `fb_audience_${timestamp}.csv`;
    const filePath = path.join(EXPORT_DIR, fileName);

    let csvContent;

    if (format === 'uid') {
        // Simple UID-only format for FB Custom Audience upload
        csvContent = 'extern_id\n';
        for (const lead of leads) {
            const uid = extractFacebookUID(lead.author_url);
            if (uid) csvContent += `${uid}\n`;
        }
    } else {
        // Full format with all info
        csvContent = 'extern_id,name,profile_url,score,category,language,summary\n';
        for (const lead of leads) {
            const uid = extractFacebookUID(lead.author_url) || lead.id;
            const name = (lead.author_name || '').replace(/"/g, '""');
            const summary = (lead.summary || '').replace(/"/g, '""').substring(0, 200);
            csvContent += `"${uid}","${name}","${lead.author_url || ''}",${lead.score},"${lead.category || ''}","${lead.language || ''}","${summary}"\n`;
        }
    }

    fs.writeFileSync(filePath, csvContent, 'utf8');
    console.log(`[AudienceExporter] ✅ Exported ${leads.length} leads to ${fileName}`);

    return { filePath, fileName, count: leads.length, leads };
}

/**
 * Get audience stats without exporting
 * @returns {{ total: number, byScore: object, byCategory: object, byLanguage: object }}
 */
function getAudienceStats() {
    const total = database.db.prepare(`
        SELECT COUNT(*) as c FROM leads WHERE score >= 80 AND role = 'buyer' AND status != 'ignored'
    `).get();

    const byScore = database.db.prepare(`
        SELECT
            SUM(CASE WHEN score >= 90 THEN 1 ELSE 0 END) as s90,
            SUM(CASE WHEN score >= 80 AND score < 90 THEN 1 ELSE 0 END) as s80,
            SUM(CASE WHEN score >= 70 AND score < 80 THEN 1 ELSE 0 END) as s70,
            SUM(CASE WHEN score >= 60 AND score < 70 THEN 1 ELSE 0 END) as s60
        FROM leads WHERE role = 'buyer' AND status != 'ignored'
    `).get();

    const byCategory = database.db.prepare(`
        SELECT category, COUNT(*) as count FROM leads
        WHERE score >= 80 AND role = 'buyer' AND status != 'ignored'
        GROUP BY category ORDER BY count DESC
    `).all();

    const byLanguage = database.db.prepare(`
        SELECT language, COUNT(*) as count FROM leads
        WHERE score >= 80 AND role = 'buyer' AND status != 'ignored'
        GROUP BY language
    `).all();

    return {
        total: total.c,
        byScore,
        byCategory: Object.fromEntries(byCategory.map(r => [r.category || 'unknown', r.count])),
        byLanguage: Object.fromEntries(byLanguage.map(r => [r.language || 'unknown', r.count])),
    };
}

module.exports = { exportAudience, getAudienceStats, extractFacebookUID };
