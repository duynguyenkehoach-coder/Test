/**
 * THG Lead Gen — PhantomBuster Integration
 * 
 * Replaces Apify for Facebook Group scraping.
 * PhantomBuster is better for FB because it uses session cookies
 * and can access private groups.
 * 
 * Setup required in PhantomBuster dashboard:
 * 1. Create "Facebook Group Posts Extractor" phantom
 * 2. Configure with FB session cookie
 * 3. Add target group URLs
 * 4. Get the Phantom Agent ID
 * 
 * API Flow:
 * 1. POST /agents/launch — start the phantom
 * 2. Poll GET /agents/fetch — wait for completion
 * 3. GET /agents/fetch-output — get results
 */

const axios = require('axios');
const config = require('../config');

const PB_API_BASE = 'https://api.phantombuster.com/api/v2';
const PB_API_KEY = process.env.PHANTOMBUSTER_API_KEY || '';

function getHeaders() {
    return {
        'X-Phantombuster-Key': PB_API_KEY,
        'Content-Type': 'application/json',
    };
}

/**
 * Launch a PhantomBuster agent and wait for results
 */
async function launchAndWait(agentId, args = {}, timeoutMs = 120000) {
    if (!PB_API_KEY) throw new Error('No PHANTOMBUSTER_API_KEY');

    console.log(`[PhantomBuster] 🚀 Launching agent ${agentId}...`);

    // Launch the agent
    const launchResp = await axios.post(`${PB_API_BASE}/agents/launch`, {
        id: agentId,
        ...(Object.keys(args).length > 0 ? { argument: JSON.stringify(args) } : {}),
    }, { headers: getHeaders(), timeout: 30000 });

    const containerId = launchResp.data?.containerId;
    console.log(`[PhantomBuster] ✅ Launched! Container: ${containerId || 'running'}`);

    // Poll for completion
    const startTime = Date.now();
    let status = 'running';

    while (status === 'running' && (Date.now() - startTime) < timeoutMs) {
        await new Promise(r => setTimeout(r, 5000)); // Poll every 5s

        try {
            const fetchResp = await axios.get(`${PB_API_BASE}/agents/fetch`, {
                params: { id: agentId },
                headers: getHeaders(),
                timeout: 15000,
            });

            const agent = fetchResp.data;
            status = agent?.lastEndMessage || 'running';

            if (agent?.lastEndMessage && agent.lastEndMessage !== 'running') {
                console.log(`[PhantomBuster] 📊 Agent finished: ${agent.lastEndMessage}`);
                break;
            }

            // Check if agent is no longer running
            if (agent?.runningContainers === 0 || agent?.exitCode !== undefined) {
                break;
            }
        } catch (err) {
            console.warn(`[PhantomBuster] ⚠️ Poll error: ${err.message}`);
        }
    }

    return agentId;
}

/**
 * Fetch results from a PhantomBuster agent's latest run
 */
async function fetchResults(agentId) {
    if (!PB_API_KEY) throw new Error('No PHANTOMBUSTER_API_KEY');

    try {
        const resp = await axios.get(`${PB_API_BASE}/agents/fetch-output`, {
            params: { id: agentId },
            headers: getHeaders(),
            timeout: 30000,
        });

        // PhantomBuster returns output as string (JSON lines or CSV)
        const output = resp.data?.output || '';
        const resultUrl = resp.data?.resultObject;

        // Try to parse result object URL (contains the JSON data)
        if (resultUrl) {
            try {
                const dataResp = await axios.get(resultUrl, { timeout: 30000 });
                if (Array.isArray(dataResp.data)) return dataResp.data;
                if (typeof dataResp.data === 'string') {
                    // Try JSON lines format
                    return dataResp.data.split('\n').filter(Boolean).map(line => {
                        try { return JSON.parse(line); } catch { return null; }
                    }).filter(Boolean);
                }
            } catch (err) {
                console.warn(`[PhantomBuster] ⚠️ Result URL fetch failed: ${err.message}`);
            }
        }

        // Fallback: parse output string
        if (output) {
            try {
                const parsed = JSON.parse(output);
                if (Array.isArray(parsed)) return parsed;
            } catch {
                // Try JSON lines
                return output.split('\n').filter(Boolean).map(line => {
                    try { return JSON.parse(line); } catch { return null; }
                }).filter(Boolean);
            }
        }

        return [];
    } catch (err) {
        console.error(`[PhantomBuster] ❌ Fetch results failed: ${err.message}`);
        return [];
    }
}

/**
 * Scrape Facebook Group posts using PhantomBuster
 * agentId = the Phantom Agent ID configured in PB dashboard
 */
async function scrapeGroupPosts(agentId, groupUrl, maxPosts = 20) {
    try {
        // Launch with group-specific args
        await launchAndWait(agentId, {
            groupUrl: groupUrl,
            numberOfPosts: maxPosts,
        });

        // Fetch results
        const rawData = await fetchResults(agentId);

        // Normalize to our post format
        const posts = rawData.map(item => ({
            platform: 'facebook',
            post_url: item.postUrl || item.url || item.permalink || '',
            author_name: item.profileName || item.name || item.authorName || item.userName || 'Unknown',
            author_url: item.profileUrl || item.profileLink || '',
            content: item.message || item.postContent || item.text || item.postText || '',
            post_created_at: item.date || item.timestamp || item.postedAt || null,
            scraped_at: new Date().toISOString(),
            source: `phantombuster:${agentId}`,
            // Extra PB fields
            likes: item.likeCount || item.likes || 0,
            comments: item.commentCount || item.comments || 0,
            shares: item.shareCount || item.shares || 0,
        })).filter(p => p.content && p.content.length > 15);

        console.log(`[PhantomBuster] ✅ ${posts.length} posts extracted`);
        return posts;
    } catch (err) {
        console.error(`[PhantomBuster] ❌ scrapeGroupPosts failed: ${err.message}`);
        return [];
    }
}

/**
 * Scrape multiple FB groups using PhantomBuster
 */
async function scrapeMultipleGroups(agentId, groups, maxPostsTotal = 20) {
    if (!PB_API_KEY) {
        console.warn('[PhantomBuster] ⚠️ No API key, skipping');
        return [];
    }

    const allPosts = [];
    const postsPerGroup = Math.ceil(maxPostsTotal / groups.length);

    for (const group of groups) {
        console.log(`[PhantomBuster] 📌 ${group.name}...`);
        try {
            const posts = await scrapeGroupPosts(agentId, group.url, postsPerGroup);
            // Tag with group name
            posts.forEach(p => p.source = `group:${group.name}`);
            allPosts.push(...posts);
            console.log(`[PhantomBuster] ✓ ${posts.length} posts from ${group.name}`);
            await new Promise(r => setTimeout(r, 3000)); // Delay between groups
        } catch (err) {
            console.warn(`[PhantomBuster] ⚠️ ${group.name}: ${err.message}`);
        }
    }

    console.log(`[PhantomBuster] 📊 Total: ${allPosts.length} posts from ${groups.length} groups`);
    return allPosts;
}

/**
 * Check if PhantomBuster is configured and working
 */
async function testConnection() {
    if (!PB_API_KEY) return { ok: false, error: 'No API key' };

    try {
        const resp = await axios.get(`${PB_API_BASE}/user`, {
            headers: getHeaders(),
            timeout: 10000,
        });
        return {
            ok: true,
            email: resp.data?.email,
            plan: resp.data?.plan,
            timeLeft: resp.data?.timeLeft,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    launchAndWait,
    fetchResults,
    scrapeGroupPosts,
    scrapeMultipleGroups,
    testConnection,
};
