/**
 * THG Lead Gen — Webshare.io Proxy Fetcher
 * 
 * Auto-fetches proxy list from Webshare.io API and feeds into ProxyPool.
 * Supports free tier (10 datacenter proxies) and paid tiers.
 * 
 * Env vars:
 *   WEBSHARE_API_KEY - API key from https://dashboard.webshare.io/
 * 
 * @module proxy/webshareFetcher
 */

'use strict';

const axios = require('axios');
const { pool } = require('./proxyPool');

const API_BASE = 'https://proxy.webshare.io/api/v2';

/**
 * Fetch proxy list from Webshare.io API.
 * Free tier: 10 datacenter proxies with username/password auth.
 * 
 * @returns {Array<{url: string, country: string}>} Proxy URLs in http://user:pass@host:port format
 */
async function fetchWebshareProxies() {
    const apiKey = process.env.WEBSHARE_API_KEY;
    if (!apiKey) {
        console.log('[Webshare] ⏭ No WEBSHARE_API_KEY — skipping');
        return [];
    }

    try {
        console.log('[Webshare] 📡 Fetching proxy list...');

        // Paginate through all proxies (free tier = 10, paid = more)
        const allProxies = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const res = await axios.get(`${API_BASE}/proxy/list/`, {
                params: { mode: 'direct', page, page_size: 100 },
                headers: { Authorization: `Token ${apiKey}` },
                timeout: 15000,
            });

            const { results, next } = res.data;
            if (results && results.length > 0) {
                for (const p of results) {
                    if (!p.valid) continue;
                    // Build proxy URL: http://username:password@address:port
                    const url = `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`;
                    allProxies.push({
                        url,
                        country: p.country_code || 'US',
                        city: p.city_name || '',
                        provider: 'webshare',
                    });
                }
            }
            hasMore = !!next;
            page++;
        }

        console.log(`[Webshare] ✅ Fetched ${allProxies.length} valid proxies`);
        return allProxies;
    } catch (err) {
        console.error(`[Webshare] ❌ API error: ${err.message}`);
        return [];
    }
}

/**
 * Load Webshare proxies into ProxyPool.
 * Deduplicates with existing proxies, replaces stale Webshare entries.
 */
async function loadWebshareIntoPool() {
    const proxies = await fetchWebshareProxies();
    if (proxies.length === 0) return 0;

    if (!pool.loaded) await pool.load();

    // Remove old webshare proxies (they rotate on refresh)
    if (pool.data && pool.data.active_proxies) {
        pool.data.active_proxies = pool.data.active_proxies.filter(
            p => p.provider !== 'webshare'
        );
    }

    // Add fresh proxies
    for (const p of proxies) {
        pool.addProxy({
            url: p.url,
            provider: 'webshare',
            type: 'datacenter',
            region: p.country,
        });
    }

    await pool.save();
    console.log(`[Webshare] ✅ Loaded ${proxies.length} proxies into pool`);
    return proxies.length;
}

/**
 * Auto-assign proxies to FB accounts (1:1 mapping for anti-chain-ban).
 * Only assigns to accounts that don't already have a proxy.
 */
async function autoAssignProxiesToAccounts() {
    if (!pool.loaded) await pool.load();
    const available = pool.getAvailable().filter(p => p.provider === 'webshare');
    if (available.length === 0) {
        console.log('[Webshare] ⚠️ No Webshare proxies available to assign');
        return;
    }

    try {
        const db = require('../../core/data_store/database');
        const accounts = db.db.prepare(
            `SELECT * FROM fb_accounts WHERE (proxy_url IS NULL OR proxy_url = '') AND status != 'banned'`
        ).all();

        if (accounts.length === 0) {
            console.log('[Webshare] ℹ️ All accounts already have proxies assigned');
            return;
        }

        let assigned = 0;
        for (let i = 0; i < accounts.length && i < available.length; i++) {
            const acc = accounts[i];
            const proxy = available[i];
            db.db.prepare(`UPDATE fb_accounts SET proxy_url = ? WHERE id = ?`)
                .run(proxy.url, acc.id);
            console.log(`[Webshare] 🔗 ${acc.email} → ${proxy.region} proxy (${proxy.id})`);
            assigned++;
        }

        console.log(`[Webshare] ✅ Auto-assigned ${assigned}/${accounts.length} accounts`);
    } catch (err) {
        console.error(`[Webshare] ⚠️ Auto-assign failed: ${err.message}`);
    }
}

module.exports = {
    fetchWebshareProxies,
    loadWebshareIntoPool,
    autoAssignProxiesToAccounts,
};
