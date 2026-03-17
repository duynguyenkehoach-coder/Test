/**
 * Hub Bridge — Send scraped posts to VPS Hub
 * Only active when HUB_URL env var is set.
 * 
 * @module scraper/hubBridge
 */
const axios = require('axios');

async function bridgeToHub(posts) {
    const hubUrl = process.env.HUB_URL;
    if (!hubUrl) return;

    const authKey = process.env.WORKER_AUTH_KEY || 'thg_worker_2026';
    const endpoint = `${hubUrl.replace(/\/$/, '')}/api/leads/collect`;

    try {
        const res = await axios.post(endpoint, { posts }, {
            headers: { 'x-thg-auth-key': authKey },
            timeout: 30000,
        });
        console.log(`[Bridge] 🚀 Sent ${posts.length} posts to Hub → saved: ${res.data?.saved || '?'}`);
    } catch (e) {
        console.warn(`[Bridge] ❌ Hub unreachable: ${e.message}. Posts saved locally only.`);
    }
}

module.exports = { bridgeToHub };
