/**
 * THG Lead Gen — Multi-Platform Scraper v7 (SociaVault)
 * 
 * All scraping powered by SociaVault REST API:
 * - Facebook: Group Posts scraping
 * - Instagram: Hashtag search
 * - TikTok: Keyword search
 * 
 * Clean single-source pipeline. No more Apify/RapidAPI/PhantomBuster.
 */

const config = require('../config');
const sv = require('./sociaVault');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// Dedup helper
// ═══════════════════════════════════════════════════════
function dedup(posts) {
    const seen = new Set();
    return posts.filter(p => {
        const key = p.post_url || p.content?.substring(0, 100);
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
    });
}

// ═══════════════════════════════════════════════════════
// Platform scrapers — all SociaVault
// ═══════════════════════════════════════════════════════

async function scrapeFacebook(_keywords, maxPosts = 20) {
    console.log('[Scraper:FB] 📘 Scraping Facebook via SociaVault...');
    try {
        const posts = await sv.scrapeFacebookGroups(maxPosts);
        console.log(`[Scraper:FB] ✅ ${posts.length} posts`);
        return dedup(posts);
    } catch (err) {
        console.error(`[Scraper:FB] ❌ ${err.message}`);
        return [];
    }
}

async function scrapeInstagram(_hashtags, maxPosts = 30) {
    console.log('[Scraper:IG] 📷 Scraping Instagram via SociaVault...');
    try {
        const posts = await sv.scrapeInstagram(maxPosts);
        console.log(`[Scraper:IG] ✅ ${posts.length} posts`);
        return dedup(posts);
    } catch (err) {
        console.error(`[Scraper:IG] ❌ ${err.message}`);
        return [];
    }
}

async function scrapeTikTok(_keywords, maxPosts = 20) {
    console.log('[Scraper:TT] 🎵 Scraping TikTok via SociaVault...');
    try {
        const posts = await sv.scrapeTikTok(maxPosts);
        console.log(`[Scraper:TT] ✅ ${posts.length} posts`);
        return dedup(posts);
    } catch (err) {
        console.error(`[Scraper:TT] ❌ ${err.message}`);
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// Full Scan Orchestrator
// ═══════════════════════════════════════════════════════
const SCRAPERS = {
    facebook: { fn: scrapeFacebook, getKeywords: () => [] },
    instagram: { fn: scrapeInstagram, getKeywords: () => config.SEARCH_KEYWORDS?.instagram || [] },
    tiktok: { fn: scrapeTikTok, getKeywords: () => config.SEARCH_KEYWORDS?.tiktok || [] },
};

async function runFullScan(options = {}) {
    const platforms = options.platforms || ['facebook', 'tiktok', 'instagram'];
    const maxPerPlatform = options.maxPosts || 20;

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  🔵 SociaVault API — All platforms`);
    console.log(`  📊 Max per platform: ${maxPerPlatform} posts`);
    console.log(`${'═'.repeat(55)}\n`);

    const results = {};
    for (const platform of platforms) {
        const scraper = SCRAPERS[platform];
        if (!scraper) { console.error(`[Scraper] Unknown platform: ${platform}`); continue; }
        try {
            const keywords = scraper.getKeywords();
            results[platform] = await scraper.fn(keywords, maxPerPlatform);
            console.log(`[Scraper] ✅ ${platform}: ${results[platform].length} posts\n`);
        } catch (err) {
            console.error(`[Scraper] ❌ ${platform}: ${err.message}`);
            results[platform] = [];
        }
        await delay(3000);
    }

    const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  📊 Total: ${total} posts`);
    Object.entries(results).forEach(([p, r]) => console.log(`     ${p}: ${r.length}`));
    console.log(`${'═'.repeat(55)}\n`);

    return results;
}

module.exports = {
    scrapeFacebook, scrapeInstagram,
    scrapeTikTok, runFullScan,
};
