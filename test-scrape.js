// Quick test script for real Apify scanning
require('dotenv').config();
const { ApifyClient } = require('apify-client');

const APIFY_TOKEN = process.env.APIFY_TOKEN;
console.log('Token:', APIFY_TOKEN ? APIFY_TOKEN.substring(0, 20) + '...' : 'MISSING');

const client = new ApifyClient({ token: APIFY_TOKEN });

async function testReddit() {
    console.log('\n--- REDDIT ---');
    try {
        const run = await client.actor('trudax/reddit-scraper').call({
            startUrls: [
                { url: 'https://www.reddit.com/search/?q=print+on+demand+fulfillment&sort=new&t=week' },
                { url: 'https://www.reddit.com/r/dropship/search/?q=fulfillment&sort=new&t=month' },
            ],
            maxItems: 10,
            maxPostCount: 10,
            maxComments: 0,
            proxy: { useApifyProxy: true },
        });
        console.log('Run status:', run.status);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        console.log('Posts found:', items.length);
        if (items[0]) {
            console.log('Keys:', Object.keys(items[0]).join(', '));
            console.log('Sample title:', items[0].title);
            console.log('Sample author:', items[0].username || items[0].author);
            console.log('Sample url:', items[0].url);
            console.log('Sample body:', (items[0].body || items[0].text || items[0].selftext || '').substring(0, 150));
        }
    } catch (e) {
        console.log('Error:', e.message);
        // Try alternative actor
        console.log('Trying alternative Reddit actor...');
        try {
            const run = await client.actor('apify/reddit-scraper').call({
                startUrls: [{ url: 'https://www.reddit.com/r/dropship/search/?q=fulfillment' }],
                maxItems: 5,
            });
            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            console.log('Alt Reddit posts:', items.length);
            if (items[0]) console.log('Alt keys:', Object.keys(items[0]).join(', '));
        } catch (e2) {
            console.log('Alt also failed:', e2.message);
        }
    }
}

async function testTwitter() {
    console.log('\n--- TWITTER ---');
    try {
        const run = await client.actor('apidojo/tweet-scraper').call({
            searchTerms: ['print on demand fulfillment'],
            maxTweets: 5,
            sort: 'Latest',
        });
        console.log('Run status:', run.status);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        console.log('Tweets found:', items.length);
        if (items[0]) {
            console.log('Keys:', Object.keys(items[0]).join(', '));
            console.log('Sample text:', (items[0].text || items[0].full_text || '').substring(0, 150));
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
}

async function testTikTok() {
    console.log('\n--- TIKTOK ---');
    try {
        const run = await client.actor('clockworks/tiktok-scraper').call({
            searchQueries: ['print on demand'],
            resultsPerPage: 5,
            maxItems: 5,
            shouldDownloadVideos: false,
        });
        console.log('Run status:', run.status);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        console.log('TikToks found:', items.length);
        if (items[0]) {
            console.log('Keys:', Object.keys(items[0]).join(', '));
            console.log('Sample desc:', (items[0].text || items[0].desc || '').substring(0, 150));
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
}

async function testFacebook() {
    console.log('\n--- FACEBOOK ---');
    try {
        const run = await client.actor('apify/facebook-search-scraper').call({
            searchQueries: ['print on demand fulfillment'],
            maxPosts: 5,
            searchType: 'posts',
        });
        console.log('Run status:', run.status);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        console.log('FB posts found:', items.length);
        if (items[0]) {
            console.log('Keys:', Object.keys(items[0]).join(', '));
            console.log('Sample text:', (items[0].text || items[0].postText || '').substring(0, 150));
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
}

async function testInstagram() {
    console.log('\n--- INSTAGRAM ---');
    try {
        const run = await client.actor('apify/instagram-hashtag-scraper').call({
            hashtags: ['printondemand'],
            resultsLimit: 5,
        });
        console.log('Run status:', run.status);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        console.log('IG posts found:', items.length);
        if (items[0]) {
            console.log('Keys:', Object.keys(items[0]).join(', '));
            console.log('Sample caption:', (items[0].caption || items[0].text || '').substring(0, 150));
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
}

(async () => {
    // Run all tests in parallel
    await Promise.allSettled([
        testReddit(),
        testTwitter(),
        testTikTok(),
        testFacebook(),
        testInstagram(),
    ]);
    console.log('\n✅ All tests complete');
    process.exit(0);
})();
