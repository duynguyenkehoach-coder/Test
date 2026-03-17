/**
 * Browser + Session Manager
 * Centralized browser state and session lifecycle.
 * 
 * @module scraper/browserManager
 */
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../proxy/proxyPool');
const { generateFingerprint } = require('../proxy/fingerprint');

chromium.use(StealthPlugin());

// ═══ TOTP Generator (Facebook 2FA) ═══
const authenticator = {
    generate(secret) {
        const cleanSecret = secret.replace(/\s/g, '');
        const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const c of cleanSecret.toUpperCase()) {
            const val = base32chars.indexOf(c);
            if (val === -1) continue;
            bits += val.toString(2).padStart(5, '0');
        }
        const secretBytes = Buffer.alloc(Math.floor(bits.length / 8));
        for (let i = 0; i < secretBytes.length; i++) {
            secretBytes[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
        }
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / 30);
        const counterBuf = Buffer.alloc(8);
        counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
        counterBuf.writeUInt32BE(counter & 0xFFFFFFFF, 4);
        const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
        return code.toString().padStart(6, '0');
    }
};
console.log('[FBScraper] 🔑 Built-in TOTP generator ready');

// ═══ Shared Constants ═══
const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 600));
const FB_URL = 'https://www.facebook.com';
const COOKIES_PATH = path.join(__dirname, '..', '..', '..', 'data', 'fb_session.json');
const SESSIONS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'sessions');
const FB_EMAIL = process.env.FB_EMAIL || '';
const FB_PASSWORD = process.env.FB_PASSWORD || '';

// ═══ Shared Browser State ═══
const state = {
    activeBrowser: null,
    activeContext: null,
    isLoggedIn: false,
    sessionAge: 0,
    MAX_SESSION_AGE: 30,
};

// ═══ Session I/O ═══
async function saveSession(context) {
    try {
        const cookies = await context.cookies();
        fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        console.log(`[FBScraper] 💾 Session saved (${cookies.length} cookies)`);
    } catch (e) {
        console.warn(`[FBScraper] ⚠️ Save session failed: ${e.message}`);
    }
}

function loadSession(sessionPath) {
    const p = sessionPath || COOKIES_PATH;
    try {
        if (fs.existsSync(p)) {
            const cookies = JSON.parse(fs.readFileSync(p, 'utf8'));
            console.log(`[FBScraper] 📂 Loaded session: ${path.basename(p)} (${cookies.length} cookies)`);
            return cookies;
        }
    } catch (e) {
        console.warn(`[FBScraper] ⚠️ Load session failed: ${e.message}`);
    }
    return null;
}

async function closeBrowser() {
    if (state.activeBrowser) try { await state.activeBrowser.close(); } catch { }
    state.activeBrowser = null;
    state.activeContext = null;
    state.isLoggedIn = false;
    state.sessionAge = 0;
}

// ═══ Helpers ═══
function extractGroupId(url) {
    const match = url.match(/groups\/([^/?]+)/);
    return match ? match[1] : null;
}

// ═══ Free Proxy Fetcher ═══
async function fetchFreeProxies() {
    const sources = [
        {
            name: 'ProxyScrape',
            url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=elite',
            parse: (text) => text.trim().split('\n').filter(Boolean).map(line => `http://${line.trim()}`),
        },
    ];
    const all = [];
    for (const s of sources) {
        try {
            const r = await axios.get(s.url, { timeout: 10000, transformResponse: [d => d] });
            const p = s.parse(r.data);
            all.push(...p);
            console.log(`[FBScraper] 📡 ${s.name}: ${p.length} proxies`);
        } catch (e) {
            console.warn(`[FBScraper] ⚠️ ${s.name}: ${e.message}`);
        }
    }
    return [...new Set(all)];
}

async function loadFreeProxies() {
    if (!pool.loaded) await pool.load();
    if (pool.getActiveCount() >= 3) return;
    const urls = await fetchFreeProxies();
    if (urls.length > 0) {
        pool.addBulk(urls, 'free', 'US');
        await pool.save();
    }
}

module.exports = {
    // State (shared reference — mutations propagate)
    state,
    // Constants
    chromium, authenticator, delay, FB_URL, COOKIES_PATH, SESSIONS_DIR, FB_EMAIL, FB_PASSWORD,
    // Dependencies
    fs, path, pool, generateFingerprint, axios,
    // Functions
    saveSession, loadSession, closeBrowser, extractGroupId,
    fetchFreeProxies, loadFreeProxies,
};
