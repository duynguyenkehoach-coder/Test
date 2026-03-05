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
const rotation = require('./rotation');

const SV_API = 'https://api.sociavault.com/v1/scrape';
const SV_KEY = process.env.SOCIAVAULT_API_KEY || config.SOCIAVAULT_API_KEY || '';

const headers = () => ({ 'X-API-Key': SV_KEY });
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Credit tracking (monitoring + logging for dashboard)
let creditsUsedToday = 0;
const creditLog = [];  // {timestamp, endpoint, platform, source}
const MAX_LOG_SIZE = 500;
const DAILY_LIMIT = config.SV_DAILY_LIMIT || 370;

function canSpend() {
    if (creditsUsedToday >= DAILY_LIMIT) {
        console.warn(`[SV] 🛑 BUDGET EXHAUSTED: ${creditsUsedToday}/${DAILY_LIMIT} credits. Stopping until midnight.`);
        return false;
    }
    return true;
}
function getBudgetInfo() {
    return {
        used: creditsUsedToday,
        limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - creditsUsedToday),
        pct: Math.round((creditsUsedToday / DAILY_LIMIT) * 100),
    };
}
function logCredit(endpoint, platform, source) {
    creditsUsedToday++;
    creditLog.push({
        id: creditsUsedToday,
        timestamp: new Date().toISOString(),
        endpoint,
        platform: platform || 'unknown',
        source: source || '',
    });
    if (creditLog.length > MAX_LOG_SIZE) creditLog.shift();
    const budget = getBudgetInfo();
    console.log(`[SV] 💳 Credits: ${budget.used}/${budget.limit} (${budget.pct}%) — ${endpoint}`);
}
function spend() { logCredit('unknown', 'unknown', ''); }
setInterval(() => {
    if (creditsUsedToday > 0) {
        console.log(`[SV] 🔄 Daily reset — used ${creditsUsedToday}/${DAILY_LIMIT} credits today`);
    }
    creditsUsedToday = 0;
}, 24 * 60 * 60 * 1000);

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
// ROTATION BATCH SIZES
// ════════════════════════════════════════════════════════
const FB_GROUPS_PER_SCAN = 4;
const FB_COMPETITORS_PER_SCAN = 1;  // reduced: competitor pages mostly provider content
const TT_HASHTAGS_PER_SCAN = 4;
const IG_ACCOUNTS_PER_SCAN = 3;

// ════════════════════════════════════════════════════════
// SIGNAL GATING — buyer vs provider detection
// ════════════════════════════════════════════════════════

function isProviderText(s) {
    const providerHints = [
        'bên em', 'bên mình', 'chúng tôi', 'nhận vận chuyển', 'nhận ship', 'nhận gửi',
        'dịch vụ', 'cam kết', 'giá rẻ', 'hotline', 'liên hệ', 'lh', 'zalo', 'call', 'inbox em',
        'nhận sll', 'bao thuế', 'tuyến bay riêng'
    ];
    if (providerHints.some(x => s.includes(x))) return true;
    if (/\b(0\d{8,10})\b/.test(s)) return true;         // phone VN
    if (/(https?:\/\/|\.com|\.vn|wa\.me)/.test(s)) return true;
    return false;
}

function isBuyerText(s) {
    const buyerHints = [
        'cần', 'tìm', 'xin', 'nhờ', 'hỏi', 'ai biết', 'recommend', 'review',
        'báo giá', 'rate', 'quote', 'giá bao nhiêu', 'bao lâu', 'ship mấy ngày',
        'ddp', 'door to door', 'line us', 'ship to us', 'ship mỹ', 'kho', '3pl', 'fulfillment',
        'fba', 'ship to amazon', 'prep'
    ];
    if (buyerHints.some(x => s.includes(x))) return true;
    if (/\?\s*$/.test(s)) return true; // ends with question mark
    return false;
}

function signalScores(text = '') {
    const s = text.toLowerCase();

    // Hard negatives
    const neg = [
        'tuyển dụng', 'job', 'giveaway', 'minigame', 'order walmart', 'jammed kitchen',
        'hiring', 'intern', 'printer', 'labels', 'canvas', 'thêu', 'embroidery',
        'coaching', 'coach', 'site down', 'support no response'
    ];
    if (neg.some(x => s.includes(x))) return { express: 0, wh: 0, any: 0, buyer: 0, provider: 0 };

    const provider = isProviderText(s) ? 1 : 0;
    const buyer = isBuyerText(s) ? 1 : 0;

    // Provider post about logistics → STILL hydrate comments (buyers reply to these!)
    const logisticsTerms = ['ship', 'vận chuyển', 'ddp', 'fba', 'fulfillment', 'kho', 'warehouse',
        '3pl', 'line us', 'gửi hàng', 'freight', 'lcl', 'fcl', 'thông quan', 'prep'];
    const isLogisticsPost = logisticsTerms.some(t => s.includes(t));

    // Provider without buyer intent AND not about logistics → noise, skip
    if (provider && !buyer && !isLogisticsPost) return { express: 0, wh: 0, any: 0, buyer: 0, provider: 1, providerLogistics: false };

    // Provider post about logistics: we want comments but lower priority
    const providerLogistics = (provider && !buyer && isLogisticsPost) ? 1 : 0;

    // Express triggers
    const expressTerms = [
        'ddp', 'line us', 'ship mỹ', 'ship to us', 'đi mỹ', 'báo giá', 'rate', 'quote',
        'air', 'sea', 'lcl', 'fcl', 'thông quan', 'custom', 'isf', 'hs code',
        'gửi hàng', 'xuất hàng', 'battery', 'liquid', 'magnet', 'epacket',
        'ship quốc tế', 'vận chuyển', 'door to door', 'forwarder'
    ];

    // Warehouse triggers (POD/dropship removed — too noisy)
    const whTerms = [
        '3pl', 'warehouse', 'kho pa', 'kho tx', 'pick pack', 'prep', 'fba prep', 'fba',
        'ship to amazon', 'returns', 'cross-dock', 'tiktok shop us', 'shopify', 'wms', 'oms',
        'kho mỹ', 'kho us', 'lưu kho', 'fulfill', 'fulfillment'
    ];

    let express = expressTerms.filter(t => s.includes(t)).length * 12;
    let wh = whTerms.filter(t => s.includes(t)).length * 12;

    // Volume boost (meaningful for express)
    if (/\b(\d+(\.\d+)?)\s?(kg|cbm|m3|pallet|carton|container)\b/.test(s)) express += 20;

    // Short buyer signals — only if NOT provider
    const shortBuyer = ['xin giá', 'báo giá', 'rate', 'quote', 'giá bao nhiêu', 'bao lâu',
        'ship mấy ngày', 'có kho', 'có line'];
    if (!provider && shortBuyer.some(x => s.includes(x))) {
        express = Math.max(express, 25);
        wh = Math.max(wh, 25);
    }

    const any = Math.max(express, wh);
    // If no buyer signal, reduce — but provider logistics posts get minimum score for comment hydration
    let anyFinal;
    if (providerLogistics) {
        anyFinal = Math.max(any, 20); // provider logistics = buyers in comments!
    } else if (buyer) {
        anyFinal = any;
    } else {
        anyFinal = Math.max(0, any - 15);
    }

    return { express, wh, any: anyFinal, buyer, provider, providerLogistics };
}

// ════════════════════════════════════════════════════════
// FRESHNESS CHECK — filter BEFORE hydrating comments
// ════════════════════════════════════════════════════════
function isFresh(isoOrNull, maxDays = 10) {
    if (!isoOrNull) return false;
    const t = new Date(isoOrNull).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) <= maxDays * 24 * 60 * 60 * 1000;
}

// ════════════════════════════════════════════════════════
// FACEBOOK
// ════════════════════════════════════════════════════════

// Response verified: data.comments.{0..n}.{text, created_at, author:{name, id}}
async function fbGetPostComments(postUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('facebook/post/comments', { url: postUrl });
    logCredit('facebook/post/comments', 'facebook', source);

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
    const data = await svGet('facebook/group/posts', { url: groupUrl, sort_by: 'CHRONOLOGICAL' });
    logCredit('facebook/group/posts', 'facebook', groupName);

    const postsArr = toArr(data.posts || data);
    return postsArr.map(item => ({
        url: item.url || item.post_url || '',
        content: (item.text || item.message || '').trim(),
        author_name: item.author?.name || item.author?.short_name || 'Unknown',
        created_at: item.publishTime ? new Date(item.publishTime * 1000).toISOString() : null,
        commentCount: item.commentCount || 0,
        topComments: toArr(item.topComments).map(c => ({
            text: (c.text || '').trim(),
            publishTime: c.publishTime ? new Date(c.publishTime * 1000).toISOString() : null,
            author_name: c.author?.name || 'Unknown',
            author_url: c.author?.url || '',
        })),
    })).filter(p => p.content.length > 15);
}

async function scrapeFacebookGroups(maxPosts = 60) {
    const allGroups = config.FB_TARGET_GROUPS || [];
    if (!allGroups.length) return [];

    // Rotation: lấy batch tiếp theo, không lặp lại
    const groups = rotation.getNextBatch('fb_groups', allGroups, FB_GROUPS_PER_SCAN);
    console.log(`[SV:FB] 📘 ${groups.length}/${allGroups.length} groups this scan (rotation)...`);

    const all = [];

    for (const group of groups) {
        try {
            console.log(`[SV:FB] 📌 ${group.name}`);
            const posts = await fbGetGroupPosts(group.url, group.name);
            console.log(`[SV:FB]   ${posts.length} posts (CHRONOLOGICAL)`);
            await delay(1500);

            for (const post of posts.slice(0, 3)) {
                // Add post itself
                if (post.content) {
                    all.push({
                        platform: 'facebook',
                        item_type: 'post',
                        post_url: post.url,
                        author_name: post.author_name,
                        author_url: '',
                        content: post.content,
                        post_created_at: post.created_at || new Date().toISOString(),
                        scraped_at: new Date().toISOString(),
                        source: `sv:fb:group:${group.name}`,
                    });
                }

                // Use FREE topComments (no extra credit cost)
                for (const tc of (post.topComments || []).slice(0, 3)) {
                    if (tc.text && tc.text.length > 3) {
                        all.push({
                            platform: 'facebook',
                            item_type: 'comment',
                            post_url: post.url,
                            author_name: tc.author_name,
                            author_url: tc.author_url,
                            content: tc.text,
                            post_created_at: tc.publishTime || new Date().toISOString(),
                            parent_created_at: post.created_at,
                            parent_excerpt: (post.content || '').slice(0, 300),
                            scraped_at: new Date().toISOString(),
                            source: `sv:fb:topComments:${group.name}`,
                        });
                    }
                }

                // PAID comments — different rules for buyer vs provider posts
                const sig = signalScores(post.content || '');
                const shouldHydrate = sig.providerLogistics
                    // Provider logistics: only if very fresh (≤7d) + high engagement (≥5 comments)
                    ? (post.url && post.commentCount >= 5 && isFresh(post.created_at, 7))
                    // Buyer posts: normal threshold
                    : (post.url && post.commentCount > 0 && sig.any >= 25 && isFresh(post.created_at, 14));

                if (shouldHydrate) {
                    try {
                        await delay(1500);
                        const comments = await fbGetPostComments(post.url, `sv:fb:comments:${group.name}`);
                        all.push(...comments.slice(0, 5).map(c => ({
                            ...c,
                            item_type: 'comment',
                            parent_excerpt: (post.content || '').slice(0, 300),
                            parent_created_at: post.created_at || null,
                        })));
                        const type = sig.providerLogistics ? 'provider-logistics' : 'buyer';
                        console.log(`[SV:FB]   ↳ ${comments.length} paid comments (${type}, commentCount=${post.commentCount}, signal=${sig.any})`);
                    } catch (e) {
                        console.warn(`[SV:FB]   ↳ comments err: ${e.message}`);
                    }
                } else if (post.url) {
                    const reasons = [];
                    if (post.commentCount === 0) reasons.push('0 comments');
                    if (!sig.providerLogistics && sig.any < 25) reasons.push('weak signal');
                    if (sig.providerLogistics && post.commentCount < 5) reasons.push(`low engagement(${post.commentCount})`);
                    if (!isFresh(post.created_at, sig.providerLogistics ? 7 : 14)) reasons.push('old');
                    console.log(`[SV:FB]   ↳ skip paid comments (${reasons.join(', ')})`);
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
    const allPages = config.FB_COMPETITOR_PAGES || [];
    if (!allPages.length) return [];

    // Rotation: 3 pages/scan thay vì tất cả
    const pages = rotation.getNextBatch('fb_competitors', allPages, FB_COMPETITORS_PER_SCAN);
    console.log(`[SV:FB] 🏢 ${pages.length}/${allPages.length} competitor pages this scan (rotation)...`);

    const all = [];
    for (const page of pages) {
        try {
            if (!canSpend()) break;
            const data = await svGet('facebook/profile/posts', { url: page.url });
            logCredit('facebook/profile/posts', 'facebook', page.name);
            await delay(1500);

            const posts = toArr(data.posts || data).slice(0, 2);
            for (const post of posts) {
                const postUrl = post.url || post.post_url;
                if (!postUrl) continue;
                try {
                    await delay(1500);
                    const postContent = post.text || post.message || '';
                    const comments = await fbGetPostComments(postUrl, `sv:fb:competitor:${page.name}`);
                    // Only keep comments that match trigger signals
                    const filtered = comments.filter(c => signalScores(c.content).any >= 10);
                    all.push(...filtered.slice(0, 8).map(c => ({
                        ...c,
                        item_type: 'comment',
                        parent_excerpt: postContent.slice(0, 300) || `[${page.name} post]`,
                    })));
                    console.log(`[SV:FB]   🏢 ${page.name}: ${comments.length} comments, ${filtered.length} w/ signal`);
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

async function ttGetVideoComments(videoUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('tiktok/comments', { url: videoUrl });
    logCredit('tiktok/comments', 'tiktok', source);

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

// Helper: safe nested property access
function pick(obj, paths) {
    for (const p of paths) {
        const v = p.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
        if (v !== undefined && v !== null) return v;
    }
    return null;
}

function buildTiktokWebUrl(uniqueId, awemeId) {
    if (!uniqueId || !awemeId) return '';
    return `https://www.tiktok.com/@${uniqueId}/video/${awemeId}`;
}

async function ttSearchKeyword(query) {
    if (!canSpend()) return [];
    const data = await svGet('tiktok/search/keyword', {
        query,
        date_posted: 'this-week',
        sort_by: 'date-posted',
        trim: true,
    });
    logCredit('tiktok/search/keyword', 'tiktok', query);

    // SociaVault keyword search uses search_item_list[].aweme_info
    const rawList =
        data?.search_item_list ||
        data?.data?.search_item_list ||
        data?.videos || data?.items || data?.aweme_list ||
        null;

    const items = toArr(rawList).filter(Boolean);

    const videos = [];
    for (const it of items) {
        // search_item_list wraps in aweme_info; direct items don't
        const aweme = it?.aweme_info || it?.awemeInfo || it;

        const awemeId = pick(aweme, ['aweme_id', 'awemeId', 'id']);
        const desc = pick(aweme, ['desc', 'description', 'caption']) || '';
        const createTime = pick(aweme, ['create_time', 'createTime']);
        const authorUnique = pick(aweme, ['author.unique_id', 'author.uniqueId', 'author.username']);
        const authorNick = pick(aweme, ['author.nickname', 'author.nickName']) || authorUnique || 'Unknown';

        // Build URL: prefer share_url, fallback to constructed URL
        const url = pick(aweme, ['share_url', 'url']) || buildTiktokWebUrl(authorUnique, awemeId);
        if (!url) continue;

        videos.push({
            url,
            content: String(desc).trim(),
            author_name: authorNick,
            author_url: authorUnique ? `https://www.tiktok.com/@${authorUnique}` : '',
            created_at: createTime ? new Date(createTime * 1000).toISOString() : null,
        });
    }

    console.log(`[SV:TT]   parsed ${videos.length}/${items.length} videos from response`);
    return videos;
}

async function scrapeTikTok(maxPosts = 30) {
    const allQueries = config.TT_SEARCH_QUERIES || [];
    if (!allQueries.length) {
        console.log('[SV:TT] ⚠️ No TT_SEARCH_QUERIES configured');
        return [];
    }

    // Rotation: 4 queries/scan
    const queries = rotation.getNextBatch('tt_queries', allQueries, TT_HASHTAGS_PER_SCAN);
    console.log(`[SV:TT] 🔎 ${queries.length}/${allQueries.length} queries this scan (rotation)...`);

    const all = [];

    for (const q of queries) {
        try {
            console.log(`[SV:TT] q="${q}"`);
            const videos = await ttSearchKeyword(q);
            console.log(`[SV:TT]   ${videos.length} videos`);
            await delay(1500);

            // Filter: skip noise AND provider ads (Chinese forwarder ads dominate TikTok)
            const relevant = videos.filter(v => {
                if (!v.content || v.content.length < 20) return false; // too short / emoji
                const s = (v.content || '').toLowerCase();
                // Skip provider/forwarder ads (they have noise comments)
                if (isProviderText(s)) return false;
                // Skip obvious Chinese forwarder ads in English
                if (/shipping agent|freight forwarder|we ship|we offer|contact us|whatsapp/i.test(v.content)) return false;
                const sig = signalScores(v.content);
                return sig.any > 0 || sig.buyer;
            });
            console.log(`[SV:TT]   ${relevant.length}/${videos.length} relevant (non-provider) after filter`);

            for (const video of relevant.slice(0, 5)) {
                all.push({
                    platform: 'tiktok',
                    item_type: 'post',
                    post_url: video.url,
                    author_name: video.author_name,
                    author_url: video.author_url,
                    content: video.content,
                    post_created_at: video.created_at || new Date().toISOString(),
                    scraped_at: new Date().toISOString(),
                    source: `sv:tt:kw:${q}`,
                });

                // Hydrate comments — only for buyer-signal videos (provider video comments = noise)
                const sig = signalScores(video.content || '');
                if (video.url && sig.buyer && sig.any >= 20 && isFresh(video.created_at, 10)) {
                    try {
                        await delay(1500);
                        const comments = await ttGetVideoComments(video.url, `sv:tt:comments:${q}`);
                        if (comments.length > 0) {
                            all.push(...comments.slice(0, 8).map(c => ({
                                ...c,
                                item_type: 'comment',
                                parent_excerpt: (video.content || '').slice(0, 300),
                                parent_created_at: video.created_at || null,
                            })));
                            console.log(`[SV:TT]   ↳ ${comments.length} comments (signal=${sig.any}, buyer=${sig.buyer})`);
                        }
                    } catch (e) {
                        console.warn(`[SV:TT]   ↳ comments err: ${e.message}`);
                    }
                } else if (video.url) {
                    console.log(`[SV:TT]   ↳ skip comments (${!sig.buyer ? 'not buyer' : sig.any < 20 ? 'weak signal' : 'old video'})`);
                }
                await delay(1000);
            }
        } catch (err) {
            console.warn(`[SV:TT] ⚠️ q="${q}": ${err.message}`);
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

async function igGetPostComments(postUrl, source) {
    if (!canSpend()) return [];
    const data = await svGet('instagram/comments', { url: postUrl });
    logCredit('instagram/comments', 'instagram', source);

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
    logCredit('instagram/posts', 'instagram', handle);

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
    const allAccounts = config.IG_TARGET_ACCOUNTS || [];
    if (!allAccounts.length) {
        console.log('[SV:IG] ⚠️ No IG_TARGET_ACCOUNTS configured');
        return [];
    }

    // Rotation: 3 accounts/scan, xoay vòng
    const accounts = rotation.getNextBatch('ig_accounts', allAccounts, IG_ACCOUNTS_PER_SCAN);
    console.log(`[SV:IG] 📷 ${accounts.length}/${allAccounts.length} accounts this scan (rotation)...`);

    const all = [];

    for (const handle of accounts) {
        try {
            console.log(`[SV:IG] @${handle}`);
            const posts = await igGetAccountPosts(handle);
            console.log(`[SV:IG]   ${posts.length} posts`);
            await delay(1500);

            for (const post of posts.slice(0, 3)) {
                if (!post.url) continue;
                const sig = signalScores(post.content || '');
                if (sig.any < 20 || !isFresh(post.created_at, 10)) {
                    console.log(`[SV:IG]   ↳ skip comments (${sig.any < 20 ? 'weak signal' : 'old post'})`);
                    continue;
                }
                try {
                    await delay(1500);
                    const comments = await igGetPostComments(post.url, `sv:ig:comments:@${handle}`);
                    all.push(...comments.slice(0, 8).map(c => ({
                        ...c,
                        item_type: 'comment',
                        parent_excerpt: post.content?.slice(0, 300) || '',
                        parent_created_at: post.created_at || null,
                    })));
                    console.log(`[SV:IG]   ↳ @${handle}: ${comments.length} comments (signal=${sig.any})`);
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
    getBudgetInfo,
    getCreditLog: () => [...creditLog],
    getCreditStats: () => {
        const byPlatform = {};
        const byEndpoint = {};
        for (const entry of creditLog) {
            byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + 1;
            byEndpoint[entry.endpoint] = (byEndpoint[entry.endpoint] || 0) + 1;
        }
        return {
            today: creditsUsedToday,
            total_logged: creditLog.length,
            by_platform: byPlatform,
            by_endpoint: byEndpoint,
            first_call: creditLog[0]?.timestamp || null,
            last_call: creditLog[creditLog.length - 1]?.timestamp || null,
        };
    },
};
