/**
 * sync-groups.js — Pull groups từ production VPS và cập nhật local config
 * 
 * Usage: task sync:groups   (hoặc: node scripts/sync-groups.js)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const path = require('path');
const fs = require('fs');

const PROD_HOST = 'thg-tool.duckdns.org';
const PROD_EMAIL = 'admin@thg.vn';
const PROD_PASSWORD = process.env.PROD_ADMIN_PASSWORD || 'ITdev2026';

function httpPost(hostname, path, data, token) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const req = http.request({ hostname, path, method: 'POST', headers }, (res) => {
            let out = '';
            res.on('data', d => out += d);
            res.on('end', () => resolve(JSON.parse(out)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function httpGet(hostname, path, token) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const req = http.request({ hostname, path, method: 'GET', headers }, (res) => {
            let out = '';
            res.on('data', d => out += d);
            res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(out); } });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log(`\n🔗 Connecting to production: http://${PROD_HOST}`);

    // Step 1: Login
    const loginRes = await httpPost(PROD_HOST, '/api/auth/login', { email: PROD_EMAIL, password: PROD_PASSWORD });
    if (!loginRes.ok || !loginRes.token) {
        console.error('❌ Login failed:', loginRes);
        process.exit(1);
    }
    const token = loginRes.token;
    console.log(`✅ Login OK`);

    // Step 2: Get groups from production
    const groupsRes = await httpGet(PROD_HOST, '/api/groups', token);
    const groups = Array.isArray(groupsRes) ? groupsRes : (groupsRes.groups || groupsRes.data || []);

    if (!groups.length) {
        console.error('❌ No groups found:', JSON.stringify(groupsRes).substring(0, 200));
        process.exit(1);
    }
    console.log(`📋 Found ${groups.length} groups from production`);

    // Step 3: Format groups for config.js
    const formatted = groups
        .filter(g => g.url || g.group_url)
        .map(g => ({
            name: g.name || g.group_name || 'Unknown Group',
            url: g.url || g.group_url,
        }));

    console.log('\n📝 Groups:');
    formatted.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}`));

    // Step 4: Write to local groups override file
    const outPath = path.join(__dirname, '..', 'data', 'prod_groups.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(formatted, null, 2));
    console.log(`\n✅ Saved ${formatted.length} groups → ${outPath}`);
    console.log('🚀 Chạy "task" để restart và scrape tất cả groups!\n');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
