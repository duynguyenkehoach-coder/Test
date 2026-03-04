/**
 * THG Lead Gen — Multi-Platform Scraper v4 (Credit-Optimized)
 * 
 * VẤN ĐỀ ĐÃ FIX:
 * 1. Twitter/X DISABLED hoàn toàn — $0.40/run, không phù hợp target
 * 2. FB Groups scraper DISABLED — 22 groups × $X/group = credit killer
 * 3. TikTok Apify dùng 2 actor/keyword — giờ chỉ dùng 1
 * 4. Thiếu delay giữa Apify calls — giờ có 2s delay
 * 5. maxPosts không được enforce chặt — giờ có hard limit
 */

const axios = require('axios');
const config = require('../config');

// ╔══════════════════════════════════════════════════════╗
// ║  CREDIT BUDGET GUARD                                 ║
// ╚══════════════════════════════════════════════════════╝
const DAILY_APIFY_BUDGET_USD = 0.15; // ~$4.5/month, để dư margin
let apifySpentToday = 0;
const APIFY_COST_PER_RUN = 0.04; // conservative estimate per actor run

function canSpendApify() {
    if (apifySpentToday >= DAILY_APIFY_BUDGET_USD) {
        console.log(`[Budget] 🚫 Daily Apify budget $${DAILY_APIFY_BUDGET_USD} reached. Skipping.`);
        return false;
    }
    return true;
}
function recordApifySpend() {
    apifySpentToday += APIFY_COST_PER_RUN;
    console.log(`[Budget] 💰 Apify spent today: ~$${apifySpentToday.toFixed(3)} / $${DAILY_APIFY_BUDGET_USD}`);
}
// Reset daily budget at midnight
setInterval(() => { apifySpentToday = 0; console.log('[Budget] 🔄 Daily budget reset'); }, 24 * 60 * 60 * 1000);

// ╔══════════════════════════════════════════════════════╗
// ║  KEY POOL                                            ║
// ╚══════════════════════════════════════════════════════╝
const RAPIDAPI_KEYS = (process.env.RAPIDAPI_KEYS || process.env.RAPIDAPI_KEY || '')
    .split(',').map(k => k.trim()).filter(Boolean);
const APIFY_TOKENS = (process.env.APIFY_TOKENS || process.env.APIFY_TOKEN || '')
    .split(',').map(k => k.trim()).filter(Boolean);

const exhaustedRapidKeys = new Set();
const exhaustedApifyTokens = new Set();
setInterval(() => {
    exhaustedRapidKeys.clear();
    exhaustedApifyTokens.clear();
    console.log('[KeyPool] 🔄 Reset exhausted keys');
}, 60 * 60 * 1000);

function getActiveRapidKey() {
    for (const key of RAPIDAPI_KEYS) {
        if (!exhaustedRapidKeys.has(key)) return key;
    }
    return null;
}
function markRapidKeyExhausted(key) {
    exhaustedRapidKeys.add(key);
    console.log(`[KeyPool] ❌ RapidAPI ...${key.slice(-6)} exhausted`);
}

function getActiveApifyClient() {
    for (const token of APIFY_TOKENS) {
        if (!exhaustedApifyTokens.has(token)) {
            try {
                const { ApifyClient } = require('apify-client');
                return { client: new ApifyClient({ token }), token };
            } catch (e) { continue; }
        }
    }
    return null;
}
function markApifyTokenExhausted(token) {
    exhaustedApifyTokens.add(token);
    const remaining = APIFY_TOKENS.filter(t => !exhaustedApifyTokens.has(t)).length;
    console.log(`[KeyPool] ❌ Apify ...${token.slice(-6)} exhausted. ${remaining}/${APIFY_TOKENS.length} tokens remaining`);
}

// Check if error means token is out of credit
function isApifyExhausted(errMsg) {
    const msg = (errMsg || '').toLowerCase();
    return msg.includes('exceed') || msg.includes('remaining usage')
        || msg.includes('hard limit') || msg.includes('upgrade');
}

console.log(`[KeyPool] Loaded: ${RAPIDAPI_KEYS.length} RapidAPI keys, ${APIFY_TOKENS.length} Apify tokens`);

function rapidHeaders(host) {
    const key = getActiveRapidKey();
    if (!key) return null;
    return { 'x-rapidapi-key': key, 'x-rapidapi-host': host };
}

function isRateLimited(err) {
    const status = err.response?.status;
    const msg = (err.response?.data?.message || err.message || '').toLowerCase();
    return status === 429 || status === 403
        || msg.includes('rate limit') || msg.includes('quota')
        || msg.includes('exceeded') || msg.includes('too many');
}

// Shared delay helper
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ╔══════════════════════════════════════════════════════╗
// ║  TIMESTAMP PARSER                                    ║
// ╚══════════════════════════════════════════════════════╝
function parseTimestamp(val) {
    if (!val) return null;
    if (typeof val === 'number' && val < 20000000000) return new Date(val * 1000).toISOString();
    if (typeof val === 'number') return new Date(val).toISOString();
    if (typeof val === 'string') {
        const lower = val.toLowerCase().trim();
        const now = new Date();
        if (lower.includes('just now') || lower === 'now') return now.toISOString();
        const minMatch = lower.match(/(\d+)\s*(?:m|min|mins|phút)/);
        if (minMatch) return new Date(now - parseInt(minMatch[1]) * 60000).toISOString();
        const hrMatch = lower.match(/(\d+)\s*(?:h|hr|hrs|hour|hours|giờ)/);
        if (hrMatch) return new Date(now - parseInt(hrMatch[1]) * 3600000).toISOString();
        const dayMatch = lower.match(/(\d+)\s*(?:d|day|days|ngày)/);
        if (dayMatch) return new Date(now - parseInt(dayMatch[1]) * 86400000).toISOString();
        if (lower.includes('yesterday') || lower.includes('hôm qua'))
            return new Date(now - 86400000).toISOString();
    }
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// ╔══════════════════════════════════════════════════════╗
// ║  INSTAGRAM                                           ║
// ╚══════════════════════════════════════════════════════╝

const IG_API_HOSTS = [
    { host: 'instagram-scraper-api2.p.rapidapi.com', path: '/v1/hashtag', paramKey: 'hashtag', dataPath: 'data.items', method: 'GET' },
    { host: 'instagram-scrapper-new.p.rapidapi.com', path: '/getFeedByHashtagLegacy', paramKey: 'hashtag', dataPath: 'items', method: 'POST' },
];

async function igFromRapidAPI(hashtags, maxPosts) {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) throw new Error('No RAPIDAPI_KEY');
    const allPosts = [];
    // FIX: Chỉ lấy top 3 hashtag, không phải 5
    for (const api of IG_API_HOSTS) {
        try {
            for (const hashtag of hashtags.slice(0, 3)) {
                console.log(`[IG:RapidAPI] → #${hashtag}`);
                const reqConfig = {
                    headers: { 'x-rapidapi-host': api.host, 'x-rapidapi-key': apiKey },
                    timeout: 30000,
                };
                let resp;
                if (api.method === 'POST') {
                    resp = await axios.post(`https://${api.host}${api.path}`, { [api.paramKey]: hashtag }, reqConfig);
                } else {
                    resp = await axios.get(`https://${api.host}${api.path}`, { ...reqConfig, params: { [api.paramKey]: hashtag } });
                }
                let items = resp.data;
                for (const key of api.dataPath.split('.')) items = items?.[key];
                items = items || resp.data?.data?.medias || resp.data?.items || [];
                const posts = (Array.isArray(items) ? items : [])
                    // FIX: Hard limit 15 per hashtag
                    .slice(0, 15)
                    .map(item => ({
                        platform: 'instagram',
                        post_url: item.code ? `https://www.instagram.com/p/${item.code}/` : (item.url || ''),
                        author_name: item.user?.username || item.owner?.username || 'Unknown',
                        author_url: item.user?.username ? `https://www.instagram.com/${item.user.username}/` : '',
                        content: item.caption?.text || item.caption || item.text || '',
                        post_created_at: parseTimestamp(item.taken_at || item.timestamp),
                        scraped_at: new Date().toISOString(),
                    }))
                    .filter(p => p.content && p.content.length > 15);
                allPosts.push(...posts);
                console.log(`[IG:RapidAPI] ✓ ${posts.length} posts for #${hashtag}`);
                await delay(1500); // FIX: tăng delay lên 1.5s
            }
            return allPosts;
        } catch (err) {
            if (isRateLimited(err)) { console.log(`[IG:RapidAPI] ❌ ${api.host} → 429`); continue; }
            console.log(`[IG:RapidAPI] ⚠️ ${api.host} → ${err.message}`); continue;
        }
    }
    throw new Error('All IG RapidAPI hosts exhausted');
}

async function igFromApify(hashtags, maxPosts) {
    if (!canSpendApify()) throw new Error('Daily Apify budget reached');
    let apify = getActiveApifyClient();
    if (!apify) throw new Error('No active Apify tokens');
    const allPosts = [];
    for (const hashtag of hashtags.slice(0, 2)) {
        console.log(`[IG:Apify] → #${hashtag}`);
        try {
            if (!apify) { apify = getActiveApifyClient(); if (!apify) break; }
            recordApifySpend();
            const run = await apify.client.actor('apify/instagram-hashtag-scraper').call({
                hashtags: [hashtag],
                resultsLimit: 20,
            });
            const { items } = await apify.client.dataset(run.defaultDatasetId).listItems();
            const posts = items.map(item => ({
                platform: 'instagram',
                post_url: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ''),
                author_name: item.ownerUsername || 'Unknown',
                author_url: item.ownerUsername ? `https://www.instagram.com/${item.ownerUsername}/` : '',
                content: item.caption || item.text || '',
                post_created_at: parseTimestamp(item.timestamp || item.takenAt),
                scraped_at: new Date().toISOString(),
            })).filter(p => p.content && p.content.length > 15);
            allPosts.push(...posts);
            console.log(`[IG:Apify] ✓ ${posts.length} posts`);
            await delay(2000);
        } catch (err) {
            if (isApifyExhausted(err.message)) {
                markApifyTokenExhausted(apify.token);
                apify = getActiveApifyClient(); // Try next token
                if (apify) { console.log(`[IG:Apify] 🔄 Switching to next Apify token...`); continue; }
            }
            console.log(`[IG:Apify] ❌ ${err.message}`);
        }
    }
    return allPosts;
}

async function scrapeInstagram(hashtags, maxPosts = 30) {
    console.log(`[Scraper:IG] 📷 ${hashtags.length} hashtags...`);
    return await fetchWithFallback('IG',
        () => igFromRapidAPI(hashtags, maxPosts),
        () => igFromApify(hashtags, maxPosts),
    );
}

// ╔══════════════════════════════════════════════════════╗
// ║  TIKTOK                                              ║
// ╚══════════════════════════════════════════════════════╝

async function ttFromRapidAPI(keywords, maxPosts) {
    const host = 'tiktok-scraper7.p.rapidapi.com';
    const headers = rapidHeaders(host);
    if (!headers) throw new Error('No RAPIDAPI_KEY');
    const allPosts = [];
    // FIX: Giảm xuống 2 keyword, 3 video, 5 comment
    for (const keyword of keywords.slice(0, 2)) {
        console.log(`[TT:RapidAPI] → "${keyword}"`);
        try {
            const searchResp = await axios.get(`https://${host}/feed/search`, {
                headers,
                params: { keywords: keyword, count: 3, cursor: 0, region: 'us' }, // FIX: 3 videos thay vì nhiều hơn
                timeout: 30000,
            });
            const videos = searchResp.data?.data?.videos || [];
            for (const video of videos.slice(0, 3)) {
                const videoId = video.video_id || video.aweme_id;
                if (!videoId) continue;
                try {
                    const commentResp = await axios.get(`https://${host}/comment/list`, {
                        headers,
                        params: { url: `https://www.tiktok.com/@user/video/${videoId}`, count: 5 }, // FIX: 5 comments thay vì 10
                        timeout: 30000,
                    });
                    const comments = commentResp.data?.data?.comments || [];
                    const posts = comments
                        .filter(c => c.text && c.text.length > 5 && c.text.length < 300)
                        .map(c => ({
                            platform: 'tiktok',
                            post_url: `https://www.tiktok.com/@${video.author?.unique_id || 'user'}/video/${videoId}`,
                            author_name: c.user?.unique_id || 'Unknown',
                            author_url: c.user?.unique_id ? `https://www.tiktok.com/@${c.user.unique_id}` : '',
                            content: c.text || '',
                            post_created_at: parseTimestamp(c.create_time),
                            scraped_at: new Date().toISOString(),
                        }));
                    allPosts.push(...posts);
                    await delay(1000);
                } catch (e) { console.log(`[TT] ✗ comments: ${e.message}`); }
            }
        } catch (err) {
            if (isRateLimited(err)) throw err;
            console.log(`[TT:RapidAPI] ✗ "${keyword}": ${err.message}`);
        }
        await delay(1500);
    }
    console.log(`[TT:RapidAPI] ✓ ${allPosts.length} comments total`);
    return allPosts.slice(0, maxPosts);
}

async function ttFromApify(keywords, maxPosts) {
    if (!canSpendApify()) throw new Error('Daily Apify budget reached');
    let apify = getActiveApifyClient();
    if (!apify) throw new Error('No active Apify tokens');
    const allPosts = [];

    for (const keyword of keywords.slice(0, 2)) {
        console.log(`[TT:Apify] → "${keyword}"`);
        try {
            if (!apify) { apify = getActiveApifyClient(); if (!apify) break; }
            recordApifySpend();
            const run = await apify.client.actor('clockworks/tiktok-scraper').call({
                searchQueries: [keyword],
                resultsPerPage: 10,
                maxItems: 10,
                shouldDownloadVideos: false,
                shouldDownloadCovers: false,
            });
            const { items } = await apify.client.dataset(run.defaultDatasetId).listItems();
            const posts = items
                .filter(v => v.text && v.text.length > 10)
                .map(v => ({
                    platform: 'tiktok',
                    post_url: v.webVideoUrl || v.url || '',
                    author_name: v.authorMeta?.name || v.authorMeta?.nickName || 'Unknown',
                    author_url: v.authorMeta?.name ? `https://www.tiktok.com/@${v.authorMeta.name}` : '',
                    content: v.text || '',
                    post_created_at: parseTimestamp(v.createTimeISO || v.createTime),
                    scraped_at: new Date().toISOString(),
                }));
            allPosts.push(...posts);
            console.log(`[TT:Apify] ✓ ${posts.length} posts`);
            await delay(2000);
        } catch (err) {
            if (isApifyExhausted(err.message)) {
                markApifyTokenExhausted(apify.token);
                apify = getActiveApifyClient();
                if (apify) { console.log(`[TT:Apify] 🔄 Switching to next Apify token...`); continue; }
            }
            console.log(`[TT:Apify] ❌ ${err.message}`);
        }
    }
    return allPosts.slice(0, maxPosts);
}

async function scrapeTikTok(keywords, maxPosts = 20) {
    console.log(`[Scraper:TikTok] 🎵 ${keywords.length} keywords...`);
    return await fetchWithFallback('TikTok',
        () => ttFromRapidAPI(keywords, maxPosts),
        () => ttFromApify(keywords, maxPosts),
    );
}

// ╔══════════════════════════════════════════════════════╗
// ║  REDDIT — 100% FREE                                  ║
// ╚══════════════════════════════════════════════════════╝
async function scrapeReddit(keywords, maxPosts = 30) {
    console.log(`[Scraper:Reddit] 🟠 Free JSON API...`);
    const allPosts = [];
    const headers = { 'User-Agent': 'THGLeadBot/1.0', 'Accept': 'application/json' };
    for (const keyword of keywords.slice(0, 3)) {
        try {
            const resp = await axios.get(
                `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&limit=10`,
                { headers, timeout: 15000 }
            );
            const posts = (resp.data?.data?.children || [])
                .filter(c => c.kind === 't3').map(c => c.data)
                .map(item => ({
                    platform: 'reddit',
                    post_url: `https://www.reddit.com${item.permalink}`,
                    author_name: item.author || 'Unknown',
                    content: [item.title, item.selftext || ''].filter(Boolean).join('\n\n'),
                    post_created_at: parseTimestamp(item.created_utc),
                    scraped_at: new Date().toISOString(),
                })).filter(p => p.content.length > 15);
            allPosts.push(...posts);
            await delay(2000);
        } catch (err) { console.error(`[Reddit] ✗ "${keyword}": ${err.message}`); }
    }
    return dedup(allPosts);
}

// ╔══════════════════════════════════════════════════════╗
// ║  TWITTER — DISABLED                                  ║
// ╚══════════════════════════════════════════════════════╝
// FIX: Tắt hoàn toàn. $0.40/run, không phù hợp với target audience (seller Việt).
// Seller Việt dùng Facebook và TikTok, không dùng Twitter.
async function scrapeTwitter(keywords, maxPosts = 50) {
    console.log('[Scraper:X] ⏭️  Twitter/X disabled — không phù hợp với target. Skipping.');
    return [];
}

// ╔══════════════════════════════════════════════════════╗
// ║  FACEBOOK                                            ║
// ╚══════════════════════════════════════════════════════╝

function extractFBFields(item) {
    const flat = {};
    for (const [k, v] of Object.entries(item)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [nk, nv] of Object.entries(v)) flat[`${k}.${nk}`] = nv;
        } else { flat[k] = v; }
    }
    const findByKey = (patterns, filter) => {
        for (const p of patterns)
            for (const [k, v] of Object.entries(flat))
                if (typeof v === 'string' && v.length > 0 && k.toLowerCase().includes(p))
                    if (!filter || filter(v)) return v;
        return null;
    };
    const authorName = findByKey(['user_username', 'author_name', 'user.name', 'display_name', 'name'], v => v.length < 60 && !v.includes('http')) || 'Unknown';
    const rawDate = findByKey(['date_posted', 'created_time', 'created_at', 'timestamp']);
    const content = findByKey(['post_text', 'message', 'content', 'text'], v => v.length > 10) || '';
    const postUrl = findByKey(['post_url', 'permalink'], v => v.startsWith('http')) || item.url || '';
    return { authorName, rawDate, content, postUrl };
}

const FB_API_HOSTS = [
    { host: 'facebook-scraper3.p.rapidapi.com', path: '/search/posts', paramKey: 'query' },
    { host: 'facebook-pages-scraper2.p.rapidapi.com', path: '/search_facebook_posts', paramKey: 'query' },
];

async function fbFromRapidAPI(keywords, maxPosts) {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) throw new Error('No RAPIDAPI_KEY');
    const allPosts = [];
    for (const api of FB_API_HOSTS) {
        try {
            // FIX: Chỉ lấy 2 keyword, 10 posts mỗi keyword
            for (const keyword of keywords.slice(0, 2)) {
                console.log(`[FB:RapidAPI] → "${keyword}" via ${api.host}`);
                const resp = await axios.get(`https://${api.host}${api.path}`, {
                    headers: { 'x-rapidapi-host': api.host, 'x-rapidapi-key': apiKey },
                    params: { [api.paramKey]: keyword, page: 1, limit: 10 },
                    timeout: 30000,
                });
                const data = resp.data?.results || resp.data?.data || resp.data?.posts || [];
                const posts = (Array.isArray(data) ? data : []).slice(0, 10).map(item => {
                    const e = extractFBFields(item);
                    return {
                        platform: 'facebook',
                        post_url: e.postUrl,
                        author_name: e.authorName,
                        content: e.content,
                        post_created_at: parseTimestamp(e.rawDate),
                        scraped_at: new Date().toISOString(),
                    };
                }).filter(p => p.content && p.content.length > 15);
                allPosts.push(...posts);
                console.log(`[FB:RapidAPI] ✓ ${posts.length} posts`);
                await delay(1500);
            }
            return allPosts;
        } catch (err) {
            if (isRateLimited(err)) { console.log(`[FB:RapidAPI] ❌ ${api.host} → 429`); continue; }
            console.log(`[FB:RapidAPI] ⚠️ ${api.host} → ${err.message}`); continue;
        }
    }
    throw new Error('All FB RapidAPI hosts exhausted');
}

async function fbFromApify(keywords, maxPosts) {
    if (!canSpendApify()) throw new Error('Daily Apify budget reached');
    let apify = getActiveApifyClient();
    if (!apify) throw new Error('No active Apify tokens');
    const allPosts = [];
    for (const keyword of keywords.slice(0, 2)) {
        console.log(`[FB:Apify] → "${keyword}"`);
        try {
            if (!apify) { apify = getActiveApifyClient(); if (!apify) break; }
            recordApifySpend();
            const run = await apify.client.actor('apify/facebook-search-scraper').call({
                searchQueries: [keyword],
                maxPosts: 10,
                searchType: 'posts',
            });
            const { items } = await apify.client.dataset(run.defaultDatasetId).listItems();
            const posts = items.map(item => ({
                platform: 'facebook',
                post_url: item.url || item.postUrl || '',
                author_name: item.authorName || item.userName || 'Unknown',
                content: item.text || item.postText || item.message || '',
                post_created_at: parseTimestamp(item.time || item.date || item.createdAt),
                scraped_at: new Date().toISOString(),
            })).filter(p => p.content && p.content.length > 15);
            allPosts.push(...posts);
            console.log(`[FB:Apify] ✓ ${posts.length} posts`);
            await delay(2000);
        } catch (err) {
            if (isApifyExhausted(err.message)) {
                markApifyTokenExhausted(apify.token);
                apify = getActiveApifyClient();
                if (apify) { console.log(`[FB:Apify] 🔄 Switching to next Apify token...`); continue; }
            }
            console.log(`[FB:Apify] ❌ ${err.message}`);
        }
    }
    return allPosts;
}

// FIX: DISABLED Facebook Groups scraper
// Lý do: 22 groups × apify cost = credit hết trong 1-2 ngày
// Thay thế: Dùng keyword search targeting đúng group content
async function fbGroupsDisabled() {
    console.log('[FB:Groups] ⏭️  Group scraper disabled — quá tốn credit ($X × 22 groups).');
    console.log('[FB:Groups] 💡 Thay thế: Keyword search đã include các group-specific terms.');
    return [];
}

async function scrapeFacebook(keywords, maxPosts = 20) {
    console.log(`[Scraper:FB] 📘 ${keywords.length} keywords...`);
    // FIX: Không chạy group scraper nữa
    const posts = await fetchWithFallback('Facebook',
        () => fbFromRapidAPI(keywords, maxPosts),
        () => fbFromApify(keywords, maxPosts),
    );
    return posts;
}

// ╔══════════════════════════════════════════════════════╗
// ║  ORCHESTRATOR                                        ║
// ╚══════════════════════════════════════════════════════╝
async function fetchWithFallback(platformName, primaryFn, fallbackFn) {
    try {
        const posts = await primaryFn();
        if (posts.length > 0) {
            console.log(`[${platformName}] ⚡ RapidAPI OK → ${posts.length} posts`);
            return dedup(posts);
        }
        console.log(`[${platformName}] ⚠️ RapidAPI → 0 posts, trying Apify...`);
    } catch (err) {
        console.warn(`[${platformName}] ⚠️ RapidAPI failed (${isRateLimited(err) ? '429' : err.message}). Trying Apify...`);
    }
    try {
        const posts = await fallbackFn();
        console.log(`[${platformName}] 🔋 Apify → ${posts.length} posts`);
        return dedup(posts);
    } catch (err) {
        console.error(`[${platformName}] ❌ Both failed: ${err.message}`);
    }
    return [];
}

function dedup(posts) {
    const seen = new Set();
    return posts.filter(p => {
        const key = p.post_url || p.content?.substring(0, 100);
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
    });
}

// ╔══════════════════════════════════════════════════════╗
// ║  FULL SCAN                                           ║
// ╚══════════════════════════════════════════════════════╝
const SCRAPERS = {
    // FIX: Twitter removed từ SCRAPERS map
    facebook: { fn: scrapeFacebook, getKeywords: () => config.SEARCH_KEYWORDS.facebook },
    instagram: { fn: scrapeInstagram, getKeywords: () => config.SEARCH_KEYWORDS.instagram },
    tiktok: { fn: scrapeTikTok, getKeywords: () => config.SEARCH_KEYWORDS.tiktok },
    reddit: { fn: scrapeReddit, getKeywords: () => config.SEARCH_KEYWORDS.reddit },
};

async function runFullScan(options = {}) {
    // FIX: Default platforms không còn twitter
    const platforms = options.platforms || ['facebook', 'instagram', 'tiktok', 'reddit'];
    const maxPerPlatform = options.maxPosts || 20;

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  💰 Daily Apify budget: $${DAILY_APIFY_BUDGET_USD}`);
    console.log(`  📊 Max per platform: ${maxPerPlatform} posts`);
    console.log(`${'═'.repeat(55)}\n`);

    const results = {};
    for (const platform of platforms) {
        const scraper = SCRAPERS[platform];
        if (!scraper) { console.error(`[Scraper] Unknown platform: ${platform}`); continue; }
        try {
            const keywords = scraper.getKeywords();
            results[platform] = await scraper.fn(keywords, maxPerPlatform);
            console.log(`[Scraper] ✅ ${platform}: ${results[platform].length} posts\n`);
        } catch (err) {
            console.error(`[Scraper] ❌ ${platform}: ${err.message}`);
            results[platform] = [];
        }
        // FIX: Delay giữa các platform để tránh rate limit
        await delay(3000);
    }

    const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  📊 Total: ${total} posts | Apify spent: ~$${apifySpentToday.toFixed(3)}`);
    Object.entries(results).forEach(([p, r]) => console.log(`     ${p}: ${r.length}`));
    console.log(`${'═'.repeat(55)}\n`);

    return results;
}

module.exports = {
    scrapeFacebook, scrapeInstagram, scrapeReddit,
    scrapeTwitter, // stub — returns []
    scrapeTikTok, runFullScan,
    fbFromGroups: fbGroupsDisabled, // stub
};
