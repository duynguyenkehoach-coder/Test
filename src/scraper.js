/**
 * THG Lead Gen — Multi-Platform Scraper v3
 * 
 * ============================================================
 * CHIẾN LƯỢC: Vắt kiệt Free → Fallback sang Paid
 * ============================================================
 * 
 * Mỗi platform có 2+ nguồn data:
 *   1. RapidAPI  (FREE tier, ưu tiên dùng trước)
 *   2. Apify     (FREE $5/mo hoặc paid, dùng khi RapidAPI gãy)
 *   3. Direct    (Reddit JSON — hoàn toàn free, không giới hạn)
 * 
 * Hàm orchestrator tự động: 
 *   try RapidAPI → catch 429 → try Apify → catch → return []
 * ============================================================
 */

const axios = require('axios');
const config = require('./config');

// --- Apify client (fallback) ---
let apifyClient = null;
try {
    const { ApifyClient } = require('apify-client');
    if (config.APIFY_TOKEN) {
        apifyClient = new ApifyClient({ token: config.APIFY_TOKEN });
    }
} catch (e) { /* apify-client not installed */ }

const RAPIDAPI_KEY = config.RAPIDAPI_KEY;

function rapidHeaders(host) {
    if (!RAPIDAPI_KEY) return null;
    return {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': host,
    };
}

function isRateLimited(err) {
    const status = err.response?.status;
    const msg = (err.response?.data?.message || err.message || '').toLowerCase();
    return status === 429
        || status === 403
        || msg.includes('rate limit')
        || msg.includes('quota')
        || msg.includes('exceeded')
        || msg.includes('too many');
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  INSTAGRAM                                                ║
// ╚═══════════════════════════════════════════════════════════╝

function parseTimestamp(val) {
    if (!val) return null;
    // Unix timestamp (seconds)
    if (typeof val === 'number' && val < 20000000000) return new Date(val * 1000).toISOString();
    // Unix timestamp (ms)
    if (typeof val === 'number') return new Date(val).toISOString();

    // Relative date parsing for Facebook/Twitter texts ("2 hrs ago", "Just now", "Yesterday")
    if (typeof val === 'string') {
        const lower = val.toLowerCase().trim();
        const now = new Date();

        // "Just now", "Vừa xong"
        if (lower.includes('just now') || lower.includes('vừa xong') || lower === 'now') {
            return now.toISOString();
        }

        // "x mins ago", "x min", "x m"
        const minMatch = lower.match(/(?:^|\s)(\d+)\s*(?:m|min|mins|phút)/);
        if (minMatch) {
            return new Date(now.getTime() - parseInt(minMatch[1]) * 60000).toISOString();
        }

        // "x hours ago", "x hrs", "x h"
        const hrMatch = lower.match(/(?:^|\s)(\d+)\s*(?:h|hr|hrs|hour|hours|giờ)/);
        if (hrMatch) {
            return new Date(now.getTime() - parseInt(hrMatch[1]) * 3600000).toISOString();
        }

        // "x days ago", "x d", "x day"
        const dayMatch = lower.match(/(?:^|\s)(\d+)\s*(?:d|day|days|ngày)/);
        if (dayMatch) {
            return new Date(now.getTime() - parseInt(dayMatch[1]) * 86400000).toISOString();
        }

        // "Yesterday at X"
        if (lower.includes('yesterday') || lower.includes('hôm qua')) {
            return new Date(now.getTime() - 86400000).toISOString();
        }

        // Month names handling (e.g. "February 20", "Feb 20", "9 January")
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        // Match either "Jan 9", "January 9", "9 Jan", or "9 January"
        const monthMatch = lower.match(/(?:([a-z]{3,})\s+(\d{1,2}))|(?:(\d{1,2})\s+([a-z]{3,}))/);

        if (monthMatch) {
            const mStr = monthMatch[1] || monthMatch[4];
            const dStr = monthMatch[2] || monthMatch[3];

            if (months.some(m => mStr.startsWith(m))) {
                const dateStr = `${mStr} ${dStr} ${now.getFullYear()}`;
                const parsedDate = new Date(dateStr);

                if (!isNaN(parsedDate.getTime())) {
                    // If the parsed date is in the future (e.g., today is Feb, post says "Dec 9"), it means last year
                    if (parsedDate > now) {
                        parsedDate.setFullYear(now.getFullYear() - 1);
                    }
                    return parsedDate.toISOString();
                }
            }
        }
    }

    // Standard Date string parsing (ISO or MM/DD/YYYY)
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toISOString();

    // Failed to parse
    console.warn(`[Parser] Could not parse date string: "${val}"`);
    return null;
}

// --- Source 1: RapidAPI with MULTI-HOST ROTATION ---
const IG_API_HOSTS = [
    { host: 'instagram-scraper-api2.p.rapidapi.com', path: '/v1/hashtag', paramKey: 'hashtag', dataPath: 'data.items', method: 'GET' },
    { host: 'instagram-scrapper-new.p.rapidapi.com', path: '/getFeedByHashtagLegacy', paramKey: 'hashtag', dataPath: 'items', method: 'POST' },
];

async function igFromRapidAPI(hashtags, maxPosts) {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) throw new Error('No RAPIDAPI_KEY');

    const allPosts = [];

    for (const api of IG_API_HOSTS) {
        try {
            console.log(`[IG:RapidAPI]   🔄 Trying: ${api.host}`);

            for (const hashtag of hashtags.slice(0, 5)) {
                console.log(`[IG:RapidAPI]   → #${hashtag}`);
                const reqConfig = {
                    headers: { 'x-rapidapi-host': api.host, 'x-rapidapi-key': apiKey },
                    timeout: 30000,
                };
                let resp;
                if (api.method === 'POST') {
                    resp = await axios.post(`https://${api.host}${api.path}`,
                        { [api.paramKey]: hashtag },
                        reqConfig
                    );
                } else {
                    resp = await axios.get(`https://${api.host}${api.path}`, {
                        ...reqConfig,
                        params: { [api.paramKey]: hashtag },
                    });
                }

                // Dynamic data extraction based on dataPath
                let items = resp.data;
                for (const key of api.dataPath.split('.')) {
                    items = items?.[key];
                }
                items = items || resp.data?.data?.medias || resp.data?.items || [];

                const posts = (Array.isArray(items) ? items : [])
                    .slice(0, Math.ceil(maxPosts / hashtags.length))
                    .map((item) => ({
                        platform: 'instagram',
                        post_url: item.code ? `https://www.instagram.com/p/${item.code}/`
                            : (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : (item.url || '')),
                        author_name: item.user?.username || item.owner?.username || item.ownerUsername || 'Unknown',
                        author_url: (item.user?.username || item.owner?.username || item.ownerUsername)
                            ? `https://www.instagram.com/${item.user?.username || item.owner?.username || item.ownerUsername}/` : '',
                        author_avatar: item.user?.profile_pic_url || item.owner?.profile_pic_url || '',
                        content: item.caption?.text || item.caption || item.text || '',
                        post_created_at: parseTimestamp(item.taken_at || item.created_at || item.timestamp),
                        scraped_at: new Date().toISOString(),
                    }))
                    .filter((p) => p.content && p.content.length > 15);

                allPosts.push(...posts);
                console.log(`[IG:RapidAPI]   ✓ ${posts.length} posts`);
                await new Promise((r) => setTimeout(r, 1000));
            }

            console.log(`[IG:RapidAPI] ✅ ${api.host} worked! Total: ${allPosts.length} posts`);
            return allPosts;

        } catch (err) {
            if (isRateLimited(err)) {
                console.log(`[IG:RapidAPI]   ❌ ${api.host} → 429 (monthly limit). Trying next...`);
                continue;
            }
            console.log(`[IG:RapidAPI]   ⚠️ ${api.host} → ${err.response?.status || err.message}. Trying next...`);
            continue;
        }
    }

    throw new Error('All Instagram RapidAPI hosts exhausted (monthly limits)');
}

// --- Source 2: Apify fallback ---
async function igFromApify(hashtags, maxPosts) {
    if (!apifyClient) throw new Error('Apify client not available');
    const allPosts = [];
    for (const hashtag of hashtags.slice(0, 5)) {
        console.log(`[IG:Apify]   → #${hashtag}`);
        const run = await apifyClient.actor('apify/instagram-hashtag-scraper').call({
            hashtags: [hashtag],
            resultsLimit: Math.ceil(maxPosts / hashtags.length),
        });
        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
        const posts = items
            .map((item) => ({
                platform: 'instagram',
                post_url: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ''),
                author_name: item.ownerUsername || 'Unknown',
                author_url: item.ownerUsername ? `https://www.instagram.com/${item.ownerUsername}/` : '',
                content: item.caption || item.text || '',
                post_created_at: parseTimestamp(item.timestamp || item.takenAt),
                scraped_at: new Date().toISOString(),
            }))
            .filter((p) => p.content && p.content.length > 15);
        allPosts.push(...posts);
        console.log(`[IG:Apify]   ✓ ${posts.length} posts`);
    }
    return allPosts;
}

// --- Orchestrator ---
async function scrapeInstagram(hashtags, maxPosts = 50) {
    console.log(`[Scraper:IG] 📷 Searching Instagram (${hashtags.length} hashtags)...`);
    return await fetchWithFallback('IG',
        () => igFromRapidAPI(hashtags, maxPosts),
        () => igFromApify(hashtags, maxPosts),
    );
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  TIKTOK                                                   ║
// ╚═══════════════════════════════════════════════════════════╝

// --- Source 1: RapidAPI ---
async function ttFromRapidAPI(keywords, maxPosts) {
    const host = 'tiktok-scraper7.p.rapidapi.com';
    const headers = rapidHeaders(host);
    if (!headers) throw new Error('No RAPIDAPI_KEY');

    const allPosts = [];
    const maxVideosPerKeyword = 3;
    const maxCommentsPerVideo = 10;

    for (const keyword of keywords.slice(0, 3)) { // Limit to 3 keywords to save API calls
        console.log(`[TT:RapidAPI]   → Searching videos for: "${keyword}"`);

        try {
            // STEP 1: Get top videos for the keyword
            const searchResp = await axios.get(`https://${host}/feed/search`, {
                headers,
                params: { keywords: keyword, count: maxVideosPerKeyword, cursor: 0, region: 'us' },
                timeout: 30000,
            });

            const videos = searchResp.data?.data?.videos || searchResp.data?.data || [];
            if (!Array.isArray(videos)) continue;

            // STEP 2: For each video, get its comments
            for (const video of videos.slice(0, maxVideosPerKeyword)) {
                const videoId = video.video_id || video.aweme_id || video.id;
                if (!videoId) continue;

                console.log(`[TT:RapidAPI]     ↳ Fetching comments for video: ${videoId}`);

                try {
                    const commentResp = await axios.get(`https://${host}/comment/list`, {
                        headers,
                        params: { url: `https://www.tiktok.com/@user/video/${videoId}`, count: maxCommentsPerVideo, cursor: 0 },
                        timeout: 30000,
                    });

                    const comments = commentResp.data?.data?.comments || [];

                    const posts = comments
                        .filter(c => c.text && c.text.length > 5 && c.text.length < 300) // Khách thường comment ngắn gọn
                        .map((c) => ({
                            platform: 'tiktok',
                            post_url: `https://www.tiktok.com/@${video.author?.unique_id || 'user'}/video/${videoId}`, // Link to video
                            author_name: c.user?.unique_id || c.user?.nickname || 'Unknown',
                            author_url: c.user?.unique_id ? `https://www.tiktok.com/@${c.user.unique_id}` : '',
                            content: c.text || '', // The COMMENT is explicitly what we want
                            post_created_at: parseTimestamp(c.create_time),
                            scraped_at: new Date().toISOString(),
                        }));

                    allPosts.push(...posts);
                    await new Promise((r) => setTimeout(r, 1000)); // Respect rate limits
                } catch (e) {
                    console.log(`[TT:RapidAPI]     ✗ Could not fetch comments: ${e.message}`);
                }
            }
        } catch (err) {
            console.error(`[TT:RapidAPI]   ✗ Video search failed for "${keyword}":`, err.message);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`[TT:RapidAPI]   ✓ Extracted ${allPosts.length} COMMENTS in total.`);
    return allPosts.slice(0, maxPosts);
}

// --- Source 2: Apify fallback ---
async function ttFromApify(keywords, maxPosts) {
    if (!apifyClient) throw new Error('Apify client not available');
    const allPosts = [];
    const maxVideosPerKeyword = 3;
    const maxCommentsPerVideo = 10;

    for (const keyword of keywords.slice(0, 3)) {
        console.log(`[TT:Apify]   → Searching videos for: "${keyword}"`);
        try {
            // STEP 1: Search videos
            const searchRun = await apifyClient.actor('clockworks/tiktok-scraper').call({
                searchQueries: [keyword],
                resultsPerPage: maxVideosPerKeyword,
                maxItems: maxVideosPerKeyword,
                shouldDownloadVideos: false,
            });

            const { items: videos } = await apifyClient.dataset(searchRun.defaultDatasetId).listItems();
            const videoUrls = videos.map(v => v.webVideoUrl || v.url).filter(Boolean);

            if (videoUrls.length === 0) continue;

            // STEP 2: Scrape comments for those videos
            console.log(`[TT:Apify]     ↳ Fetching comments for ${videoUrls.length} videos`);
            const commentRun = await apifyClient.actor('clockworks/tiktok-comments-scraper').call({
                postURLs: videoUrls,
                commentsPerPost: maxCommentsPerVideo,
            });

            const { items: comments } = await apifyClient.dataset(commentRun.defaultDatasetId).listItems();

            const posts = comments
                .filter(c => c.text && c.text.length > 5 && c.text.length < 300)
                .map((c) => ({
                    platform: 'tiktok',
                    post_url: c.postUrl || '',
                    author_name: c.authorMeta?.name || c.authorMeta?.nickName || c.uniqueId || 'Unknown',
                    author_url: c.uniqueId ? `https://www.tiktok.com/@${c.uniqueId}` : '',
                    content: c.text || '', // The COMMENT
                    post_created_at: parseTimestamp(c.createTimeISO || c.createTime),
                    scraped_at: new Date().toISOString(),
                }));

            allPosts.push(...posts);
            console.log(`[TT:Apify]   ✓ Extracted ${posts.length} comments from "${keyword}"`);
        } catch (err) {
            console.error(`[TT:Apify]   ✗ Search failed for "${keyword}":`, err.message);
        }
    }
    return allPosts.slice(0, maxPosts);
}

// --- Orchestrator ---
async function scrapeTikTok(keywords, maxPosts = 50) {
    console.log(`[Scraper:TikTok] 🎵 Searching TikTok (${keywords.length} keywords)...`);
    return await fetchWithFallback('TikTok',
        () => ttFromRapidAPI(keywords, maxPosts),
        () => ttFromApify(keywords, maxPosts),
    );
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  REDDIT — Direct JSON API (100% FREE, không cần fallback)║
// ╚═══════════════════════════════════════════════════════════╝

async function scrapeReddit(keywords, maxPosts = 50) {
    console.log(`[Scraper:Reddit] 🟠 Direct JSON API (FREE, không giới hạn)...`);
    const allPosts = [];
    const headers = { 'User-Agent': 'THGLeadBot/1.0', 'Accept': 'application/json' };

    // Search global
    for (const keyword of keywords.slice(0, 5)) {
        try {
            console.log(`[Reddit]   → Search: "${keyword}"`);
            const resp = await axios.get(
                `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&limit=10`,
                { headers, timeout: 15000 }
            );
            if (resp.data?.data?.children) {
                const posts = resp.data.data.children
                    .filter((c) => c.kind === 't3').map((c) => c.data)
                    .map((item) => ({
                        platform: 'reddit',
                        post_url: `https://www.reddit.com${item.permalink}`,
                        author_name: item.author || 'Unknown',
                        author_url: item.author ? `https://www.reddit.com/user/${item.author}/` : '',
                        content: [item.title, item.selftext || ''].filter(Boolean).join('\n\n'),
                        post_created_at: parseTimestamp(item.created_utc),
                        scraped_at: new Date().toISOString(),
                    }))
                    .filter((p) => p.content && p.content.length > 15);
                allPosts.push(...posts);
                console.log(`[Reddit]   ✓ ${posts.length} posts`);
            }
            await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
            console.error(`[Reddit]   ✗ "${keyword}":`, err.message);
        }
    }

    // Browse subreddits
    for (const sub of (config.REDDIT_SUBREDDITS || []).slice(0, 5)) {
        try {
            console.log(`[Reddit]   → r/${sub}`);
            const resp = await axios.get(
                `https://www.reddit.com/r/${sub}/new.json?limit=10`,
                { headers, timeout: 15000 }
            );
            if (resp.data?.data?.children) {
                const posts = resp.data.data.children
                    .filter((c) => c.kind === 't3').map((c) => c.data)
                    .map((item) => ({
                        platform: 'reddit',
                        post_url: `https://www.reddit.com${item.permalink}`,
                        author_name: item.author || 'Unknown',
                        author_url: item.author ? `https://www.reddit.com/user/${item.author}/` : '',
                        content: [item.title, item.selftext || ''].filter(Boolean).join('\n\n'),
                        post_created_at: parseTimestamp(item.created_utc),
                        scraped_at: new Date().toISOString(),
                    }))
                    .filter((p) => p.content && p.content.length > 15);
                allPosts.push(...posts);
                console.log(`[Reddit]   ✓ ${posts.length} posts from r/${sub}`);
            }
            await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
            console.error(`[Reddit]   ✗ r/${sub}:`, err.message);
        }
    }

    return dedup(allPosts);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  TWITTER / X                                              ║
// ╚═══════════════════════════════════════════════════════════╝

// --- Source 1: RapidAPI ---
async function xFromRapidAPI(keywords, maxPosts) {
    const host = 'twitter154.p.rapidapi.com';
    const headers = rapidHeaders(host);
    if (!headers) throw new Error('No RAPIDAPI_KEY');

    const allPosts = [];
    for (const keyword of keywords.slice(0, 3)) {
        console.log(`[X:RapidAPI]   → "${keyword}"`);
        const resp = await axios.get(`https://${host}/search/search`, {
            headers,
            params: { query: keyword, section: 'latest', min_retweets: 1, limit: 20 },
            timeout: 30000,
        });
        const results = resp.data?.results || resp.data?.data || [];
        const posts = (Array.isArray(results) ? results : [])
            .map((item) => ({
                platform: 'twitter',
                post_url: item.expanded_url || item.tweet_url
                    || (item.tweet_id ? `https://x.com/i/status/${item.tweet_id}` : ''),
                author_name: item.user?.username || item.user?.screen_name || 'Unknown',
                author_url: item.user?.username ? `https://x.com/${item.user.username}` : '',
                content: item.text || item.full_text || '',
                post_created_at: parseTimestamp(item.creation_date || item.created_at),
                scraped_at: new Date().toISOString(),
            }))
            .filter((p) => p.content && p.content.length > 15);
        allPosts.push(...posts);
        console.log(`[X:RapidAPI]   ✓ ${posts.length} tweets`);
        await new Promise((r) => setTimeout(r, 1000));
    }
    return allPosts;
}

// --- Source 2: Apify fallback ---
async function xFromApify(keywords, maxPosts) {
    if (!apifyClient) throw new Error('Apify client not available');
    const allPosts = [];
    for (const keyword of keywords.slice(0, 3)) {
        console.log(`[X:Apify]   → "${keyword}"`);
        const run = await apifyClient.actor('apidojo/tweet-scraper').call({
            searchTerms: [keyword], maxTweets: 10, sort: 'Latest',
        });
        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
        const posts = items
            .filter((item) => !item.noResults && (item.text || item.full_text))
            .map((item) => ({
                platform: 'twitter',
                post_url: item.url || item.tweetUrl || '',
                author_name: item.author?.userName || 'Unknown',
                author_url: item.author?.userName ? `https://x.com/${item.author.userName}` : '',
                content: item.text || item.full_text || '',
                post_created_at: parseTimestamp(item.createdAt || item.created_at),
                scraped_at: new Date().toISOString(),
            }))
            .filter((p) => p.content && p.content.length > 15);
        allPosts.push(...posts);
        console.log(`[X:Apify]   ✓ ${posts.length} tweets`);
    }
    return allPosts;
}

// --- Orchestrator ---
async function scrapeTwitter(keywords, maxPosts = 50) {
    console.log(`[Scraper:X] 🐦 Searching Twitter/X (${keywords.length} keywords)...`);
    return await fetchWithFallback('Twitter',
        () => xFromRapidAPI(keywords, maxPosts),
        () => xFromApify(keywords, maxPosts),
    );
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  FACEBOOK — Smart Field Extractor                         ║
// ╚═══════════════════════════════════════════════════════════╝

/**
 * Auto-detect author, date, avatar, content from ANY Facebook API response.
 * Scans ALL fields by key-name patterns instead of hardcoding specific field names.
 */
function extractFBFields(item) {
    // Flatten: collect all key=value pairs, including nested objects (1 level deep)
    const flat = {};
    for (const [k, v] of Object.entries(item)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [nk, nv] of Object.entries(v)) {
                flat[`${k}.${nk}`] = nv;
            }
        } else {
            flat[k] = v;
        }
    }

    // Helper: find first string value whose key matches any of the patterns
    function findByKeyPatterns(patterns, filter) {
        for (const pattern of patterns) {
            for (const [k, v] of Object.entries(flat)) {
                if (typeof v === 'string' && v.length > 0 && k.toLowerCase().includes(pattern)) {
                    if (!filter || filter(v)) return v;
                }
            }
        }
        return null;
    }

    // ═══ AUTHOR NAME: keys containing user/author/name/handle/username ═══
    const namePatterns = ['user_username', 'user_handle', 'username_raw', 'author_name',
        'user_name', 'user.name', 'author.name', 'from.name',
        'commenter_name', 'page_name', 'actor_name', 'poster_name',
        'display_name', 'full_name'];
    let authorName = findByKeyPatterns(namePatterns);
    // Fallback: any key with "name" that has a short value (likely a person name, not content)
    if (!authorName) {
        authorName = findByKeyPatterns(['name'], v => v.length < 60 && !v.includes('http'));
    }
    // Fallback: any key with "user" or "handle"  
    if (!authorName) {
        authorName = findByKeyPatterns(['handle', 'user'], v => v.length < 60 && !v.includes('http'));
    }

    // ═══ TIMESTAMP: keys containing date/time/posted/created/published ═══
    const datePatterns = ['date_posted', 'created_time', 'creation_time', 'post_created',
        'created_at', 'published', 'timestamp', 'post_date'];
    let rawDate = findByKeyPatterns(datePatterns);
    // Fallback: any key with "date" or "time" (but not "datetime_format" type meta)
    if (!rawDate) {
        rawDate = findByKeyPatterns(['date', 'time'], v => v.length > 4 && v.length < 100);
    }
    // Also check for Unix timestamp (number)
    if (!rawDate) {
        for (const [k, v] of Object.entries(flat)) {
            if (typeof v === 'number' && v > 1000000000 && v < 2000000000 &&
                (k.toLowerCase().includes('time') || k.toLowerCase().includes('date') || k.toLowerCase().includes('created'))) {
                rawDate = new Date(v * 1000).toISOString();
                break;
            }
        }
    }

    // ═══ AVATAR: keys containing logo/avatar/pic/photo/profile_picture ═══
    const avatarPatterns = ['page_logo', 'profile_picture', 'profile_pic', 'avatar',
        'user_photo', 'actor_photo', 'commenter_pic', 'photo'];
    let authorAvatar = findByKeyPatterns(avatarPatterns, v => v.startsWith('http'));
    // Fallback: any key with "pic" or "logo" or "image" pointing to a URL
    if (!authorAvatar) {
        authorAvatar = findByKeyPatterns(['pic', 'logo', 'image', 'thumb'], v => v.startsWith('http'));
    }

    // ═══ PROFILE URL: keys containing author_url/user_url/profile_url ═══
    const urlPatterns = ['author_url', 'user_url', 'profile_url', 'user.url', 'author.url', 'from.url'];
    let authorUrl = findByKeyPatterns(urlPatterns, v => v.startsWith('http'));
    // If we found an author name, build a FB profile URL
    if (!authorUrl && authorName && authorName !== 'Unknown') {
        authorUrl = `https://www.facebook.com/${encodeURIComponent(authorName)}`;
    }

    // ═══ CONTENT: keys containing text/message/content/post_text/description ═══
    const contentPatterns = ['post_text', 'message', 'content', 'description'];
    let content = findByKeyPatterns(contentPatterns, v => v.length > 10);
    if (!content) content = findByKeyPatterns(['text'], v => v.length > 10);

    // ═══ POST URL ═══  
    const postUrlPatterns = ['post_url', 'permalink', 'link'];
    let postUrl = findByKeyPatterns(postUrlPatterns, v => v.startsWith('http'));
    if (!postUrl) postUrl = findByKeyPatterns(['url'], v => v.startsWith('http') && v.includes('facebook.com'));
    if (!postUrl) postUrl = item.url || '';

    // Log extraction result for first item
    console.log(`[FB:Extract]   👤 ${authorName || 'Unknown'} | 📅 ${rawDate || 'N/A'} | 🖼️ ${authorAvatar ? 'YES' : 'NO'}`);

    return {
        authorName: authorName || 'Unknown',
        authorUrl: authorUrl || '',
        authorAvatar: authorAvatar || '',
        rawDate: rawDate || null,
        content: content || '',
        postUrl: postUrl || '',
    };
}


// --- Source 1: RapidAPI with MULTI-HOST ROTATION ---
// Each API has its own free monthly limit. When one hits 429, try the next!
const FB_API_HOSTS = [
    { host: 'facebook-scraper3.p.rapidapi.com', path: '/search/posts', paramKey: 'query' },
    { host: 'facebook-pages-scraper2.p.rapidapi.com', path: '/search_facebook_posts', paramKey: 'query' },
];

async function fbFromRapidAPI(keywords, maxPosts) {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) throw new Error('No RAPIDAPI_KEY');

    const allPosts = [];

    // Try each API host until one works
    for (const api of FB_API_HOSTS) {
        try {
            console.log(`[FB:RapidAPI]   🔄 Trying: ${api.host}`);
            const testResp = await axios.get(`https://${api.host}${api.path}`, {
                headers: { 'x-rapidapi-host': api.host, 'x-rapidapi-key': apiKey },
                params: { [api.paramKey]: keywords[0], page: 1 },
                timeout: 30000,
            });

            // If we get here, this API works! Extract posts from all keywords
            const results = testResp.data?.results || testResp.data?.data || testResp.data?.posts || [];
            if (Array.isArray(results)) {
                const posts = results.slice(0, 10).map(item => {
                    const extracted = extractFBFields(item);
                    return {
                        platform: 'facebook',
                        post_url: extracted.postUrl,
                        author_name: extracted.authorName,
                        author_url: extracted.authorUrl,
                        author_avatar: extracted.authorAvatar,
                        content: extracted.content,
                        post_created_at: parseTimestamp(extracted.rawDate),
                        scraped_at: new Date().toISOString(),
                    };
                }).filter(p => p.content && p.content.length > 15);
                allPosts.push(...posts);
            }

            // Fetch remaining keywords with this working API
            for (const keyword of keywords.slice(1, 3)) {
                console.log(`[FB:RapidAPI]   → "${keyword}"`);
                try {
                    const resp = await axios.get(`https://${api.host}${api.path}`, {
                        headers: { 'x-rapidapi-host': api.host, 'x-rapidapi-key': apiKey },
                        params: { [api.paramKey]: keyword, page: 1 },
                        timeout: 30000,
                    });
                    const data = resp.data?.results || resp.data?.data || resp.data?.posts || [];
                    const posts = (Array.isArray(data) ? data : []).slice(0, 10).map(item => {
                        const extracted = extractFBFields(item);
                        return {
                            platform: 'facebook',
                            post_url: extracted.postUrl,
                            author_name: extracted.authorName,
                            author_url: extracted.authorUrl,
                            author_avatar: extracted.authorAvatar,
                            content: extracted.content,
                            post_created_at: parseTimestamp(extracted.rawDate),
                            scraped_at: new Date().toISOString(),
                        };
                    }).filter(p => p.content && p.content.length > 15);
                    allPosts.push(...posts);
                    console.log(`[FB:RapidAPI]   ✓ ${posts.length} posts`);
                } catch (innerErr) {
                    if (isRateLimited(innerErr)) break; // Hit limit mid-scan, stop
                }
                await new Promise(r => setTimeout(r, 1000));
            }

            console.log(`[FB:RapidAPI] ✅ ${api.host} worked! Total: ${allPosts.length} posts`);
            return allPosts;

        } catch (err) {
            if (isRateLimited(err)) {
                console.log(`[FB:RapidAPI]   ❌ ${api.host} → 429 (monthly limit). Trying next...`);
                continue;
            }
            // Non-rate-limit error (bad endpoint, 404, etc.) — skip to next
            console.log(`[FB:RapidAPI]   ⚠️ ${api.host} → ${err.response?.status || err.message}. Trying next...`);
            continue;
        }
    }

    throw new Error('All Facebook RapidAPI hosts exhausted (monthly limits)');
}


// --- Source 2: Apify fallback ---
async function fbFromApify(keywords, maxPosts) {
    if (!apifyClient) throw new Error('Apify client not available');
    const allPosts = [];
    for (const keyword of keywords.slice(0, 3)) {
        console.log(`[FB:Apify]   → "${keyword}"`);
        const run = await apifyClient.actor('apify/facebook-search-scraper').call({
            searchQueries: [keyword], maxPosts: 10, searchType: 'posts',
        });
        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
        const posts = items
            .map((item) => ({
                platform: 'facebook',
                post_url: item.url || item.postUrl || item.link || '',
                author_name: item.authorName || item.userName || item.user?.name || item.pageName || 'Unknown',
                author_url: item.authorUrl || item.userUrl || item.user?.url || '',
                author_avatar: item.userProfilePic || item.authorProfilePic || item.profilePicture || '',
                content: item.text || item.postText || item.message || '',
                post_created_at: parseTimestamp(item.time || item.date || item.createdAt || item.timestamp),
                scraped_at: new Date().toISOString(),
            }))
            .filter((p) => p.content && p.content.length > 15);
        allPosts.push(...posts);
        console.log(`[FB:Apify]   ✓ ${posts.length} posts`);
    }
    return allPosts;
}

// --- Source 3: Direct Group Scraping (HIGH PRIORITY) ---
async function fbFromGroups(maxPostsPerGroup = 5) {
    const groups = config.FB_TARGET_GROUPS || [];
    if (groups.length === 0) return [];

    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) return [];

    console.log(`[FB:Groups] 📋 Scraping ${groups.length} target groups...`);
    const allPosts = [];

    for (const group of groups) {
        try {
            console.log(`[FB:Groups]   → ${group.name} (${group.id})`);

            // Try facebook-scraper3 group posts endpoint
            const resp = await axios.get(
                `https://facebook-scraper3.p.rapidapi.com/group/posts`,
                {
                    headers: {
                        'x-rapidapi-host': 'facebook-scraper3.p.rapidapi.com',
                        'x-rapidapi-key': apiKey,
                    },
                    params: { group_id: group.id, page: 1 },
                    timeout: 30000,
                }
            );

            const results = resp.data?.results || resp.data?.data || resp.data?.posts || [];
            const posts = (Array.isArray(results) ? results : [])
                .slice(0, maxPostsPerGroup)
                .map((item) => {
                    const extracted = extractFBFields(item);
                    return {
                        platform: 'facebook',
                        post_url: extracted.postUrl,
                        author_name: extracted.authorName,
                        author_url: extracted.authorUrl,
                        author_avatar: extracted.authorAvatar,
                        content: extracted.content,
                        post_created_at: parseTimestamp(extracted.rawDate),
                        scraped_at: new Date().toISOString(),
                        source_group: group.name, // Tag for priority tracking
                    };
                })
                .filter((p) => p.content && p.content.length > 15);

            allPosts.push(...posts);
            console.log(`[FB:Groups]   ✓ ${posts.length} posts from ${group.name}`);
        } catch (err) {
            if (isRateLimited(err)) {
                console.log(`[FB:Groups]   ❌ Rate limited — stopping group scan`);
                break;
            }
            console.log(`[FB:Groups]   ⚠️ ${group.name}: ${err.response?.status || err.message}`);
        }
        await new Promise((r) => setTimeout(r, 1500)); // Slower to avoid rate limit
    }

    console.log(`[FB:Groups] ✅ Total from groups: ${allPosts.length} posts`);
    return allPosts;
}

// --- Orchestrator ---
async function scrapeFacebook(keywords, maxPosts = 50) {
    console.log(`[Scraper:FB] 📘 Searching Facebook (${keywords.length} keywords + ${(config.FB_TARGET_GROUPS || []).length} groups)...`);

    // Step 1: Scrape target groups FIRST (high priority)
    let groupPosts = [];
    try {
        groupPosts = await fbFromGroups(5);
    } catch (err) {
        console.log(`[Scraper:FB] ⚠️ Group scraping failed: ${err.message}`);
    }

    // Step 2: Keyword search (existing flow)
    let keywordPosts = [];
    try {
        keywordPosts = await fetchWithFallback('Facebook',
            () => fbFromRapidAPI(keywords, maxPosts),
            () => fbFromApify(keywords, maxPosts),
        );
    } catch (err) {
        console.log(`[Scraper:FB] ⚠️ Keyword search failed: ${err.message}`);
    }

    // Merge: groups first (priority), then keyword results
    const allPosts = [...groupPosts, ...keywordPosts];
    console.log(`[Scraper:FB] 📊 Total: ${groupPosts.length} from groups + ${keywordPosts.length} from keywords = ${allPosts.length}`);
    return dedup(allPosts);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  ORCHESTRATOR — Vắt kiệt Free rồi mới dùng Paid         ║
// ╚═══════════════════════════════════════════════════════════╝

async function fetchWithFallback(platformName, primaryFn, fallbackFn) {
    let posts = [];

    // ⚡ Bước 1: Thử RapidAPI (FREE) trước
    try {
        posts = await primaryFn();
        if (posts.length > 0) {
            console.log(`[${platformName}] ⚡ RapidAPI thành công! → ${posts.length} posts`);
            return dedup(posts);
        }
        console.log(`[${platformName}] ⚠️ RapidAPI trả về 0 posts, thử Apify...`);
    } catch (err) {
        const reason = isRateLimited(err) ? '429 hết limit' : err.message;
        console.warn(`[${platformName}] ⚠️ RapidAPI tịt (${reason}). Switch sang Apify...`);
    }

    // 🔋 Bước 2: Fallback sang Apify
    try {
        posts = await fallbackFn();
        if (posts.length > 0) {
            console.log(`[${platformName}] 🔋 Apify cứu cánh! → ${posts.length} posts`);
            return dedup(posts);
        }
        console.log(`[${platformName}] ⚠️ Apify cũng trả về 0 posts`);
    } catch (err) {
        console.error(`[${platformName}] ❌ Cả RapidAPI và Apify đều gãy: ${err.message}`);
    }

    return dedup(posts);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  UTILITIES & FULL SCAN                                    ║
// ╚═══════════════════════════════════════════════════════════╝

function dedup(posts) {
    const seen = new Set();
    return posts.filter((post) => {
        const key = post.post_url || post.content?.substring(0, 100);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const SCRAPERS = {
    instagram: { fn: scrapeInstagram, getKeywords: () => config.SEARCH_KEYWORDS.instagram },
    tiktok: { fn: scrapeTikTok, getKeywords: () => config.SEARCH_KEYWORDS.tiktok },
    reddit: { fn: scrapeReddit, getKeywords: () => config.SEARCH_KEYWORDS.reddit },
    twitter: { fn: scrapeTwitter, getKeywords: () => config.SEARCH_KEYWORDS.twitter },
    facebook: { fn: scrapeFacebook, getKeywords: () => config.SEARCH_KEYWORDS.facebook },
};

async function runFullScan(options = {}) {
    const platforms = options.platforms || config.ENABLED_PLATFORMS || Object.keys(SCRAPERS);
    const maxPerPlatform = options.maxPosts || 15; // Reduced from 30 to conserve API credits
    const results = {};

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🔄 Chiến lược: RapidAPI (FREE) → Apify (Fallback)`);
    console.log(`${'═'.repeat(60)}\n`);

    for (const platform of platforms) {
        const scraper = SCRAPERS[platform];
        if (!scraper) { console.error(`[Scraper] ⚠️ Unknown: ${platform}`); continue; }

        try {
            const keywords = options[`${platform}Keywords`] || scraper.getKeywords();
            results[platform] = await scraper.fn(keywords, maxPerPlatform);
            console.log(`[Scraper] ✅ ${platform}: ${results[platform].length} unique posts\n`);
        } catch (err) {
            console.error(`[Scraper] ❌ ${platform} failed:`, err.message);
            results[platform] = [];
        }
    }

    const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  📊 Grand total: ${total} posts across ${platforms.length} platforms`);
    Object.entries(results).forEach(([p, r]) => console.log(`     ${p}: ${r.length} posts`));
    console.log(`${'═'.repeat(60)}\n`);

    return results;
}

module.exports = {
    scrapeFacebook, scrapeInstagram, scrapeReddit, scrapeTwitter, scrapeTikTok, runFullScan,
};
