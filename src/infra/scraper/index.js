/**
 * Scraper Facade — Re-exports all scraper modules
 * Backward-compatible: require('../scraper') === require('../../ai/fbScraper')
 * 
 * @module scraper/index
 */
const { closeBrowser, fetchFreeProxies, loadFreeProxies, extractGroupId } = require('./browserManager');
const { getGroupPosts } = require('./groupScraper');
const { getPostComments } = require('./commentScraper');
const { autoJoinGroups } = require('./groupJoiner');
const { scrapeFacebookGroups } = require('./orchestrator');
const { bridgeToHub } = require('./hubBridge');

// Test function
async function testScrape() {
    console.log('[FBScraper] 🧪 Testing login-based scraper...');
    await loadFreeProxies();
    const posts = await getGroupPosts(
        'https://www.facebook.com/groups/238061523539498',
        'Test: CĐ Người Việt tại Mỹ'
    );
    console.log(`\n📊 Results: ${posts.length} posts`);
    for (const p of posts.slice(0, 5)) {
        console.log(`  ${p.author_name}: ${p.content.substring(0, 80)}...`);
    }
    await closeBrowser();
    return posts;
}

// Compat stubs
function setCookies() { }
function getCookies() { return ''; }

module.exports = {
    getGroupPosts,
    getPostComments,
    autoJoinGroups,
    scrapeFacebookGroups,
    setCookies,
    getCookies,
    fetchFreeProxies,
    loadFreeProxies,
    closeBrowser,
    testScrape,
    extractGroupId,
    bridgeToHub,
};
