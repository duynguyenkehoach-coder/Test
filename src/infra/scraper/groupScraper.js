/**
 * Group Scraper — getGroupPosts + inner scraping logic
 * Uses standalone getAuthContext for individual group scraping.
 * 
 * @module scraper/groupScraper
 */
const { state, delay, FB_URL, fs, path, extractGroupId, closeBrowser } = require('./browserManager');
const { getAuthContext } = require('./authContext');
const accountManager = require('../../ai/agents/accountManager');

/**
 * Get posts from a Facebook group (with 2-minute timeout).
 * Uses AccountManager for multi-account rotation.
 */
async function getGroupPosts(groupUrl, groupName, options = {}) {
    const account = accountManager.getNextAccount(options);
    if (!account) {
        console.log(`[CrawBot] ❌ Không có tài khoản nào sẵn sàng — bỏ qua ${groupName}`);
        return [];
    }

    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('⏰ Group timeout (2min)')), 120000)
    );
    try {
        const posts = await Promise.race([timeout, _getGroupPostsInner(groupUrl, groupName, account)]);
        if (posts.length >= 0) accountManager.reportSuccess(account.id, posts.length);
        return posts;
    } catch (err) {
        console.warn(`[CrawBot] ⚠️ ${groupName}: ${err.message}`);
        return [];
    }
}

async function _getGroupPostsInner(groupUrl, groupName, account = null) {
    const groupId = extractGroupId(groupUrl);
    if (!groupId) return [];

    let page = null;
    try {
        const context = await getAuthContext(account);
        try {
            page = await context.newPage();
        } catch (pageErr) {
            console.warn(`[FBScraper] ⚠️ newPage failed (stealth plugin): ${pageErr.message} — retrying once`);
            await closeBrowser();
            const ctx2 = await getAuthContext(account);
            page = await ctx2.newPage();
        }

        console.log(`[FBScraper] 📥 ${groupName}`);
        await page.goto(`${FB_URL}/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await delay(2500);

        // Checkpoint/login detection
        const landedUrl = page.url();
        if (landedUrl.includes('checkpoint') || landedUrl.includes('two_step')) {
            console.log(`[FBScraper] 🚨 CHECKPOINT after goto ${groupName} — stopping`);
            if (account) accountManager.reportCheckpoint(account.id);
            await page.close();
            return [];
        }
        if (landedUrl.includes('/login')) {
            console.warn(`[FBScraper] 🔒 Redirected to login for ${groupName} — session expired`);
            state.isLoggedIn = false;
            await page.close();
            return [];
        }
        const pageTitle = await page.title();
        if (['security check', 'checkpoint', 'log in'].some(kw => pageTitle.toLowerCase().includes(kw))) {
            console.log(`[FBScraper] 🚨 Checkpoint page detected: "${pageTitle}" for ${groupName}`);
            if (account) accountManager.reportCheckpoint(account.id);
            await page.close();
            return [];
        }

        // Wait for feed
        try {
            await page.waitForSelector('div[role="feed"], div[role="article"]', { timeout: 10000 });
        } catch {
            const currentUrl = page.url();
            const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
            const isJoinPage = pageText.toLowerCase().includes('join group') || pageText.includes('Tham gia nhóm');
            const isDead = pageText.toLowerCase().includes('content isn\'t available') || pageText.includes('nội dung không');

            if (isDead) {
                console.warn(`[FBScraper] 💀 ${groupName}: DEAD GROUP — auto-deactivating`);
                try {
                    const gd = require('../../ai/agents/groupDiscovery');
                    if (gd.deactivateGroup) gd.deactivateGroup(groupUrl);
                } catch (_) { }
                await page.close();
                return [];
            } else if (isJoinPage) {
                console.log(`[FBScraper] 🚪 ${groupName}: NOT A MEMBER — auto-joining...`);
                try {
                    const joinBtn = await page.$('div[role="button"]:has-text("Join"), div[role="button"]:has-text("Tham gia"), div[role="button"]:has-text("Join group"), div[role="button"]:has-text("Tham gia nhóm")');
                    if (joinBtn) {
                        await joinBtn.click();
                        await delay(3000);
                        const afterText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
                        if (afterText.includes('Pending') || afterText.includes('Chờ phê duyệt') || afterText.includes('pending')) {
                            console.log(`[FBScraper] ⏳ ${groupName}: Join request sent — pending admin approval`);
                        } else {
                            console.log(`[FBScraper] ✅ ${groupName}: Joined! Reloading to scrape...`);
                            await page.goto(`${FB_URL}/groups/${groupId}?sorting_setting=CHRONOLOGICAL`, {
                                waitUntil: 'domcontentloaded', timeout: 25000,
                            });
                            await delay(5000);
                            const hasFeed = await page.$('div[role="feed"], div[role="article"]');
                            if (hasFeed) {
                                console.log(`[FBScraper] 🎉 ${groupName}: Feed loaded after join!`);
                            } else {
                                console.warn(`[FBScraper] ⚠️ ${groupName}: Joined but feed still not visible`);
                                await page.close();
                                return [];
                            }
                        }
                    } else {
                        console.warn(`[FBScraper] ⚠️ ${groupName}: Join button not found`);
                        await page.close();
                        return [];
                    }
                } catch (joinErr) {
                    console.warn(`[FBScraper] ⚠️ ${groupName}: Auto-join failed: ${joinErr.message}`);
                    await page.close();
                    return [];
                }
                if (!await page.$('div[role="feed"]')) {
                    await page.close();
                    return [];
                }
            } else {
                console.warn(`[FBScraper] ⚠️ Feed not found for ${groupName} (url: ${currentUrl.substring(0, 60)})`);
                await page.close();
                return [];
            }
        }

        // Smart scroll
        let prevHeight = 0;
        let noGrowthCount = 0;
        const TARGET_FEED_CHILDREN = 60;
        for (let i = 0; i < 40; i++) {
            await page.evaluate(() => window.scrollBy(0, 4000));
            await delay(250);
            const curHeight = await page.evaluate(() => document.body.scrollHeight);
            const feedCount = await page.evaluate(() =>
                document.querySelectorAll('div[role="feed"] > div').length
            );
            if (feedCount >= TARGET_FEED_CHILDREN && i >= 5) break;
            if (curHeight === prevHeight) {
                noGrowthCount++;
                if (i >= 5 && noGrowthCount >= 5) break;
            } else {
                noGrowthCount = 0;
            }
            prevHeight = curHeight;
        }

        // DOM debug
        const domDebug = await page.evaluate(() => {
            const articles = document.querySelectorAll('div[role="article"]').length;
            const feedChildren = document.querySelectorAll('div[role="feed"] > div').length;
            const hasFeed = !!document.querySelector('div[role="feed"]');
            const pageH = document.body.scrollHeight;
            const dirAutos = document.querySelectorAll('div[dir="auto"]').length;
            const firstText = document.querySelector('div[dir="auto"]')?.innerText?.substring(0, 80) || 'none';
            return { articles, feedChildren, hasFeed, pageH, dirAutos, firstText };
        });
        console.log(`[FBScraper] 🔍 DOM: ${domDebug.articles} articles, ${domDebug.feedChildren} feed-children, feed=${domDebug.hasFeed}, height=${domDebug.pageH}, dirAutos=${domDebug.dirAutos}`);
        if (domDebug.articles === 0 && domDebug.feedChildren === 0) {
            console.log(`[FBScraper] 🔍 Sample text: ${domDebug.firstText}`);
        }

        // Extract posts from DOM (same evaluate function as original)
        const posts = await page.evaluate((gUrl) => {
            const results = [];
            const seenTexts = new Set();
            let units = document.querySelectorAll('div[role="feed"] > div');
            if (units.length === 0) units = document.querySelectorAll('div[role="article"]');

            for (const unit of units) {
                try {
                    let content = '';
                    const dirAutos = unit.querySelectorAll('div[dir="auto"]');
                    for (const da of dirAutos) {
                        const t = (da.innerText || '').trim();
                        if (t.length > 15 && t.length > content.length && !t.includes('\n\n\n')) content = t;
                    }
                    if (!content || content.length < 15) continue;
                    const hash = content.substring(0, 80);
                    if (seenTexts.has(hash)) continue;
                    seenTexts.add(hash);

                    let authorName = 'Unknown';
                    let authorUrl = '';
                    let authorAvatar = '';
                    const authorLinkEl = unit.querySelector('a strong');
                    if (authorLinkEl) {
                        authorName = authorLinkEl.innerText?.trim() || 'Unknown';
                        const aTag = authorLinkEl.closest('a');
                        if (aTag && aTag.href && !aTag.href.includes('/groups/')) authorUrl = aTag.href.split('?')[0];
                    } else {
                        const strong = unit.querySelector('strong');
                        if (strong && (strong.innerText?.trim()?.length || 0) < 40) authorName = strong.innerText?.trim() || 'Unknown';
                    }
                    if (!authorUrl) {
                        const userLink = unit.querySelector('a[href*="/user/"]');
                        if (userLink) authorUrl = userLink.href.split('?')[0];
                    }
                    const svgImg = unit.querySelector('image[href], image[xlink\\:href]');
                    if (svgImg) authorAvatar = svgImg.getAttribute('href') || svgImg.getAttribute('xlink:href') || '';
                    if (!authorAvatar) {
                        const imgEl = unit.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
                        if (imgEl) authorAvatar = imgEl.src || '';
                    }

                    let postUrl = '';
                    const isPostLink = (href) => href && (
                        href.includes('/posts/') || href.includes('story_fbid') ||
                        href.includes('permalink') || href.includes('/permalink/')
                    );
                    for (const a of unit.querySelectorAll('a')) {
                        if (isPostLink(a.href)) { postUrl = a.href; break; }
                    }
                    if (!postUrl) {
                        const timeSelectors = [
                            'a[aria-label*="giờ"]', 'a[aria-label*="phút"]', 'a[aria-label*="ngày"]',
                            'a[aria-label*="tuần"]', 'a[aria-label*="tháng"]',
                            'a[aria-label*="hour"]', 'a[aria-label*="minute"]',
                            'a[aria-label*="day"]', 'a[aria-label*="week"]', 'a[aria-label*="month"]',
                            'a abbr[title]',
                        ];
                        for (const sel of timeSelectors) {
                            const el2 = sel.endsWith(']') && sel.includes(' ')
                                ? unit.querySelector(sel)?.closest('a')
                                : unit.querySelector(sel);
                            if (el2 && isPostLink(el2.href)) { postUrl = el2.href; break; }
                        }
                    }
                    if (!postUrl) {
                        for (const a of unit.querySelectorAll('a[href*="/photo/"]')) {
                            const setMatch = (a.href || '').match(/[?&]set=(?:pcb|gm|pb|g)\.(\d+)/);
                            if (setMatch) {
                                const grpLink = unit.querySelector('a[href*="/groups/"][href*="/user/"]');
                                if (grpLink) {
                                    const grpMatch = grpLink.href.match(/\/groups\/(\d+)\//);
                                    if (grpMatch) { postUrl = `https://www.facebook.com/groups/${grpMatch[1]}/posts/${setMatch[1]}/`; break; }
                                }
                            }
                        }
                    }
                    if (!postUrl) {
                        const grpPostLink = unit.querySelector('a[href*="/groups/"][href*="/posts/"]');
                        if (grpPostLink) postUrl = grpPostLink.href;
                    }
                    if (postUrl) {
                        try { const u = new URL(postUrl); u.search = ''; postUrl = u.toString(); } catch { }
                    }

                    let createdAt = null;
                    const allSpans = unit.querySelectorAll('span');
                    for (const sp of allSpans) {
                        const t = sp.innerText?.trim();
                        if (!t || t.length > 30 || t.length < 1) continue;
                        const now = Date.now();
                        if (/^\d+h$/i.test(t) || /^\d+\s*hr/i.test(t) || /^\d+\s*giờ/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 3600000).toISOString(); break;
                        }
                        if (/^\d+m$/i.test(t) || /^\d+\s*min/i.test(t) || /^\d+\s*phút/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 60000).toISOString(); break;
                        }
                        if (/^\d+d$/i.test(t) || /^\d+\s*ngày/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 86400000).toISOString(); break;
                        }
                        if (/^\d+w$/i.test(t) || /^\d+\s*tuần/i.test(t) || /^\d+\s*week/i.test(t)) {
                            createdAt = new Date(now - parseInt(t.match(/\d+/)[0]) * 7 * 86400000).toISOString(); break;
                        }
                        if (/^yesterday/i.test(t) || /^hôm qua/i.test(t)) {
                            createdAt = new Date(now - 86400000).toISOString(); break;
                        }
                        if (/^just now/i.test(t) || /^vừa xong/i.test(t)) {
                            createdAt = new Date().toISOString(); break;
                        }
                    }
                    if (!createdAt) createdAt = new Date().toISOString();
                    const postAge = (Date.now() - new Date(createdAt).getTime()) / 86400000;
                    if (postAge > 14) continue;

                    let commentCount = 0;
                    allSpans.forEach(sp => {
                        const m = (sp.innerText || '').match(/(\d+)\s*(comment|bình luận)/i);
                        if (m) commentCount = Math.max(commentCount, parseInt(m[1]));
                    });

                    const topComments = [];
                    const comEls = unit.querySelectorAll('ul li div[dir="auto"], div[aria-label*="comment"] div[dir="auto"]');
                    let ci = 0;
                    for (const ce of comEls) {
                        if (ci >= 5) break;
                        const ct = (ce.innerText || '').trim();
                        if (ct.length > 5 && ct.length < 300 && ct !== content) {
                            topComments.push({ text: ct, publishTime: new Date().toISOString(), author_name: 'Unknown', author_url: '' });
                            ci++;
                        }
                    }

                    results.push({
                        url: postUrl || gUrl,
                        content: content.substring(0, 2000),
                        author_name: authorName, author_url: authorUrl, author_avatar: authorAvatar,
                        created_at: createdAt, commentCount, topComments,
                    });
                } catch { }
            }
            return results;
        }, groupUrl);

        console.log(`[FBScraper] ✅ ${groupName}: ${posts.length} posts`);
        await page.close();
        await delay(500);
        return posts;
    } catch (err) {
        console.error(`[FBScraper] ❌ ${groupName}: ${err.message}`);
        if (page) try { await page.close(); } catch { }
        return [];
    }
}

module.exports = { getGroupPosts };
