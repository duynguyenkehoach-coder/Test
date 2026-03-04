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
const DAILY_APIFY_BUDGET_USD = 0.50; // ~$15/month, enough for groups + TT + IG
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
    if (APIFY_TOKENS.length === 0) {
        console.log('[KeyPool] ⚠️ No Apify tokens configured (check APIFY_TOKEN in .env)');
        return null;
    }
    for (const token of APIFY_TOKENS) {
        if (!exhaustedApifyTokens.has(token)) {
            try {
                const { ApifyClient } = require('apify-client');
                return { client: new ApifyClient({ token }), token };
            } catch (e) {
                console.error(`[KeyPool] ❌ apify-client load failed: ${e.message}`);
                console.error('[KeyPool] 💡 Fix: npm install apify-client');
                return null; // Don't continue loop, package is missing
            }
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

// Startup diagnostics
console.log(`[KeyPool] Loaded: ${RAPIDAPI_KEYS.length} RapidAPI keys, ${APIFY_TOKENS.length} Apify tokens`);
if (APIFY_TOKENS.length > 0) console.log(`[KeyPool] Apify token: ...${APIFY_TOKENS[0].slice(-6)}`);
if (RAPIDAPI_KEYS.length > 0) console.log(`[KeyPool] RapidAPI key: ...${RAPIDAPI_KEYS[0].slice(-6)}`);

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
    const apiKey = getActiveRapidKey();
    if (!apiKey) throw new Error('No RAPIDAPI_KEY');
    const allPosts = [];
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

// ╔══════════════════════════════════════════════════════╗
// ║  FACEBOOK: GROUP SCRAPER (PhantomBuster → Apify)      ║
// ╚══════════════════════════════════════════════════════╝
async function fbFromGroups(maxPosts = 20) {
    const groups = config.FB_TARGET_GROUPS || [];
    if (groups.length === 0) {
        console.log('[FB:Groups] ⚠️ No groups configured');
        return [];
    }

    // Try PhantomBuster first (better for FB — session cookies, private groups)
    if (config.PHANTOMBUSTER_API_KEY) {
        try {
            const pb = require('./phantomBuster');

            // If we have a specific phantom agent ID, use it
            if (config.PB_FB_GROUP_AGENT_ID) {
                console.log('[FB:Groups] 🟣 Using PhantomBuster (agent mode)...');
                const posts = await pb.scrapeMultipleGroups(
                    config.PB_FB_GROUP_AGENT_ID, groups, maxPosts
                );
                if (posts.length > 0) {
                    console.log(`[FB:Groups] ✅ PhantomBuster: ${posts.length} posts`);
                    return posts;
                }
            }

            // Fallback: try each group URL directly
            console.log('[FB:Groups] 🟣 PhantomBuster: fetching latest outputs...');
            const results = await pb.fetchResults(config.PB_FB_GROUP_AGENT_ID || 'latest');
            if (results.length > 0) {
                const posts = results.map(item => ({
                    platform: 'facebook',
                    post_url: item.postUrl || item.url || item.permalink || '',
                    author_name: item.profileName || item.name || item.authorName || item.userName || 'Unknown',
                    author_url: item.profileUrl || item.profileLink || '',
                    content: item.message || item.postContent || item.text || item.postText || '',
                    post_created_at: parseTimestamp(item.date || item.timestamp || item.postedAt),
                    scraped_at: new Date().toISOString(),
                    source: 'phantombuster',
                })).filter(p => p.content && p.content.length > 15);

                if (posts.length > 0) {
                    console.log(`[FB:Groups] ✅ PhantomBuster: ${posts.length} posts (from latest run)`);
                    return posts;
                }
            }

            console.log('[FB:Groups] ⚠️ PhantomBuster returned 0 posts, falling back to Apify...');
        } catch (err) {
            console.warn(`[FB:Groups] ⚠️ PhantomBuster error: ${err.message}, falling back to Apify...`);
        }
    }

    // Fallback: Apify
    if (!canSpendApify()) throw new Error('Daily Apify budget reached');
    let apify = getActiveApifyClient();
    if (!apify) throw new Error('No active Apify tokens');

    console.log('[FB:Groups] 🟠 Using Apify fallback...');
    const allPosts = [];
    const postsPerGroup = Math.ceil(maxPosts / groups.length);

    for (const group of groups) {
        if (!canSpendApify()) break;
        console.log(`[FB:Groups] 📌 ${group.name}...`);
        try {
            if (!apify) { apify = getActiveApifyClient(); if (!apify) break; }
            recordApifySpend();
            const run = await apify.client.actor(config.APIFY_ACTORS.FB_GROUP).call({
                startUrls: [{ url: group.url }],
                maxPosts: postsPerGroup,
                maxComments: 0,
                resultsLimit: postsPerGroup,
            }, { waitSecs: 120 });
            const { items } = await apify.client.dataset(run.defaultDatasetId).listItems();
            const posts = items.map(item => {
                const content = item.text || item.postText || item.message || '';
                return {
                    platform: 'facebook',
                    post_url: item.url || item.postUrl || item.permalink || '',
                    author_name: item.userName || item.authorName || item.user?.name || 'Unknown',
                    author_url: item.userUrl || item.user?.url || '',
                    content,
                    post_created_at: parseTimestamp(item.time || item.date || item.timestamp || item.createdAt),
                    scraped_at: new Date().toISOString(),
                    source: `group:${group.name}`,
                };
            }).filter(p => p.content && p.content.length > 15);
            allPosts.push(...posts);
            console.log(`[FB:Groups] ✓ ${posts.length} posts from ${group.name}`);
            await delay(2000);
        } catch (err) {
            if (isApifyExhausted(err.message)) {
                markApifyTokenExhausted(apify.token);
                apify = getActiveApifyClient();
                if (apify) { console.log('[FB:Groups] 🔄 Switching Apify token...'); continue; }
            }
            console.log(`[FB:Groups] ⚠️ ${group.name}: ${err.message}`);
        }
    }
    console.log(`[FB:Groups] 📊 Total: ${allPosts.length} posts from ${groups.length} groups`);
    return allPosts;
}

// ╔══════════════════════════════════════════════════════╗
// ║  FACEBOOK: COMPETITOR PAGE COMMENTS (BONUS)           ║
// ╚══════════════════════════════════════════════════════╝
async function fbFromPageComments(maxPosts = 10) {
    const pages = config.FB_COMPETITOR_PAGES || [];
    if (pages.length === 0) return [];
    if (!canSpendApify()) return [];
    let apify = getActiveApifyClient();
    if (!apify) return [];

    const allPosts = [];
    for (const page of pages.slice(0, 3)) {
        if (!canSpendApify()) break;
        console.log(`[FB:PageComments] 💬 ${page.name}...`);
        try {
            if (!apify) { apify = getActiveApifyClient(); if (!apify) break; }
            recordApifySpend();
            const run = await apify.client.actor(config.APIFY_ACTORS.FB_PAGE_COMMENTS).call({
                startUrls: [{ url: page.url }],
                maxComments: maxPosts,
                resultsLimit: maxPosts,
            }, { waitSecs: 120 });
            const { items } = await apify.client.dataset(run.defaultDatasetId).listItems();
            const comments = items.map(item => ({
                platform: 'facebook',
                post_url: item.postUrl || item.url || page.url,
                author_name: item.profileName || item.authorName || 'Unknown',
                author_url: item.profileUrl || '',
                content: item.text || item.comment || '',
                post_created_at: parseTimestamp(item.date || item.timestamp),
                scraped_at: new Date().toISOString(),
                source: `page_comment:${page.name}`,
            })).filter(c => c.content && c.content.length > 10);
            allPosts.push(...comments);
            console.log(`[FB:PageComments] ✓ ${comments.length} comments from ${page.name}`);
            await delay(2000);
        } catch (err) {
            if (isApifyExhausted(err.message)) {
                markApifyTokenExhausted(apify.token);
                apify = getActiveApifyClient();
                if (apify) continue;
            }
            console.log(`[FB:PageComments] ⚠️ ${page.name}: ${err.message}`);
        }
    }
    return allPosts;
}

async function scrapeFacebook(_keywords, maxPosts = 20) {
    console.log(`[Scraper:FB] 📘 Scraping ${(config.FB_TARGET_GROUPS || []).length} groups + ${(config.FB_COMPETITOR_PAGES || []).length} competitor pages...`);
    const groupPosts = await fbFromGroups(maxPosts);
    const commentPosts = await fbFromPageComments(Math.ceil(maxPosts / 2));
    const all = [...groupPosts, ...commentPosts];
    console.log(`[Scraper:FB] 📊 Total FB: ${all.length} posts (${groupPosts.length} from groups, ${commentPosts.length} from page comments)`);
    return all;
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
    facebook: { fn: scrapeFacebook, getKeywords: () => [] }, // FB uses groups, not keywords
    instagram: { fn: scrapeInstagram, getKeywords: () => config.SEARCH_KEYWORDS.instagram },
    tiktok: { fn: scrapeTikTok, getKeywords: () => config.SEARCH_KEYWORDS.tiktok },
};

async function runFullScan(options = {}) {
    const platforms = options.platforms || ['facebook', 'tiktok', 'instagram'];
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
    scrapeFacebook, scrapeInstagram,
    scrapeTikTok, runFullScan,
    fbFromGroups, fbFromPageComments,
};
