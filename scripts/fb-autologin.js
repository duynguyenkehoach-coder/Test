/**
 * fb-autologin.js — Auto login Facebook với email/pass từ .env
 * Lưu cookie session vào data/fb_sessions/ để scraper dùng lại
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

const FB_EMAIL = process.env.FB_EMAIL;
const FB_PASSWORD = process.env.FB_PASSWORD;
const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'fb_sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, `${FB_EMAIL.replace(/[@.]/g, '_')}.json`);

async function delay(ms) { return new Promise(r => setTimeout(r, ms + Math.random() * 500)); }

async function main() {
    if (!FB_EMAIL || !FB_PASSWORD) {
        console.error('❌ FB_EMAIL và FB_PASSWORD chưa được set trong .env');
        process.exit(1);
    }

    console.log(`\n🔐 Auto-login: ${FB_EMAIL}`);
    console.log(`📁 Session sẽ lưu vào: ${SESSION_FILE}\n`);

    const browser = await chromium.launch({ headless: false, slowMo: 50 });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    const page = await context.newPage();

    try {
        await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(2000);

        // Fill email
        await page.fill('input[name="email"], input#email', FB_EMAIL);
        await delay(800);

        // Fill password
        await page.fill('input[name="pass"], input#pass', FB_PASSWORD);
        await delay(800);

        // Submit
        await page.keyboard.press('Enter');
        console.log('⏳ Chờ phản hồi từ Facebook...');
        await delay(8000);

        const url = page.url();
        console.log(`📍 URL sau login: ${url}`);

        if (url.includes('checkpoint') || url.includes('two_step')) {
            console.log('\n⚠️ Facebook yêu cầu xác minh (2FA/Checkpoint)!');
            console.log('💡 Hãy xác minh trên browser đang mở, sau đó tôi sẽ lưu session...');

            // Wait for user to approve on phone / complete verification
            await page.waitForURL(url => {
                const s = url.toString();
                return !s.includes('checkpoint') && !s.includes('two_step') && !s.includes('login');
            }, { timeout: 120000 });
            console.log('✅ Xác minh thành công!');
        }

        if (url.includes('/login')) {
            console.error('\n❌ Login thất bại — kiểm tra lại email/password hoặc giải CAPTCHA trên browser');
            await delay(30000); // Give time to see the browser
            await browser.close();
            process.exit(1);
        }

        // Save cookies
        const cookies = await context.cookies();
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
        console.log(`\n✅ Session saved! (${cookies.length} cookies)`);
        console.log(`📁 ${SESSION_FILE}`);
        console.log('\n🚀 Chạy "task" để restart server và bắt đầu scraping!\n');

    } catch (err) {
        console.error('❌ Error:', err.message);
    }

    await browser.close();
    process.exit(0);
}

main();
