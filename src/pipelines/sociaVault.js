/**
 * THG Lead Gen — SociaVault API Integration
 * 
 * Replaces PhantomBuster for all platforms:
 * - Facebook: /v1/scrape/facebook/group-posts
 * - Instagram: /v1/scrape/instagram/hashtag
 * - TikTok: /v1/scrape/tiktok/search
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
// ═══════════════════════════════════════════════════════

/**
 * Scrape posts from a Facebook group
 * Endpoint: facebook/group-posts?url=<group_url>
 */
async function scrapeFBGroupPosts(groupUrl, groupName = 'group') {
    try {
        console.log(`[SV:FB] 📌 ${groupName}...`);
        const data = await svRequest('facebook/group-posts', { url: groupUrl });

        const posts = (data.posts || data.items || []).map(item => ({
            platform: 'facebook',
            post_url: item.url || item.postUrl || item.permalink || '',
            author_name: item.authorName || item.author?.name || item.userName || item.profileName || 'Unknown',
            author_url: item.authorUrl || item.author?.url || item.profileUrl || '',
            author_avatar: item.authorAvatar || item.author?.avatar || '',
            content: item.text || item.message || item.content || item.postText || '',
            post_created_at: item.date || item.timestamp || item.createdAt || new Date().toISOString(),
            scraped_at: new Date().toISOString(),
            source: `sv:fb:${groupName}`,
            likes: item.likes || item.likeCount || item.reactions || 0,
            comments: item.comments || item.commentCount || 0,
            shares: item.shares || item.shareCount || 0,
        })).filter(p => p.content && p.content.length > 15);

        console.log(`[SV:FB] ✅ ${posts.length} posts from ${groupName}`);
        return posts;
    } catch (err) {
        console.warn(`[SV:FB] ⚠️ ${groupName}: ${err.message}`);
        return [];
    }
}

/**
 * Scrape all configured Facebook groups
 */
async function scrapeFacebookGroups(maxPosts = 30) {
    const groups = config.FB_TARGET_GROUPS || [];
    if (groups.length === 0) { console.log('[SV:FB] ⚠️ No groups configured'); return []; }
    if (!SV_KEY) { console.warn('[SV:FB] ⚠️ No API key'); return []; }

    console.log(`[SV:FB] 📘 Scraping ${groups.length} Facebook groups...`);
    const allPosts = [];

    for (const group of groups) {
        const posts = await scrapeFBGroupPosts(group.url, group.name);
        allPosts.push(...posts);
        await delay(2000); // Be nice to API
    }

    const result = allPosts.slice(0, maxPosts);
    console.log(`[SV:FB] 📊 Total: ${result.length} posts from ${groups.length} groups`);
    return result;
}

// ═══════════════════════════════════════════════════════
// INSTAGRAM — Hashtag Search
// ═══════════════════════════════════════════════════════

/**
 * Scrape Instagram posts by hashtag
 * Endpoint: instagram/hashtag?name=<hashtag>
 */
async function scrapeInstagram(maxPosts = 30) {
    const hashtags = config.SEARCH_KEYWORDS?.instagram || [];
    if (hashtags.length === 0) { console.log('[SV:IG] ⚠️ No hashtags configured'); return []; }
    if (!SV_KEY) { console.warn('[SV:IG] ⚠️ No API key'); return []; }

    console.log(`[SV:IG] 📷 Scraping ${hashtags.length} Instagram hashtags...`);
    const allPosts = [];

    for (const hashtag of hashtags.slice(0, 5)) { // Limit to save credits
        try {
            console.log(`[SV:IG] #${hashtag}...`);
            const data = await svRequest('instagram/hashtag', { name: hashtag });

            const posts = (data.posts || data.items || data.edge_hashtag_to_media?.edges || []).map(item => {
                // Handle nested Instagram structure
                const node = item.node || item;
                return {
                    platform: 'instagram',
                    post_url: node.shortcode
                        ? `https://www.instagram.com/p/${node.shortcode}/`
                        : (node.url || node.postUrl || ''),
                    author_name: node.owner?.username || node.username || node.authorName || 'Unknown',
                    author_url: node.owner?.username
                        ? `https://www.instagram.com/${node.owner.username}/`
                        : (node.profileUrl || ''),
                    content: node.caption || node.text || node.description ||
                        node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                    post_created_at: node.taken_at_timestamp
                        ? new Date(node.taken_at_timestamp * 1000).toISOString()
                        : (node.date || node.timestamp || new Date().toISOString()),
                    scraped_at: new Date().toISOString(),
                    source: `sv:ig:#${hashtag}`,
                    likes: node.edge_liked_by?.count || node.likeCount || node.likes || 0,
                    comments: node.edge_media_to_comment?.count || node.commentCount || node.comments || 0,
                };
            }).filter(p => p.content && p.content.length > 10);

            allPosts.push(...posts);
            console.log(`[SV:IG] ✅ ${posts.length} posts from #${hashtag}`);
            await delay(2000);
        } catch (err) {
            console.warn(`[SV:IG] ⚠️ #${hashtag}: ${err.message}`);
        }
    }

    const result = allPosts.slice(0, maxPosts);
    console.log(`[SV:IG] 📊 Total: ${result.length} posts`);
    return result;
}

// ═══════════════════════════════════════════════════════
// TIKTOK — Keyword Search
// ═══════════════════════════════════════════════════════

/**
 * Scrape TikTok videos by keyword/hashtag search
 * Endpoint: tiktok/search?query=<keyword> or tiktok/hashtag?name=<hashtag>
 */
async function scrapeTikTok(maxPosts = 20) {
    const keywords = config.SEARCH_KEYWORDS?.tiktok || [];
    if (keywords.length === 0) { console.log('[SV:TT] ⚠️ No keywords configured'); return []; }
    if (!SV_KEY) { console.warn('[SV:TT] ⚠️ No API key'); return []; }

    console.log(`[SV:TT] 🎵 Scraping ${keywords.length} TikTok keywords...`);
    const allPosts = [];

    for (const keyword of keywords.slice(0, 4)) { // Limit to save credits
        try {
            console.log(`[SV:TT] 🔍 "${keyword}"...`);
            const data = await svRequest('tiktok/search', { query: keyword });

            const videos = (data.videos || data.items || data.data || []).map(item => ({
                platform: 'tiktok',
                post_url: item.video_url || item.url || item.webVideoUrl ||
                    (item.id ? `https://www.tiktok.com/@${item.author?.uniqueId || 'user'}/video/${item.id}` : ''),
                author_name: item.author?.nickname || item.author?.uniqueId || item.username || item.authorName || 'Unknown',
                author_url: item.author?.uniqueId
                    ? `https://www.tiktok.com/@${item.author.uniqueId}`
                    : (item.profileUrl || ''),
                author_avatar: item.author?.avatarThumb || '',
                content: item.desc || item.description || item.text || item.caption || '',
                post_created_at: item.createTime
                    ? new Date(item.createTime * 1000).toISOString()
                    : (item.date || item.timestamp || new Date().toISOString()),
                scraped_at: new Date().toISOString(),
                source: `sv:tt:${keyword}`,
                likes: item.stats?.diggCount || item.diggCount || item.likes || 0,
                comments: item.stats?.commentCount || item.commentCount || item.comments || 0,
                views: item.stats?.playCount || item.playCount || item.views || 0,
            })).filter(p => p.content && p.content.length > 10);

            allPosts.push(...videos);
            console.log(`[SV:TT] ✅ ${videos.length} videos for "${keyword}"`);
            await delay(2000);
        } catch (err) {
            console.warn(`[SV:TT] ⚠️ "${keyword}": ${err.message}`);
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
        // Simple test — scrape a known TikTok profile (1 credit)
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
