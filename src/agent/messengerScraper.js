/**
 * Messenger Auto-Scraper (CrawBot Messenger Agent) v1.0
 *
 * Tự động đăng nhập vào tài khoản Facebook của từng Sales,
 * đọc lịch sử Messenger, trích xuất tin nhắn Sales đã gửi,
 * và nạp vào chat_history để PersonalAgent học văn phong.
 *
 * Flow:
 *   Sales FB Account (fb_accounts với sales_name)
 *     └── Playwright → facebook.com/messages/
 *         ├── Liệt kê các cuộc hội thoại gần đây
 *         ├── Lấy tin nhắn Sales đã gửi (phân biệt hướng gửi)
 *         └── → database.logChatMessage (chat_history)
 *               └── styleExtractor.extractStyleForAgent (auto-learn)
 *
 * QUAN TRỌNG:
 * - Chỉ đọc, KHÔNG gửi tin nhắn
 * - Chỉ lấy tin nhắn đã gửi của Sales (direction = 'sales')
 * - Tránh trùng lặp bằng cách kiểm tra nội dung đã học chưa
 */

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const accountManager = require('./accountManager');
const database = require('../data_store/database');

chromium.use(StealthPlugin());

const delay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * ms * 0.3));
const FB_URL = 'https://www.facebook.com';
const MESSAGES_URL = `${FB_URL}/messages/t/`;

// Số cuộc hội thoại tối đa để quét mỗi lần
const MAX_CONVERSATIONS = 15;
// Số tin nhắn tối đa lấy từ mỗi cuộc hội thoại
const MAX_MESSAGES_PER_CONV = 30;

// ─── Bộ lọc tin nhắn: chỉ lấy câu hay, có giá trị học ───────────────────
const MIN_MSG_LENGTH = 15;   // bỏ câu quá ngắn
const MAX_MSG_LENGTH = 500;  // bỏ đoạn văn dài (thường là copy-paste)

// Các cụm từ không nên học (lỗi, cáu gắt, lời cảm ơn vu vơ...)
const EXCLUDE_PATTERNS = [
    /^ok+\.?$/i,
    /^ok bạn$/i,
    /^đúng rồi$/i,
    /^vâng$/i,
    /^dạ$/i,
    /^😊+$/,
    /error/i,
    /lỗi/i,
    /thử lại/i,
];

function isGoodMessage(text) {
    if (text.length < MIN_MSG_LENGTH || text.length > MAX_MSG_LENGTH) return false;
    return !EXCLUDE_PATTERNS.some(p => p.test(text.trim()));
}

// ─── Playwright: Đăng nhập và scrape Messenger ───────────────────────────

/**
 * Mở browser với session của account đã đăng nhập
 */
async function createAuthBrowser(account) {
    const sessionPath = accountManager.getSessionPath(account);

    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'vi-VN',
    });

    // Block media/images (không cần cho text scraping)
    await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
        return route.continue();
    });

    // Load saved session nếu có
    if (fs.existsSync(sessionPath)) {
        const cookies = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        await context.addCookies(cookies);
        console.log(`[MessengerScraper] 🍪 Loaded session: ${account.email}`);
    }

    return { browser, context };
}

/**
 * Kiểm tra session có còn valid không (không bị redirect về login)
 */
async function verifySession(page, account) {
    await page.goto(`${FB_URL}/messages/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    await delay(4000);

    const url = page.url();
    if (url.includes('/login') || url.includes('checkpoint')) {
        if (url.includes('checkpoint')) {
            console.log(`[MessengerScraper] 🚨 CHECKPOINT: ${account.email}`);
            accountManager.reportCheckpoint(account.id);
        } else {
            console.log(`[MessengerScraper] 🔒 Session expired: ${account.email}`);
        }
        return false;
    }

    console.log(`[MessengerScraper] ✅ Session valid: ${account.email}`);
    return true;
}

/**
 * Lấy danh sách conversation threads từ Messenger
 * @param {Page} page
 * @returns {string[]} array of conversation URLs
 */
async function getConversationList(page) {
    try {
        await page.goto(`${FB_URL}/messages/`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await delay(3000);

        // Chờ sidebar conversations load
        await page.waitForSelector('[role="navigation"] a[href*="/messages/t/"], a[href*="/messages/t/"]', {
            timeout: 10000,
        }).catch(() => { });

        const convUrls = await page.$$eval(
            'a[href*="/messages/t/"]',
            (links) => [...new Set(links.map(a => a.href))].filter(h => h.includes('/messages/t/')).slice(0, 20)
        );

        console.log(`[MessengerScraper] 📋 Tìm thấy ${convUrls.length} conversations`);
        return convUrls.slice(0, MAX_CONVERSATIONS);
    } catch (err) {
        console.error(`[MessengerScraper] ❌ getConversationList: ${err.message}`);
        return [];
    }
}

/**
 * Lấy tin nhắn từ một cuộc hội thoại.
 * Phân biệt tin nhắn của Sales (sent) vs Khách (received).
 * @param {Page} page - Playwright page  
 * @param {string} convUrl - conversation URL
 * @param {string} salesName - tên sales để log
 * @returns {{ sent: string[], received: string[] }}
 */
async function scrapeConversation(page, convUrl, salesName) {
    try {
        await page.goto(convUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(3000);

        // Scroll lên để tải thêm tin nhắn cũ
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => {
                const list = document.querySelector('[role="main"] [role="list"], [role="log"]');
                if (list) list.scrollTop = 0;
            });
            await delay(1200);
        }

        const messages = await page.evaluate((maxMsgs) => {
            const sent = [];
            const received = [];

            // Messenger message bubbles:
            // - Your messages (sent): thường có class/attribute outgoing, hoặc align right
            // - Messages from others: align left
            // Facebook dùng div[dir="auto"] trong message rows

            // Strategy: tìm tất cả message row, phân biệt bằng position/alignment
            const allRows = document.querySelectorAll(
                '[role="row"], [role="listitem"], .x78zum5.xdt5ytf'
            );

            for (const row of allRows) {
                const textEls = row.querySelectorAll('div[dir="auto"]');
                let text = '';
                for (const el of textEls) {
                    const t = (el.innerText || '').trim();
                    if (t.length > text.length) text = t;
                }
                if (!text || text.length < 5) continue;

                // Facebook Messenger: outgoing messages thường có justify-content flex-end
                // hoặc có data attribute chỉ "outgoing"
                const style = row.getAttribute('style') || '';
                const className = row.className || '';
                const isOutgoing =
                    row.querySelector('[data-scope="sent_message"]') !== null ||
                    className.includes('x1hc1fzr') || // known FB outgoing class (may change)
                    row.querySelector('div[data-lexical-editor]') !== null || // input area (skip)
                    style.includes('justify-content: flex-end') ||
                    // Check if bubble is right-aligned (outgoing)
                    (() => {
                        const bubble = row.querySelector('div[class*="x1hl2dhg"], div[class*="xuk3077"]');
                        if (!bubble) return false;
                        const bs = window.getComputedStyle(bubble);
                        return bs.marginLeft === 'auto' || bs.justifyContent === 'flex-end';
                    })();

                // Fallback: if can't determine direction, skip
                if (isOutgoing) {
                    sent.push(text);
                } else {
                    received.push(text);
                }

                if (sent.length + received.length >= maxMsgs) break;
            }

            // Extra fallback: Search by aria patterns
            if (sent.length === 0) {
                // Try data-testid="outgoing_bubble" or similar
                const outgoing = document.querySelectorAll(
                    '[data-scope="sent_message"] div[dir="auto"], ' +
                    '.message-group--outgoing div[dir="auto"], ' +
                    '[class*="outgoing"] div[dir="auto"]'
                );
                for (const el of outgoing) {
                    const t = (el.innerText || '').trim();
                    if (t.length >= 5) sent.push(t);
                    if (sent.length >= maxMsgs) break;
                }
            }

            return { sent: [...new Set(sent)], received: [...new Set(received)] };
        }, MAX_MESSAGES_PER_CONV);

        console.log(`[MessengerScraper] 💬 ${convUrl.slice(-20)}: ${messages.sent.length} sent, ${messages.received.length} received`);
        return messages;

    } catch (err) {
        console.error(`[MessengerScraper] ❌ scrapeConversation: ${err.message}`);
        return { sent: [], received: [] };
    }
}

// ─── Main: Scrape Messenger của một Sales ────────────────────────────────

/**
 * Scrape Messenger của một Sales và nạp vào chat_history.
 * Tự động trigger styleExtractor sau khi xong.
 *
 * @param {string} salesName - 'Trang' | 'Moon' | 'Min' | etc.
 * @param {object} [opts]
 * @param {boolean} [opts.autoExtract] - Tự động chạy style extraction sau khi scrape
 * @param {number}  [opts.maxConversations] - Số conversation tối đa
 * @returns {object} stats
 */
async function scrapeMessengerForSales(salesName, opts = {}) {
    const { autoExtract = true, maxConversations = MAX_CONVERSATIONS } = opts;

    console.log(`\n[MessengerScraper] 🚀 Bắt đầu học từ Messenger của ${salesName}...`);

    // Tìm account FB của Sales này
    const account = accountManager.getAccountBySalesName(salesName);
    if (!account) {
        const msg = `Chưa có tài khoản FB nào được liên kết với "${salesName}". Dùng linkAccountToSales() để liên kết.`;
        console.error(`[MessengerScraper] ❌ ${msg}`);
        return { success: false, error: msg };
    }

    console.log(`[MessengerScraper] 👤 Dùng account: ${account.email}`);

    let browser, context, page;
    const stats = { salesName, learned: 0, conversations: 0, skipped: 0 };

    try {
        ({ browser, context } = await createAuthBrowser(account));
        page = await context.newPage();

        // Kiểm tra session
        const sessionValid = await verifySession(page, account);
        if (!sessionValid) {
            stats.error = 'Session không hợp lệ — cần login lại';
            return { success: false, ...stats };
        }

        // Lấy danh sách conversation
        const convUrls = await getConversationList(page);
        if (convUrls.length === 0) {
            stats.error = 'Không tìm thấy conversation nào';
            return { success: false, ...stats };
        }

        // Lấy tin nhắn đã học từ trước để tránh trùng lặp
        const existingChats = database.getRecentChats(salesName, 500).map(c => c.message);
        const existingSet = new Set(existingChats.map(m => m.trim().substring(0, 80)));

        // Scrape từng conversation
        for (const convUrl of convUrls.slice(0, maxConversations)) {
            const { sent, received } = await scrapeConversation(page, convUrl, salesName);
            stats.conversations++;

            let learnedThisConv = 0;

            // Nạp tin nhắn đã gửi của Sales vào chat_history
            for (const msg of sent) {
                const key = msg.trim().substring(0, 80);
                if (existingSet.has(key)) { stats.skipped++; continue; }
                if (!isGoodMessage(msg)) { stats.skipped++; continue; }

                database.logChatMessage(salesName, 0, 'sales', msg, 0);
                existingSet.add(key);
                stats.learned++;
                learnedThisConv++;
            }

            // Cũng lưu tin nhắn của khách (context) — giúp Agent hiểu ngữ cảnh
            for (const msg of received.slice(0, 10)) {
                if (msg.length < 5) continue;
                database.logChatMessage(salesName, 0, 'customer', msg, 0);
            }

            if (learnedThisConv > 0) {
                console.log(`[MessengerScraper] ✅ +${learnedThisConv} mẫu từ conversation`);
            }

            await delay(1500); // human-like delay giữa các conversations
        }

        console.log(`\n[MessengerScraper] 📊 ${salesName}: ${stats.learned} mẫu học được, ${stats.conversations} cuộc trò chuyện`);
        accountManager.reportSuccess(account.id, stats.learned);

        // Tự động chạy style extraction
        if (autoExtract && stats.learned > 0) {
            console.log(`[MessengerScraper] 🔬 Auto-triggering style extraction cho ${salesName}...`);
            try {
                const { extractStyleForAgent } = require('./styleExtractor');
                const result = await extractStyleForAgent(salesName);
                stats.styleExtracted = true;
                stats.sampleCount = result.sampleCount;
                console.log(`[MessengerScraper] 🎯 Style extraction hoàn tất: ${result.sampleCount} mẫu`);
            } catch (err) {
                console.error(`[MessengerScraper] ⚠️ Style extraction failed: ${err.message}`);
            }
        }

        return { success: true, ...stats };

    } catch (err) {
        console.error(`[MessengerScraper] ❌ Fatal error: ${err.message}`);
        if (account) accountManager.reportCheckpoint(account.id);
        return { success: false, error: err.message, ...stats };
    } finally {
        if (browser) await browser.close().catch(() => { });
    }
}

/**
 * Scrape Messenger cho TẤT CẢ Sales agents (dùng cho cron job hàng đêm)
 * Chỉ chạy với agents có tài khoản FB được liên kết
 */
async function scrapeAllSalesMessengers(opts = {}) {
    console.log('\n[MessengerScraper] 🌙 Bắt đầu nightly Messenger learning...');
    const agents = database.getAgentProfiles();
    const results = [];

    for (const agent of agents) {
        const account = accountManager.getAccountBySalesName(agent.name);
        if (!account) {
            console.log(`[MessengerScraper] ⏭️ Bỏ qua ${agent.name} — chưa có account FB`);
            continue;
        }

        const result = await scrapeMessengerForSales(agent.name, opts);
        results.push(result);

        // Delay giữa các sales để không bị rate limit
        await delay(5000);
    }

    const total = results.reduce((sum, r) => sum + (r.learned || 0), 0);
    console.log(`\n[MessengerScraper] ✅ Nightly learning hoàn tất: ${total} mẫu từ ${results.length} agents`);
    return results;
}

module.exports = {
    scrapeMessengerForSales,
    scrapeAllSalesMessengers,
};
