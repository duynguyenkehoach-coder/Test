/**
 * Comment Scraper — Extract comments from a specific post
 * 
 * @module scraper/commentScraper
 */
const { delay } = require('./browserManager');
const { getAuthContext } = require('./authContext');

async function getPostComments(postUrl, source) {
    let page = null;
    try {
        const context = await getAuthContext();
        page = await context.newPage();

        console.log(`[FBScraper] 💬 Comments: ${postUrl.substring(0, 70)}...`);
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(4000);

        // Expand comments
        try {
            const moreBtn = await page.$('span:has-text("View more comments"), span:has-text("Xem thêm")');
            if (moreBtn) { await moreBtn.click(); await delay(2000); }
        } catch { }

        await page.evaluate(() => window.scrollBy(0, 2000));
        await delay(1500);

        const comments = await page.evaluate(({ pUrl, src }) => {
            const results = [];
            const seen = new Set();
            const comEls = document.querySelectorAll('div[role="article"], ul li, div[aria-label*="comment"]');

            for (const el of comEls) {
                try {
                    let content = '';
                    el.querySelectorAll('div[dir="auto"]').forEach(da => {
                        const t = (da.innerText || '').trim();
                        if (t.length > 5 && t.length > content.length && t.length < 500) content = t;
                    });
                    if (!content || content.length < 5) continue;
                    if (seen.has(content)) continue;
                    seen.add(content);

                    const aEl = el.querySelector('a[role="link"] strong, a strong, strong');
                    const authorName = aEl?.innerText?.trim() || 'Unknown';
                    let authorUrl = '';
                    const aLink = el.querySelector('a[role="link"]');
                    if (aLink) authorUrl = (aLink.href || '').split('?')[0];

                    results.push({
                        platform: 'facebook',
                        post_url: pUrl,
                        author_name: authorName,
                        author_url: authorUrl,
                        content,
                        post_created_at: new Date().toISOString(),
                        scraped_at: new Date().toISOString(),
                        source: src,
                        likes: 0,
                        comments: 0,
                    });
                } catch { }
            }
            return results;
        }, { pUrl: postUrl, src: source });

        console.log(`[FBScraper] ✅ ${comments.length} comments`);
        await page.close();
        await delay(1000);
        return comments;

    } catch (err) {
        console.error(`[FBScraper] ❌ Comments: ${err.message}`);
        if (page) try { await page.close(); } catch { };
        return [];
    }
}

module.exports = { getPostComments };
