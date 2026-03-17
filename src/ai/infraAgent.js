/**
 * THG Multi-Agent System — Infrastructure Agent
 * 
 * Agent 1: Điều phối hạ tầng — Proxy, Browser Pool, Fingerprint
 * 
 * Responsibilities:
 * - Manage proxy pool (load, health check, rotation)
 * - Provide browser contexts with proxy + fingerprint
 * - Monitor rate limits and auto-recover
 * - Periodic health checks (hourly)
 * 
 * @module agents/infraAgent
 */

const { pool } = require('../infra/proxy/proxyPool');
const { generateFingerprint, toPlaywrightContext, toAxiosHeaders } = require('../infra/proxy/fingerprint');

// Optional: Playwright (only loaded if installed)
let playwright = null;
try {
    playwright = require('playwright');
} catch {
    // Playwright not installed — agent works without it (Axios-only mode)
}

// ═══════════════════════════════════════════════════════
// Browser Pool settings
// ═══════════════════════════════════════════════════════
const MAX_BROWSERS = 2;                // Max concurrent browsers
const BROWSER_LIFETIME_MS = 30 * 60 * 1000; // Restart browsers every 30 min
const HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

class InfraAgent {
    constructor() {
        this.browsers = [];        // Active browser instances
        this.initialized = false;
        this.healthTimer = null;
        this.stats = {
            browsersCreated: 0,
            contextsIssued: 0,
            proxyRotations: 0,
            healthChecks: 0,
        };
    }

    // ═══════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════

    async init() {
        console.log('[InfraAgent] 🔧 Initializing Infrastructure Agent...');

        // Load proxy pool
        await pool.load();
        const stats = pool.getStats();
        console.log(`[InfraAgent] 📡 Proxies: ${stats.total} total, ${stats.active} active, ${stats.blacklisted} blacklisted`);

        // Run initial health check if proxies exist
        if (pool.hasProxies()) {
            console.log('[InfraAgent] 🏥 Running initial proxy health check...');
            await pool.healthCheckAll();
        }

        // Start periodic health check
        this.healthTimer = setInterval(async () => {
            console.log('[InfraAgent] 🏥 Periodic proxy health check...');
            await pool.healthCheckAll();
            this.stats.healthChecks++;
        }, HEALTH_CHECK_INTERVAL_MS);

        this.initialized = true;
        console.log('[InfraAgent] ✅ Infrastructure Agent ready');
        if (!playwright) {
            console.log('[InfraAgent] ℹ️ Playwright not installed — running in Axios-only mode');
            console.log('[InfraAgent] ℹ️ Install with: npm i playwright');
        }

        return this;
    }

    // ═══════════════════════════════════════════════════
    // Get scraping context (proxy + fingerprint)
    // ═══════════════════════════════════════════════════

    /**
     * Get a configured scraping context.
     * Returns proxy + fingerprint + headers ready for use.
     * 
     * @param {Object} [options]
     * @param {string} [options.region] - Preferred proxy region ('US', 'VN')
     * @param {string} [options.target] - Target platform ('facebook', 'tiktok', 'instagram')
     * @returns {Object} { proxy, fingerprint, headers, playwrightConfig }
     */
    getScrapingContext(options = {}) {
        const fingerprint = generateFingerprint({ region: options.region || 'US' });
        const headers = toAxiosHeaders(fingerprint);

        // Get proxy (if available)
        let proxy = null;
        let proxyUrl = null;
        if (pool.hasProxies()) {
            const best = pool.getBestProxy(options.region);
            if (best) {
                proxy = best.proxy;
                proxyUrl = best.proxyUrl;
                this.stats.proxyRotations++;
            }
        }

        this.stats.contextsIssued++;

        return {
            proxy,
            proxyUrl,
            fingerprint,
            headers,
            playwrightConfig: proxy ? {
                ...toPlaywrightContext(fingerprint),
                proxy: proxyUrl ? require('../infra/proxy/proxyPool').ProxyPool.parseProxyUrl(proxyUrl) : undefined,
            } : toPlaywrightContext(fingerprint),
        };
    }

    // ═══════════════════════════════════════════════════
    // Browser Pool (Playwright)
    // ═══════════════════════════════════════════════════

    /**
     * Get a Playwright browser instance with proxy + fingerprint.
     * Creates a new browser context for each scraping session.
     * 
     * @param {Object} [options]
     * @param {string} [options.region] - Preferred proxy region
     * @returns {{ browser, page, context, proxy, fingerprint, close: Function }}
     */
    async getBrowserSession(options = {}) {
        if (!playwright) {
            throw new Error('[InfraAgent] Playwright not installed. Run: npm i playwright');
        }

        const ctx = this.getScrapingContext(options);

        // Launch browser with proxy
        const launchOptions = {
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        };
        if (ctx.proxyUrl) {
            launchOptions.proxy = require('../infra/proxy/proxyPool').ProxyPool.parseProxyUrl(ctx.proxyUrl);
        }

        const browser = await playwright.chromium.launch(launchOptions);
        const context = await browser.newContext(ctx.playwrightConfig);
        const page = await context.newPage();

        this.stats.browsersCreated++;

        // Return session with cleanup function
        return {
            browser,
            context,
            page,
            proxy: ctx.proxy,
            fingerprint: ctx.fingerprint,
            close: async () => {
                try {
                    await page.close();
                    await context.close();
                    await browser.close();
                } catch (e) { /* ignore cleanup errors */ }
            },
            // Report result back to proxy pool
            reportSuccess: () => {
                if (ctx.proxy) pool.reportSuccess(ctx.proxy);
            },
            reportFailure: (reason) => {
                if (ctx.proxy) pool.reportFailure(ctx.proxy, reason);
            },
        };
    }

    // ═══════════════════════════════════════════════════
    // Proxy management API (for dashboard/config)
    // ═══════════════════════════════════════════════════

    async addProxies(urls, provider = 'manual', region = 'US') {
        if (!pool.loaded) await pool.load();
        pool.addBulk(urls, provider, region);
        await pool.save();
        console.log(`[InfraAgent] ➕ Added ${urls.length} proxies (${provider}, ${region})`);
    }

    async runHealthCheck() {
        if (!pool.loaded) await pool.load();
        return pool.healthCheckAll();
    }

    getProxyStats() {
        return {
            ...pool.getStats(),
            agent: this.stats,
        };
    }

    // ═══════════════════════════════════════════════════
    // Cleanup
    // ═══════════════════════════════════════════════════

    async shutdown() {
        console.log('[InfraAgent] 🛑 Shutting down...');
        if (this.healthTimer) clearInterval(this.healthTimer);

        // Close all browsers
        for (const browser of this.browsers) {
            try { await browser.close(); } catch { }
        }
        this.browsers = [];

        // Save proxy state
        if (pool.loaded) await pool.save();
        console.log('[InfraAgent] ✅ Shutdown complete');
    }
}

// Singleton
const infraAgent = new InfraAgent();

module.exports = { InfraAgent, infraAgent };
