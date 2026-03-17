/**
 * THG Multi-Agent System — Proxy Pool Manager
 * 
 * Quản lý danh sách proxy từ nhiều nhà cung cấp (IPRoyal, Smartproxy, Proxy-Cheap).
 * Round-robin rotation, health tracking, auto-blacklist, cooldown recovery.
 * 
 * @module proxy/proxyPool
 */

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');

const PROXIES_PATH = path.join(__dirname, '..', '..', '..', 'data', 'proxies.json');

// ═══════════════════════════════════════════════════════
// Proxy status constants
// ═══════════════════════════════════════════════════════
const STATUS = {
    ACTIVE: 'active',
    COOLING: 'cooling_down',
    BANNED: 'banned',
    UNCHECKED: 'unchecked',
};

const MAX_FAIL_COUNT = 3;           // Fail 3x → blacklist
const COOLDOWN_MINUTES = 30;        // Cool-down period after 1-2 fails
const LATENCY_WARN_MS = 3000;       // Warn if latency > 3s
const PING_TIMEOUT_MS = 8000;       // Timeout for health check
const PING_TARGET_URL = 'https://www.google.com/robots.txt'; // Lightweight target

class ProxyPool {
    constructor(configPath = PROXIES_PATH) {
        this.configPath = configPath;
        this.data = null;
        this.currentIndex = 0;
        this.loaded = false;
    }

    // ═══════════════════════════════════════════════════
    // Load / Save
    // ═══════════════════════════════════════════════════

    async load() {
        try {
            const raw = await fs.readFile(this.configPath, 'utf8');
            this.data = JSON.parse(raw);
            this.loaded = true;
            console.log(`[ProxyPool] ✅ Loaded ${this.getActiveCount()} active proxies`);
        } catch (err) {
            console.warn(`[ProxyPool] ⚠️ Cannot load proxies: ${err.message}`);
            this.data = { active_proxies: [], blacklisted_proxies: [] };
            this.loaded = true;
        }
        return this;
    }

    async save() {
        if (!this.data) return;
        this.data.last_updated = new Date().toISOString();
        await fs.writeFile(this.configPath, JSON.stringify(this.data, null, 2), 'utf8');
    }

    // ═══════════════════════════════════════════════════
    // Query helpers
    // ═══════════════════════════════════════════════════

    getActiveCount() {
        return this.getAvailable().length;
    }

    getAvailable() {
        if (!this.data) return [];
        const now = Date.now();
        return this.data.active_proxies.filter(p => {
            if (p.status === STATUS.BANNED) return false;
            if (p.status === STATUS.COOLING && p.cooldown_until) {
                // Check if cooldown expired
                if (new Date(p.cooldown_until).getTime() > now) return false;
                p.status = STATUS.ACTIVE; // Auto-recover
            }
            return true;
        });
    }

    hasProxies() {
        return this.getActiveCount() > 0;
    }

    // ═══════════════════════════════════════════════════
    // Get Next Proxy — Smart selection
    // ═══════════════════════════════════════════════════

    /**
     * Get best available proxy.
     * Strategy: sort by latency (lowest first), then by last_used (oldest first).
     * Falls back to round-robin if all latencies are equal.
     * 
     * @param {string} [preferRegion] - Preferred region (e.g. 'US', 'VN')
     * @returns {{ proxy: object, proxyUrl: string } | null}
     */
    getBestProxy(preferRegion = null) {
        const available = this.getAvailable();
        if (available.length === 0) return null;

        // Filter by region if requested
        let candidates = preferRegion
            ? available.filter(p => p.region === preferRegion)
            : available;
        if (candidates.length === 0) candidates = available; // fallback to all

        // Sort: active first, then by latency (lowest), then last_used (oldest)
        candidates.sort((a, b) => {
            // Active > cooling
            if (a.status === STATUS.ACTIVE && b.status !== STATUS.ACTIVE) return -1;
            if (b.status === STATUS.ACTIVE && a.status !== STATUS.ACTIVE) return 1;
            // Lower latency first
            const la = a.latency || 9999;
            const lb = b.latency || 9999;
            if (la !== lb) return la - lb;
            // Oldest used first (round-robin effect)
            const ta = a.last_used ? new Date(a.last_used).getTime() : 0;
            const tb = b.last_used ? new Date(b.last_used).getTime() : 0;
            return ta - tb;
        });

        const proxy = candidates[0];
        proxy.last_used = new Date().toISOString();
        return { proxy, proxyUrl: proxy.url };
    }

    /**
     * Simple round-robin (for when smart selection is not needed)
     */
    getNextProxy() {
        const available = this.getAvailable();
        if (available.length === 0) return null;

        const proxy = available[this.currentIndex % available.length];
        this.currentIndex = (this.currentIndex + 1) % available.length;
        proxy.last_used = new Date().toISOString();
        return { proxy, proxyUrl: proxy.url };
    }

    // ═══════════════════════════════════════════════════
    // Report Success / Failure
    // ═══════════════════════════════════════════════════

    reportSuccess(proxy) {
        proxy.fail_count = 0;
        proxy.success_count = (proxy.success_count || 0) + 1;
        proxy.status = STATUS.ACTIVE;
    }

    reportFailure(proxy, reason = 'unknown') {
        proxy.fail_count = (proxy.fail_count || 0) + 1;
        console.warn(`[ProxyPool] ⚠️ Proxy ${proxy.id} failed (${proxy.fail_count}x): ${reason}`);

        if (proxy.fail_count >= MAX_FAIL_COUNT) {
            // Blacklist
            proxy.status = STATUS.BANNED;
            this.data.blacklisted_proxies.push({
                ...proxy,
                reason: `Failed ${MAX_FAIL_COUNT}x: ${reason}`,
                banned_at: new Date().toISOString(),
            });
            this.data.active_proxies = this.data.active_proxies.filter(p => p.id !== proxy.id);
            console.warn(`[ProxyPool] 🚫 Proxy ${proxy.id} blacklisted after ${MAX_FAIL_COUNT} failures`);
        } else {
            // Cooldown
            proxy.status = STATUS.COOLING;
            proxy.cooldown_until = new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000).toISOString();
            console.warn(`[ProxyPool] 🧊 Proxy ${proxy.id} cooling down for ${COOLDOWN_MINUTES}min`);
        }
    }

    // ═══════════════════════════════════════════════════
    // Health Check — Ping all proxies
    // ═══════════════════════════════════════════════════

    /**
     * Parse proxy URL into Playwright-compatible format
     * Input: "http://user:pass@host:port"
     * Output: { server, username, password }
     */
    static parseProxyUrl(proxyUrl) {
        try {
            const url = new URL(proxyUrl);
            return {
                server: `${url.protocol}//${url.hostname}:${url.port}`,
                username: decodeURIComponent(url.username),
                password: decodeURIComponent(url.password),
            };
        } catch {
            return { server: proxyUrl, username: '', password: '' };
        }
    }

    /**
     * Ping a single proxy and measure latency
     */
    async pingProxy(proxy) {
        const start = performance.now();

        try {
            const parsed = ProxyPool.parseProxyUrl(proxy.url);
            const axiosProxy = {};

            // Build axios proxy config
            const url = new URL(proxy.url);
            axiosProxy.host = url.hostname;
            axiosProxy.port = parseInt(url.port);
            if (url.username) {
                axiosProxy.auth = {
                    username: decodeURIComponent(url.username),
                    password: decodeURIComponent(url.password),
                };
            }
            axiosProxy.protocol = url.protocol.replace(':', '');

            await axios.get(PING_TARGET_URL, {
                proxy: axiosProxy,
                timeout: PING_TIMEOUT_MS,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
            });

            const latency = Math.round(performance.now() - start);
            return { alive: true, latency };
        } catch (err) {
            return { alive: false, latency: 9999, error: err.message };
        }
    }

    /**
     * Health check all active proxies
     * Updates latency, status, fail_count
     */
    async healthCheckAll() {
        if (!this.data) await this.load();

        const proxies = this.data.active_proxies;
        console.log(`[ProxyPool] 🏥 Health check: ${proxies.length} proxies...`);

        let alive = 0, dead = 0;

        for (const proxy of proxies) {
            const result = await this.pingProxy(proxy);

            if (result.alive) {
                proxy.latency = result.latency;
                proxy.status = STATUS.ACTIVE;
                proxy.fail_count = 0;
                proxy.last_checked = new Date().toISOString();
                alive++;

                const warn = result.latency > LATENCY_WARN_MS ? ' ⚠️ slow' : '';
                console.log(`[ProxyPool]   ✅ ${proxy.id} (${proxy.provider}): ${result.latency}ms${warn}`);
            } else {
                proxy.fail_count = (proxy.fail_count || 0) + 1;
                proxy.last_checked = new Date().toISOString();
                dead++;

                if (proxy.fail_count >= MAX_FAIL_COUNT) {
                    this.reportFailure(proxy, result.error || 'health check failed');
                } else {
                    proxy.status = STATUS.COOLING;
                    proxy.cooldown_until = new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000).toISOString();
                }
                console.log(`[ProxyPool]   ❌ ${proxy.id} (${proxy.provider}): ${result.error}`);
            }
        }

        await this.save();
        console.log(`[ProxyPool] 🏥 Health check done: ${alive} alive, ${dead} dead, ${this.getActiveCount()} available`);
        return { alive, dead, total: proxies.length };
    }

    // ═══════════════════════════════════════════════════
    // Add / Remove proxies
    // ═══════════════════════════════════════════════════

    addProxy({ url, provider = 'manual', type = 'residential', region = 'US' }) {
        if (!this.data) return;
        const id = `px_${String(this.data.active_proxies.length + 1).padStart(3, '0')}`;
        const proxy = {
            id, provider, url, type, region,
            latency: null, fail_count: 0, success_count: 0,
            last_used: null, last_checked: null,
            status: STATUS.UNCHECKED, cooldown_until: null,
        };
        this.data.active_proxies.push(proxy);
        console.log(`[ProxyPool] ➕ Added proxy ${id} (${provider}, ${region})`);
        return proxy;
    }

    /**
     * Bulk add proxies from array of URLs
     */
    addBulk(urls, provider = 'manual', region = 'US') {
        for (const url of urls) {
            this.addProxy({ url, provider, region });
        }
        console.log(`[ProxyPool] ➕ Bulk added ${urls.length} proxies`);
    }

    getStats() {
        if (!this.data) return {};
        const active = this.data.active_proxies;
        return {
            total: active.length,
            active: active.filter(p => p.status === STATUS.ACTIVE).length,
            cooling: active.filter(p => p.status === STATUS.COOLING).length,
            unchecked: active.filter(p => p.status === STATUS.UNCHECKED).length,
            blacklisted: (this.data.blacklisted_proxies || []).length,
            avgLatency: Math.round(
                active.filter(p => p.latency && p.latency < 9999)
                    .reduce((sum, p) => sum + p.latency, 0) /
                (active.filter(p => p.latency && p.latency < 9999).length || 1)
            ),
        };
    }
}

// Singleton instance
const pool = new ProxyPool();

module.exports = { ProxyPool, pool, STATUS, PROXIES_PATH };
