const db = require('./src/data_store/database');
const groupScraper = require('./src/scraper/groupScraper');
const classifier = require('./src/agent/classifier');

(async () => {
    console.log("Starting forced scrape to get fresh leads with author_urls...");
    const url = "https://www.facebook.com/groups/shopifydevelopervn";
    const posts = await groupScraper.getGroupPosts(url, "Shopify Group");
    console.log(`Scraped ${posts.length} posts. First post author_url: `, posts[0]?.author_url);

    // insert to DB for testing
    const insertLead = require('better-sqlite3')('./data/leads.db').prepare(`
        INSERT OR IGNORE INTO leads (platform, post_url, author_name, author_url, author_avatar, content, score, category, summary, urgency, suggested_response, role, buyer_signals, scraped_at, post_created_at, profit_estimate, gap_opportunity, pain_score, spam_score, item_type)
        VALUES (@platform, @post_url, @author_name, @author_url, @author_avatar, @content, @score, @category, @summary, @urgency, @suggested_response, @role, @buyer_signals, @scraped_at, @post_created_at, @profit_estimate, @gap_opportunity, @pain_score, @spam_score, @item_type)
    `);

    let newCount = 0;
    for (const post of posts) {
        if (!post.content || post.content.length < 15) continue;

        // Mock classification to ensure it lands in Dashboard
        insertLead.run({
            platform: 'facebook',
            post_url: post.url,
            author_name: post.author_name,
            author_url: post.author_url,
            author_avatar: post.author_avatar,
            content: post.content,
            score: 75,
            category: 'THG Fulfill (Dropship)',
            summary: "Fresh test lead",
            urgency: 'high',
            suggested_response: 'test',
            role: 'buyer',
            buyer_signals: 'test',
            scraped_at: new Date().toISOString(),
            post_created_at: post.created_at || new Date().toISOString(),
            profit_estimate: 'high',
            gap_opportunity: 'test',
            pain_score: 0,
            spam_score: 0,
            item_type: 'post'
        });
        newCount++;
    }
    console.log(`Inserted ${newCount} fresh leads.`);
    process.exit(0);
})();
