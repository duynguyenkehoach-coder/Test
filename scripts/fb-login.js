/**
 * fb-login.js — One-time Facebook manual login
 * 
 * Opens a visible browser window → you login manually → press Enter → session saved.
 * Session persists for weeks/months in data/fb_browser_profile/
 * 
 * Usage: task fb:login   (or: node scripts/fb-login.js)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const readline = require('readline');

chromium.use(StealthPlugin());

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'fb_browser_profile');

async function main() {
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║  🔐 THG — Facebook One-Time Login          ║');
    console.log('║  Session saved → reused for months         ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log(`📁 Profile dir: ${PROFILE_DIR}`);
    console.log('🌐 Opening browser...Đăng nhập Facebook rồi nhấn Enter\n');

    const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const page = browser.pages()[0] || await browser.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

    // Wait for user to login manually
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => {
        rl.question('\n✅ Đã đăng nhập xong? Nhấn Enter để lưu session...', () => {
            rl.close();
            resolve();
        });
    });

    // Check login status
    const url = page.url();
    const title = await page.title();
    if (url.includes('login') || url.includes('checkpoint')) {
        console.log(`\n❌ Chưa đăng nhập được (URL: ${url}). Thử lại nhé.`);
    } else {
        console.log(`\n✅ Session saved! (${title})`);
        console.log(`📁 Saved to: ${PROFILE_DIR}`);
        console.log('🚀 Giờ chạy "task" để start server và scraper sẽ dùng session này.\n');
    }

    await browser.close();
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
