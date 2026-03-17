const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const dataDir = "C:\\Users\\ACER\\AppData\\Local\\Google\\Chrome\\User Data"; // typical path, but we'll use empty or logged out
    // just scrape public group
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://www.facebook.com/groups/shopifydevelopervn?sorting_setting=CHRONOLOGICAL", { waitUntil: "domcontentloaded" });

    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
    } catch (e) { }

    const html = await page.evaluate(() => {
        const units = document.querySelectorAll('div[role="feed"] > div');
        const logs = [];
        for (const u of units) {
            const links = u.querySelectorAll('a');
            for (const a of links) {
                if (a.innerText.trim()) {
                    logs.push({ text: a.innerText.trim(), href: a.href });
                }
            }
        }
        return logs;
    });

    console.log(JSON.stringify(html, null, 2));
    await browser.close();
})();
