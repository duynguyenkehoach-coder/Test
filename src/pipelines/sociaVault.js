/**
 * THG Lead Gen — SociaVault API Integration
 * 
 * REST API for all platforms:
 * - Facebook: /v1/scrape/facebook/group/posts  (by group URL)
 * - Instagram: /v1/scrape/instagram/posts       (by handle/account)
 * - TikTok: /v1/scrape/tiktok/videos            (by handle/account)
 * 
 * API: https://api.sociavault.com
 * Auth: X-API-Key header
 * Pricing: 1 credit per standard request
 * Docs: https://docs.sociavault.com
 */

const axios = require('axios');
const config = require('../config');

const SV_API = 'https://api.sociavault.com/v1/scrape';
const SV_KEY = process.env.SOCIAVAULT_API_KEY || config.SOCIAVAULT_API_KEY || '';

function headers() {
    return { 'X-API-Key': SV_KEY };
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 404 health tracking — warn after 3 consecutive failures
const accountHealth = {};
function track404(handle, is404) {
    if (!accountHealth[handle]) accountHealth[handle] = { fails: 0, lastOk: null };
    if (is404) {
        accountHealth[handle].fails++;
        if (accountHealth[handle].fails >= 3) {
            console.warn(`[SV] ⚠️ @${handle} has failed ${accountHealth[handle].fails}x — consider removing or updating this account`);
        }
    } else {
        accountHealth[handle].fails = 0;
        accountHealth[handle].lastOk = new Date().toISOString();
    }
}

/**
 * Generic SociaVault API call
 */
async function svRequest(endpoint, params = {}) {
    if (!SV_KEY) throw new Error('SOCIAVAULT_API_KEY not set');

    const resp = await axios.get(`${SV_API}/${endpoint}`, {
        headers: headers(),
        params,
        timeout: 60000,
    });

    if (!resp.data?.success) {
        throw new Error(resp.data?.error || `SociaVault ${endpoint} failed`);
    }

    return resp.data?.data || resp.data;
}

// ═══════════════════════════════════════════════════════
// FACEBOOK — Group Posts
// Endpoint: facebook/group/posts?url=<group_url>&sort_by=RECENT_ACTIVITY
// Returns ~3 posts per call (Facebook API limit)
// ═══════════════════════════════════════════════════════

async function scrapeFacebookGroups(maxPosts = 30) {
    const groups = config.FB_TARGET_GROUPS || [];
    if (groups.length === 0) { console.log('[SV:FB] ⚠️ No groups configured'); return []; }
    if (!SV_KEY) { console.warn('[SV:FB] ⚠️ No API key'); return []; }

    console.log(`[SV:FB] 📘 Scraping ${groups.length} Facebook groups...`);
    const allPosts = [];

    for (const group of groups) {
        try {
            console.log(`[SV:FB] 📌 ${group.name}...`);
            const data = await svRequest('facebook/group/posts', {
                url: group.url,
                sort_by: 'RECENT_ACTIVITY',
            });

            // SociaVault returns posts as object {0: {...}, 1: {...}, ...}
            const postsObj = data.posts || {};
            const postsArr = typeof postsObj === 'object' && !Array.isArray(postsObj)
                ? Object.values(postsObj)
                : (Array.isArray(postsObj) ? postsObj : []);

            const posts = postsArr.map(item => ({
                platform: 'facebook',
                post_url: item.url || '',
                author_name: item.author?.name || item.author?.short_name || 'Unknown',
                author_url: item.author?.id ? `https://www.facebook.com/${item.author.id}` : '',
                content: item.text || item.message || '',
                post_created_at: item.publishTime
                    ? new Date(item.publishTime * 1000).toISOString()
                    : new Date().toISOString(),
                scraped_at: new Date().toISOString(),
                source: `sv:fb:${group.name}`,
                likes: item.reactionCount || 0,
                comments: item.commentCount || 0,
            })).filter(p => p.content && p.content.length > 15);

            allPosts.push(...posts);
            console.log(`[SV:FB] ✅ ${posts.length} posts from ${group.name}`);
            await delay(2000);
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ ${group.name}: ${err.message}`);
        }
    }

    const result = allPosts.slice(0, maxPosts);
    console.log(`[SV:FB] 📊 Total: ${result.length} posts`);
    return result;
}

// ═══════════════════════════════════════════════════════
// INSTAGRAM — Posts by Account
// Endpoint: instagram/posts?handle=<username>
// Scrapes posts from target seller/competitor accounts
// ═══════════════════════════════════════════════════════

async function scrapeInstagram(maxPosts = 30) {
    const accounts = config.IG_TARGET_ACCOUNTS || [];
    if (accounts.length === 0) { console.log('[SV:IG] ⚠️ No IG accounts configured'); return []; }
    if (!SV_KEY) { console.warn('[SV:IG] ⚠️ No API key'); return []; }

    console.log(`[SV:IG] 📷 Scraping ${accounts.length} Instagram accounts...`);
    const allPosts = [];

    for (const handle of accounts.slice(0, 5)) {
        try {
            console.log(`[SV:IG] @${handle}...`);
            const data = await svRequest('instagram/posts', { handle });

            const postsRaw = data.posts || data.items || data.edges || [];
            const postsArr = Array.isArray(postsRaw) ? postsRaw : Object.values(postsRaw);

            const posts = postsArr.map(item => {
                const node = item.node || item;
                // SociaVault IG: caption is object {text:'...'}, not string!
                const rawCap = node.caption;
                const content = (typeof rawCap === 'string' ? rawCap : rawCap?.text)
                    || node.text
                    || node.description
                    || (node.edge_media_to_caption?.edges?.[0]?.node?.text)
                    || '';
                return {
                    platform: 'instagram',
                    post_url: (node.code || node.shortcode)
                        ? `https://www.instagram.com/p/${node.code || node.shortcode}/`
                        : (node.url || node.link || ''),
                    author_name: node.user?.username || handle,
                    author_url: `https://www.instagram.com/${node.user?.username || handle}/`,
                    content: String(content),
                    post_created_at: (node.taken_at || node.taken_at_timestamp)
                        ? new Date((node.taken_at || node.taken_at_timestamp) * 1000).toISOString()
                        : (node.date || node.timestamp || new Date().toISOString()),
                    scraped_at: new Date().toISOString(),
                    source: `sv:ig:@${handle}`,
                    likes: node.like_count || node.edge_liked_by?.count || node.likes || 0,
                    comments: node.comment_count || node.edge_media_to_comment?.count || node.comments || 0,
                };
            }).filter(p => p.content && p.content.length > 10 && !p.content.includes('[object'));

            allPosts.push(...posts);
            console.log(`[SV:IG] ✅ ${posts.length} posts from @${handle}`);
            track404(handle, false);
            await delay(2000);
        } catch (err) {
            console.warn(`[SV:IG] ⚠️ @${handle}: ${err.message}`);
            if (err.message?.includes('404')) track404(handle, true);
        }
    }

    const result = allPosts.slice(0, maxPosts);
    console.log(`[SV:IG] 📊 Total: ${result.length} posts`);
    return result;
}

// ═══════════════════════════════════════════════════════
// TIKTOK — Videos by Account
// Endpoint: tiktok/videos?handle=<username>
// Scrapes videos from target seller/competitor accounts
// ═══════════════════════════════════════════════════════

async function scrapeTikTok(maxPosts = 20) {
    const accounts = config.TT_TARGET_ACCOUNTS || [];
    if (accounts.length === 0) { console.log('[SV:TT] ⚠️ No TT accounts configured'); return []; }
    if (!SV_KEY) { console.warn('[SV:TT] ⚠️ No API key'); return []; }

    console.log(`[SV:TT] 🎵 Scraping ${accounts.length} TikTok accounts...`);
    const allPosts = [];

    for (const handle of accounts.slice(0, 4)) {
        try {
            console.log(`[SV:TT] @${handle}...`);
            const data = await svRequest('tiktok/videos', { handle });

            // SociaVault TikTok returns data in aweme_list (object indexed)
            const videosRaw = data.aweme_list || data.videos || data.items || data.itemList || [];
            const videosArr = Array.isArray(videosRaw) ? videosRaw : Object.values(videosRaw);

            const videos = videosArr.map(item => ({
                platform: 'tiktok',
                post_url: item.share_url || item.video_url || item.url ||
                    (item.aweme_id ? `https://www.tiktok.com/@${handle}/video/${item.aweme_id}` : ''),
                author_name: item.author?.nickname || item.author?.unique_id || handle,
                author_url: `https://www.tiktok.com/@${item.author?.unique_id || handle}`,
                author_avatar: item.author?.avatar_thumb?.url_list?.[0] || '',
                content: item.desc || item.description || item.text || item.caption || '',
                post_created_at: item.create_time
                    ? new Date(item.create_time * 1000).toISOString()
                    : (item.date || new Date().toISOString()),
                scraped_at: new Date().toISOString(),
                source: `sv:tt:@${handle}`,
                likes: item.statistics?.digg_count || item.stats?.diggCount || 0,
                comments: item.statistics?.comment_count || item.stats?.commentCount || 0,
                views: item.statistics?.play_count || item.stats?.playCount || 0,
            })).filter(p => p.content && p.content.length > 5);

            allPosts.push(...videos);
            console.log(`[SV:TT] ✅ ${videos.length} videos from @${handle}`);
            track404(handle, false);
            await delay(2000);
        } catch (err) {
            console.warn(`[SV:TT] ⚠️ @${handle}: ${err.message}`);
            if (err.message?.includes('404')) track404(handle, true);
        }
    }

    const result = allPosts.slice(0, maxPosts);
    console.log(`[SV:TT] 📊 Total: ${result.length} videos`);
    return result;
}

/**
 * Test API connection
 */
async function testConnection() {
    if (!SV_KEY) return { ok: false, error: 'No SOCIAVAULT_API_KEY' };
    try {
        const resp = await axios.get(`${SV_API}/tiktok/profile`, {
            headers: headers(),
            params: { handle: 'tiktok' },
            timeout: 15000,
        });
        return { ok: resp.data?.success === true, credits_used: resp.data?.credits_used };
    } catch (err) {
        return { ok: false, error: err.response?.data?.error || err.message };
    }
}

module.exports = {
    scrapeFacebookGroups,
    scrapeInstagram,
    scrapeTikTok,
    testConnection,
    svRequest,
};
