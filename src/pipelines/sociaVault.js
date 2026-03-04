/**
 * THG Lead Gen — SociaVault API v3 (field mapping verified từ real responses)
 * 
 * ENDPOINT PATHS ĐÃ XÁC NHẬN:
 *   Facebook:  facebook/post/comments  → data.comments = {"0":{text, author:{name}}, "1":...}
 *   Instagram: instagram/comments      → data.comments = {"0":{text, user:{username}}, ...}
 *   TikTok:    tiktok/comments         → data.comments = null (nhiều video không có comment)
 *   TikTok:    tiktok/search/hashtag   → cần test thêm
 */

const axios = require('axios');
const config = require('../config');

const SV_API = 'https://api.sociavault.com/v1/scrape';
const SV_KEY = process.env.SOCIAVAULT_API_KEY || config.SOCIAVAULT_API_KEY || '';

const headers = () => ({ 'X-API-Key': SV_KEY });
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Credit tracking
let creditsUsedToday = 0;
const DAILY_CREDIT_LIMIT = parseInt(process.env.SV_DAILY_LIMIT || '60');
function canSpend() {
    if (creditsUsedToday >= DAILY_CREDIT_LIMIT) {
        console.warn(`[SV] 🚫 Daily limit ${DAILY_CREDIT_LIMIT} reached`);
        return false;
    }
    return true;
}
function spend() {
    creditsUsedToday++;
    console.log(`[SV] 💳 Credits: ${creditsUsedToday}/${DAILY_CREDIT_LIMIT}`);
}
setInterval(() => { creditsUsedToday = 0; }, 24 * 60 * 60 * 1000);

async function svGet(endpoint, params = {}) {
    if (!SV_KEY) throw new Error('SOCIAVAULT_API_KEY not set');
    const resp = await axios.get(`${SV_API}/${endpoint}`, {
        headers: headers(), params, timeout: 60000,
    });
    if (!resp.data?.success) throw new Error(resp.data?.error || `SV ${endpoint} failed`);
    return resp.data?.data || resp.data;
}

// Convert object {"0":{...}, "1":{...}} hoặc array thành array
function toArr(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return Object.values(raw);
    return [];
}

// ════════════════════════════════════════════════════════
// FACEBOOK
// ════════════════════════════════════════════════════════

// Response verified: data.comments.{0..n}.{text, created_at, author:{name, id}}
async function fbGetPostComments(postUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('facebook/post/comments', { url: postUrl });
    spend();

    return toArr(data.comments).map(item => ({
        platform: 'facebook',
        post_url: postUrl,
        author_name: item.author?.name || 'Unknown',
        author_url: item.author?.id ? `https://www.facebook.com/${item.author.id}` : '',
        content: (item.text || '').trim(),
        post_created_at: item.created_at || new Date().toISOString(),
        scraped_at: new Date().toISOString(),
        source,
        likes: item.reaction_count || 0,
        comments: item.reply_count || 0,
    })).filter(p => p.content.length > 5);
}

async function fbGetGroupPosts(groupUrl, groupName) {
    if (!canSpend()) return [];
    const data = await svGet('facebook/group/posts', { url: groupUrl });
    spend();

    return toArr(data.posts || data).map(item => ({
        url: item.url || item.post_url || '',
        content: (item.text || item.message || '').trim(),
        author_name: item.author?.name || item.author?.short_name || 'Unknown',
        created_at: item.publishTime ? new Date(item.publishTime * 1000).toISOString() : null,
    })).filter(p => p.content.length > 15);
}

async function scrapeFacebookGroups(maxPosts = 60) {
    const groups = config.FB_TARGET_GROUPS || [];
    if (!groups.length) return [];
    console.log(`[SV:FB] 📘 ${groups.length} groups...`);

    const all = [];

    for (const group of groups) {
        try {
            console.log(`[SV:FB] 📌 ${group.name}`);
            const posts = await fbGetGroupPosts(group.url, group.name);
            console.log(`[SV:FB]   ${posts.length} posts`);
            await delay(1500);

            for (const post of posts.slice(0, 3)) {
                // Add post itself
                if (post.content) {
                    all.push({
                        platform: 'facebook',
                        post_url: post.url,
                        author_name: post.author_name,
                        author_url: '',
                        content: post.content,
                        post_created_at: post.created_at || new Date().toISOString(),
                        scraped_at: new Date().toISOString(),
                        source: `sv:fb:group:${group.name}`,
                    });
                }

                // Get comments on this post
                if (post.url) {
                    try {
                        await delay(1500);
                        const comments = await fbGetPostComments(post.url, `sv:fb:comments:${group.name}`);
                        all.push(...comments.slice(0, 5));
                        console.log(`[SV:FB]   ↳ ${comments.length} comments`);
                    } catch (e) {
                        console.warn(`[SV:FB]   ↳ comments err: ${e.message}`);
                    }
                }
            }
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ ${group.name}: ${err.message}`);
        }
        await delay(2000);
    }

    // Competitor page comments
    const compComments = await scrapeFBCompetitorComments();
    all.push(...compComments);

    const result = all.filter(p => p.content?.length > 5).slice(0, maxPosts);
    console.log(`[SV:FB] 📊 Total: ${result.length}`);
    return result;
}

async function scrapeFBCompetitorComments() {
    const pages = config.FB_COMPETITOR_PAGES || [];
    if (!pages.length) return [];
    console.log(`[SV:FB] 🏢 ${pages.length} competitor pages...`);

    const all = [];
    for (const page of pages) {
        try {
            if (!canSpend()) break;
            const data = await svGet('facebook/profile/posts', { url: page.url });
            spend();
            await delay(1500);

            const posts = toArr(data.posts || data).slice(0, 2);
            for (const post of posts) {
                const postUrl = post.url || post.post_url;
                if (!postUrl) continue;
                try {
                    await delay(1500);
                    const comments = await fbGetPostComments(postUrl, `sv:fb:competitor:${page.name}`);
                    all.push(...comments.slice(0, 8));
                    console.log(`[SV:FB]   🏢 ${page.name}: ${comments.length} comments`);
                } catch (e) {
                    console.warn(`[SV:FB]   🏢 ${page.name} err: ${e.message}`);
                }
            }
        } catch (err) {
            console.warn(`[SV:FB] ⚠️ ${page.name}: ${err.message}`);
        }
        await delay(2000);
    }
    return all;
}

// ════════════════════════════════════════════════════════
// TIKTOK
// ════════════════════════════════════════════════════════

// ⚠️ VERIFIED: endpoint là 'tiktok/comments' (không phải tiktok/video/comments)
// ⚠️ VERIFIED: nhiều video trả về data.comments = null → cần handle
async function ttGetVideoComments(videoUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('tiktok/comments', { url: videoUrl });
    spend();

    // VERIFIED: TikTok hay trả comments = null, không phải lỗi
    const comments = toArr(data.comments);
    if (comments.length === 0) return [];

    return comments.map(item => ({
        platform: 'tiktok',
        post_url: videoUrl,
        author_name: item.user?.unique_id || item.user?.nickname || item.author || 'Unknown',
        author_url: item.user?.unique_id ? `https://www.tiktok.com/@${item.user.unique_id}` : '',
        content: (item.text || item.comment || '').trim(),
        post_created_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : new Date().toISOString(),
        scraped_at: new Date().toISOString(),
        source,
    })).filter(p => p.content.length > 3);
}

async function ttSearchHashtag(hashtag) {
    if (!canSpend()) return [];
    const data = await svGet('tiktok/search/hashtag', { hashtag });
    spend();

    const videos = toArr(data.videos || data.items || data.aweme_list || data);
    return videos.map(item => ({
        url: item.share_url || item.url ||
            (item.aweme_id ? `https://www.tiktok.com/@${item.author?.unique_id || 'user'}/video/${item.aweme_id}` : ''),
        content: (item.desc || item.description || item.caption || '').trim(),
        author_name: item.author?.nickname || item.author?.unique_id || 'Unknown',
        author_url: item.author?.unique_id ? `https://www.tiktok.com/@${item.author.unique_id}` : '',
        created_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : null,
    })).filter(p => p.url);
}

async function scrapeTikTok(maxPosts = 30) {
    const hashtags = config.TT_SEARCH_HASHTAGS || [];
    if (!hashtags.length) {
        console.log('[SV:TT] ⚠️ No TT_SEARCH_HASHTAGS configured');
        return [];
    }
    console.log(`[SV:TT] 🎵 ${hashtags.length} hashtags...`);

    const all = [];

    for (const hashtag of hashtags.slice(0, 4)) {
        try {
            console.log(`[SV:TT] #${hashtag}`);
            const videos = await ttSearchHashtag(hashtag);
            console.log(`[SV:TT]   ${videos.length} videos`);
            await delay(1500);

            for (const video of videos.slice(0, 3)) {
                // Add video caption
                if (video.content) {
                    all.push({
                        platform: 'tiktok',
                        post_url: video.url,
                        author_name: video.author_name,
                        author_url: video.author_url,
                        content: video.content,
                        post_created_at: video.created_at || new Date().toISOString(),
                        scraped_at: new Date().toISOString(),
                        source: `sv:tt:hashtag:${hashtag}`,
                    });
                }

                // Get comments — nhiều video sẽ trả null, đó là bình thường
                if (video.url) {
                    try {
                        await delay(1500);
                        const comments = await ttGetVideoComments(video.url, `sv:tt:comments:${hashtag}`);
                        if (comments.length > 0) {
                            all.push(...comments.slice(0, 8));
                            console.log(`[SV:TT]   ↳ ${comments.length} comments`);
                        }
                    } catch (e) {
                        console.warn(`[SV:TT]   ↳ comments err: ${e.message}`);
                    }
                }
                await delay(1000);
            }
        } catch (err) {
            console.warn(`[SV:TT] ⚠️ #${hashtag}: ${err.message}`);
        }
        await delay(2000);
    }

    const result = all.filter(p => p.content?.length > 3).slice(0, maxPosts);
    console.log(`[SV:TT] 📊 Total: ${result.length}`);
    return result;
}

// ════════════════════════════════════════════════════════
// INSTAGRAM
// ════════════════════════════════════════════════════════

// Response verified: data.comments.{0..n}.{text, created_at, user:{username, id}}
async function igGetPostComments(postUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('instagram/comments', { url: postUrl });
    spend();

    return toArr(data.comments).map(item => ({
        platform: 'instagram',
        post_url: postUrl,
        author_name: item.user?.username || 'Unknown',
        author_url: item.user?.username ? `https://www.instagram.com/${item.user.username}/` : '',
        content: (item.text || '').trim(),
        post_created_at: item.created_at || new Date().toISOString(),
        scraped_at: new Date().toISOString(),
        source,
    })).filter(p => p.content.length > 5);
}

async function igGetAccountPosts(handle) {
    if (!canSpend()) return [];
    const data = await svGet('instagram/posts', { handle });
    spend();

    const postsRaw = toArr(data.posts || data.items || data.edges || data);
    return postsRaw.map(item => {
        const node = item.node || item;
        const rawCap = node.caption;
        const content = (typeof rawCap === 'string' ? rawCap : rawCap?.text)
            || node.text || node.description || '';
        return {
            url: (node.code || node.shortcode)
                ? `https://www.instagram.com/p/${node.code || node.shortcode}/`
                : (node.url || ''),
            content: String(content).trim(),
        };
    }).filter(p => p.url);
}

async function scrapeInstagram(maxPosts = 30) {
    const accounts = config.IG_TARGET_ACCOUNTS || [];
    if (!accounts.length) {
        console.log('[SV:IG] ⚠️ No IG_TARGET_ACCOUNTS configured');
        return [];
    }
    console.log(`[SV:IG] 📷 ${accounts.length} accounts...`);

    const all = [];

    for (const handle of accounts.slice(0, 4)) {
        try {
            console.log(`[SV:IG] @${handle}`);
            const posts = await igGetAccountPosts(handle);
            console.log(`[SV:IG]   ${posts.length} posts`);
            await delay(1500);

            for (const post of posts.slice(0, 3)) {
                if (!post.url) continue;
                try {
                    await delay(1500);
                    const comments = await igGetPostComments(post.url, `sv:ig:comments:@${handle}`);
                    all.push(...comments.slice(0, 8));
                    console.log(`[SV:IG]   ↳ @${handle}: ${comments.length} comments`);
                } catch (e) {
                    console.warn(`[SV:IG]   ↳ @${handle} err: ${e.message}`);
                }
            }
        } catch (err) {
            console.warn(`[SV:IG] ⚠️ @${handle}: ${err.message}`);
        }
        await delay(2000);
    }

    const result = all.filter(p => p.content?.length > 5).slice(0, maxPosts);
    console.log(`[SV:IG] 📊 Total: ${result.length}`);
    return result;
}

async function testConnection() {
    if (!SV_KEY) return { ok: false, error: 'No SOCIAVAULT_API_KEY' };
    try {
        const resp = await axios.get(`${SV_API}/tiktok/profile`, {
            headers: headers(), params: { handle: 'tiktok' }, timeout: 15000,
        });
        return { ok: resp.data?.success === true };
    } catch (err) {
        return { ok: false, error: err.response?.data?.error || err.message };
    }
}

module.exports = {
    scrapeFacebookGroups,
    scrapeInstagram,
    scrapeTikTok,
    testConnection,
    svGet,
    getCreditsUsed: () => creditsUsedToday,
};
