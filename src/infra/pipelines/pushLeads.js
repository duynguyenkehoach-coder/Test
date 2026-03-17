/**
 * push-leads.js — Auto-push classified leads từ local lên production VPS
 * 
 * Được gọi sau khi pipeline classify leads xong.
 * Dùng /api/import/crawbot — format tương thích 100%.
 */
const https = require('https');
const path = require('path');

const PROD_HOST = 'thg-tool.duckdns.org';
const TOKEN_CACHE_FILE = path.join(__dirname, '../../data/.prod_token.json');
const fs = require('fs');

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    // Try to load from cache file
    try {
        const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
        if (cache.token && Date.now() < cache.expiry) {
            cachedToken = cache.token;
            tokenExpiry = cache.expiry;
            return cachedToken;
        }
    } catch { }

    // Re-login
    const email = process.env.PROD_ADMIN_EMAIL || 'admin@THGfullfil.com';
    const password = process.env.PROD_ADMIN_PASSWORD || 'THG2026@';
    const res = await httpPost('/api/auth/login', { email, password });
    if (!res.ok || !res.token) throw new Error('Production login failed: ' + JSON.stringify(res));

    cachedToken = res.token;
    tokenExpiry = Date.now() + 23 * 3600 * 1000; // 23h cache
    try {
        fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true });
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token: cachedToken, expiry: tokenExpiry }));
    } catch { }
    return cachedToken;
}

function httpPost(urlPath, data, token) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const req = https.request({ hostname: PROD_HOST, path: urlPath, method: 'POST', port: 443, headers }, (res) => {
            let out = '';
            res.on('data', d => out += d);
            res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(out); } });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Push một batch leads lên production
 * @param {Array} leads - Array of lead objects từ local DB
 */
async function pushLeadsToProd(leads) {
    if (!leads || leads.length === 0) return { pushed: 0 };

    try {
        const token = await getToken();

        // Format theo /api/import/crawbot spec
        const posts = leads.map(lead => ({
            url: lead.source_url || lead.post_url || lead.url || '',
            author: lead.customer_name || lead.author_name || 'Unknown',
            author_url: lead.author_url || '',
            content: lead.content || lead.notes || '',
            platform: lead.platform || 'facebook',
            group_name: lead.group_name || '',
            scraped_at: lead.created_at || new Date().toISOString(),
        })).filter(p => p.content && p.content.length > 10);

        if (!posts.length) return { pushed: 0 };

        const res = await httpPost('/api/import/crawbot', posts, token);
        const pushed = res.enqueued || 0;
        const dupes = res.duplicates || 0;
        console.log(`[PushLeads] ✅ Pushed to production: ${pushed} new, ${dupes} dupes (${posts.length} total)`);
        return { pushed, dupes };
    } catch (err) {
        console.error(`[PushLeads] ❌ Failed to push: ${err.message}`);
        return { pushed: 0, error: err.message };
    }
}

module.exports = { pushLeadsToProd };
