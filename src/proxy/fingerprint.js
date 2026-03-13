/**
 * THG Multi-Agent System — Browser Fingerprint Rotation
 * 
 * Generates realistic browser fingerprints to avoid detection.
 * Each scraping session gets a unique combination of:
 * - User-Agent
 * - Viewport size
 * - Timezone
 * - Language
 * - Platform
 * 
 * @module proxy/fingerprint
 */

// ═══════════════════════════════════════════════════════
// Pre-built fingerprint pool (no external dependency needed)
// These mimic real Chrome/Firefox on Windows/Mac
// ═══════════════════════════════════════════════════════

const USER_AGENTS = [
    // Chrome on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    // Chrome on Mac
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    // Firefox on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    // Edge
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    // Safari on Mac
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

const VIEWPORTS = [
    { width: 1920, height: 1080 },  // Full HD
    { width: 1536, height: 864 },   // Laptop
    { width: 1440, height: 900 },   // MacBook
    { width: 1366, height: 768 },   // Common laptop
    { width: 1280, height: 720 },   // HD
    { width: 2560, height: 1440 },  // QHD
    { width: 1680, height: 1050 },  // MacBook Pro
];

const TIMEZONES = [
    'America/New_York',      // US East (kho PA)
    'America/Chicago',       // US Central
    'America/Denver',        // US Mountain
    'America/Los_Angeles',   // US West
    'America/Houston',       // US Texas (kho TX)
    'Asia/Ho_Chi_Minh',      // VN
    'Asia/Bangkok',          // Thailand
];

const LANGUAGES = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,vi;q=0.8',
    'vi-VN,vi;q=0.9,en;q=0.8',
    'en-GB,en;q=0.9',
    'en-US,en;q=0.9,zh;q=0.8',
];

const PLATFORMS = [
    'Win32',
    'MacIntel',
];

// ═══════════════════════════════════════════════════════
// Random helpers
// ═══════════════════════════════════════════════════════

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Deterministic hash for account-based fingerprint consistency
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = Math.abs(hash | 0);
    }
    return hash;
}

// ═══════════════════════════════════════════════════════
// Generate fingerprint
// ═══════════════════════════════════════════════════════

/**
 * Generate a browser fingerprint for a scraping session.
 * When accountId is provided, generates DETERMINISTIC fingerprint (same every time for same account).
 * Without accountId, generates random fingerprint.
 * 
 * @param {Object} [options]
 * @param {string} [options.region] - Target region ('US' or 'VN')
 * @param {string} [options.accountId] - Account email for deterministic fingerprint
 * @returns {Object} Fingerprint with userAgent, viewport, timezone, etc.
 */
function generateFingerprint(options = {}) {
    // Deterministic hash for account-based fingerprint
    const pick = options.accountId
        ? (arr) => arr[simpleHash(options.accountId) % arr.length]
        : randomItem;

    const userAgent = pick(USER_AGENTS);
    const viewport = pick(VIEWPORTS);

    // Match timezone to region
    let timezone;
    if (options.region === 'US') {
        timezone = pick(TIMEZONES.filter(tz => tz.startsWith('America/')));
    } else if (options.region === 'VN') {
        timezone = 'Asia/Ho_Chi_Minh';
    } else {
        timezone = pick(TIMEZONES);
    }

    // Match language to region
    let language;
    if (options.region === 'VN') {
        language = 'vi-VN,vi;q=0.9,en;q=0.8';
    } else {
        language = pick(LANGUAGES);
    }

    // Platform based on user agent
    const platform = userAgent.includes('Mac') ? 'MacIntel' : 'Win32';

    return {
        userAgent,
        viewport,
        timezone,
        language,
        platform,
        // Screen dimensions (slightly larger than viewport)
        screen: {
            width: viewport.width + randomInt(0, 200),
            height: viewport.height + randomInt(80, 200),
        },
        // Color depth
        colorDepth: randomItem([24, 32]),
        // WebGL renderer (randomized)
        webGLRenderer: randomItem([
            'ANGLE (Intel HD Graphics 630)',
            'ANGLE (NVIDIA GeForce GTX 1060)',
            'ANGLE (AMD Radeon RX 580)',
            'Apple GPU',
            'ANGLE (Intel UHD Graphics 620)',
        ]),
    };
}

/**
 * Apply fingerprint to Playwright browser context options.
 * @param {Object} fingerprint - Generated fingerprint
 * @returns {Object} Playwright-compatible context options
 */
function toPlaywrightContext(fingerprint) {
    return {
        userAgent: fingerprint.userAgent,
        viewport: fingerprint.viewport,
        locale: fingerprint.language.split(',')[0],
        timezoneId: fingerprint.timezone,
        // Extra headers
        extraHTTPHeaders: {
            'Accept-Language': fingerprint.language,
            'sec-ch-ua-platform': `"${fingerprint.platform === 'Win32' ? 'Windows' : 'macOS'}"`,
        },
    };
}

/**
 * Apply fingerprint to Axios request headers.
 * @param {Object} fingerprint - Generated fingerprint
 * @returns {Object} Headers object for Axios
 */
function toAxiosHeaders(fingerprint) {
    return {
        'User-Agent': fingerprint.userAgent,
        'Accept-Language': fingerprint.language,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'sec-ch-ua-platform': `"${fingerprint.platform === 'Win32' ? 'Windows' : 'macOS'}"`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
    };
}

module.exports = {
    generateFingerprint,
    toPlaywrightContext,
    toAxiosHeaders,
    USER_AGENTS,
    VIEWPORTS,
    TIMEZONES,
};
