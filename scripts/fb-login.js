#!/usr/bin/env node
/**
 * fb-login.js — One-time login to Facebook on VPS IP
 * 
 * Creates a storageState auth file (cookies + localStorage) that lives 15-30 days.
 * Much more stable than cookie-only export because:
 * 1. Session is created from the VPS IP itself (no IP mismatch)
 * 2. Includes localStorage tokens that Facebook uses for session persistence
 * 3. After login, the scraper auto-renews this auth file every scan cycle
 * 
 * Usage:
 *   node scripts/fb-login.js <email> <password> <account_name>
 *   node scripts/fb-login.js manyhope0502@gmail.com MyP@ss manyhope0502
 * 
 * Output: data/sessions/<account_name>_auth.json
 * 
 * If Facebook triggers 2FA/checkpoint, the script will:
 * 1. Save a screenshot to data/sessions/<account_name>_checkpoint.png
 * 2. Prompt you to enter the code from terminal (if possible)
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

chromium.use(StealthPlugin());

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');

async function askQuestion(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(prompt, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function loginAndSave(email, password, accName) {
    console.log(`\n🚀 Facebook Login — ${email}`);
    console.log(`   Saving to: ${SESSIONS_DIR}/${accName}_auth.json\n`);

    fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    const page = await context.newPage();

    try {
        // Step 1: Navigate to Facebook
        console.log('📡 Navigating to facebook.com...');
        await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Step 2: Fill login form
        console.log('📝 Filling login form...');
        const emailInput = await page.$('input[name="email"]');
        const passInput = await page.$('input[name="pass"]');

        if (!emailInput || !passInput) {
            // Maybe already logged in?
            const url = page.url();
            if (!url.includes('/login') && !url.includes('checkpoint')) {
                console.log('✅ Already logged in! Saving session...');
                const authPath = path.join(SESSIONS_DIR, `${accName}_auth.json`);
                await context.storageState({ path: authPath });
                console.log(`\n✅ Auth saved to: ${authPath}`);
                await browser.close();
                return;
            }
            throw new Error('Cannot find login form');
        }

        await emailInput.fill(email);
        await page.waitForTimeout(500 + Math.random() * 1000);
        await passInput.fill(password);
        await page.waitForTimeout(500 + Math.random() * 500);

        console.log('🔐 Submitting login...');
        // Try multiple login button selectors (Facebook changes these)
        const loginSelectors = [
            'button[name="login"]',
            'button[data-loginbutton="true"]',
            'button[type="submit"]',
            '#loginbutton',
            'input[type="submit"]',
        ];
        let clicked = false;
        for (const sel of loginSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click({ timeout: 5000 });
                    clicked = true;
                    console.log(`   ✓ Clicked: ${sel}`);
                    break;
                }
            } catch { }
        }
        if (!clicked) {
            // Ultimate fallback: press Enter on password field
            console.log('   ⚡ Pressing Enter to submit...');
            await passInput.press('Enter');
        }

        // Step 3: Wait for redirect
        console.log('⏳ Waiting for login result (30s)...');
        await page.waitForTimeout(8000);

        // Step 4: Check for 2FA / Checkpoint
        const currentUrl = page.url();

        if (currentUrl.includes('checkpoint') || currentUrl.includes('two_step')) {
            console.log('\n⚠️  2FA/Checkpoint detected!');
            const ssPath = path.join(SESSIONS_DIR, `${accName}_checkpoint.png`);
            await page.screenshot({ path: ssPath, fullPage: true });
            console.log(`📸 Screenshot saved to: ${ssPath}`);

            // Try to detect what type of checkpoint
            const pageContent = await page.textContent('body');

            if (pageContent.includes('code') || pageContent.includes('mã') ||
                pageContent.includes('SMS') || pageContent.includes('authenticator')) {
                console.log('\n🔢 Facebook is asking for a verification code.');
                const code = await askQuestion('Enter 2FA code (or press Enter to skip): ');

                if (code) {
                    const codeInput = await page.$('input[name="approvals_code"]') ||
                        await page.$('input[type="text"]') ||
                        await page.$('input[type="tel"]');
                    if (codeInput) {
                        await codeInput.fill(code);
                        await page.waitForTimeout(500);

                        // Click submit/continue button
                        const submitBtn = await page.$('button[type="submit"]') ||
                            await page.$('button:has-text("Continue")') ||
                            await page.$('button:has-text("Submit")');
                        if (submitBtn) await submitBtn.click();

                        console.log('⏳ Waiting after 2FA...');
                        await page.waitForTimeout(10000);

                        // Check "Remember browser" checkbox if present
                        const rememberBtn = await page.$('button:has-text("Remember")') ||
                            await page.$('button:has-text("Nhớ trình duyệt")') ||
                            await page.$('button:has-text("Save browser")');
                        if (rememberBtn) {
                            await rememberBtn.click();
                            await page.waitForTimeout(5000);
                            console.log('✅ Browser remembered!');
                        }
                    }
                } else {
                    console.log('⏩ Skipped 2FA. Login incomplete.');
                    await browser.close();
                    return;
                }
            } else {
                console.log('❌ Unknown checkpoint type. Check the screenshot.');
                console.log(`   View: ${ssPath}`);
                await browser.close();
                return;
            }
        }

        // Step 5: Verify login success
        await page.waitForTimeout(3000);
        const finalUrl = page.url();
        const hasNav = await page.$('div[role="navigation"], div[aria-label="Facebook"]');

        if (hasNav && !finalUrl.includes('/login') && !finalUrl.includes('checkpoint')) {
            // ✅ SUCCESS — Save storageState
            const authPath = path.join(SESSIONS_DIR, `${accName}_auth.json`);
            await context.storageState({ path: authPath });

            console.log(`\n${'═'.repeat(50)}`);
            console.log(`✅ LOGIN SUCCESS — ${email}`);
            console.log(`📂 Auth file: ${authPath}`);
            console.log(`🔑 Session will last 15-30 days if browser is remembered`);
            console.log(`${'═'.repeat(50)}\n`);
        } else {
            // ❌ FAILED
            const ssPath = path.join(SESSIONS_DIR, `${accName}_failed.png`);
            await page.screenshot({ path: ssPath, fullPage: true });
            console.log(`\n❌ Login failed for ${email}`);
            console.log(`📸 Screenshot: ${ssPath}`);
            console.log(`Final URL: ${finalUrl}`);
        }

    } catch (err) {
        console.error(`\n❌ Error: ${err.message}`);
        try {
            const ssPath = path.join(SESSIONS_DIR, `${accName}_error.png`);
            await page.screenshot({ path: ssPath });
            console.log(`📸 Error screenshot: ${ssPath}`);
        } catch { }
    } finally {
        await browser.close();
    }
}

// ── CLI ──
const [, , email, password, accName] = process.argv;

if (!email || !password || !accName) {
    console.log(`
╔══════════════════════════════════════════════════╗
║  fb-login.js — Facebook Login for THG Scraper    ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Usage:                                          ║
║    node scripts/fb-login.js <email> <pass> <name>║
║                                                  ║
║  Example:                                        ║
║    node scripts/fb-login.js \\                    ║
║      manyhope0502@gmail.com MyP@ss manyhope0502  ║
║                                                  ║
║  Output:                                         ║
║    data/sessions/<name>_auth.json                ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);
    process.exit(1);
}

loginAndSave(email, password, accName);
