/**
 * 💬 Inbox Reader — Read Messenger Messages + AI Draft Replies
 * 
 * Checks Messenger inbox for new messages:
 * - Navigate to Messenger
 * - Scan conversation list
 * - Read new/unread messages
 * - AI draft replies (via personalAgent) — saved to DB, NOT auto-sent
 * - Log all activity for sales review
 * 
 * @module agent/social/inboxReader
 */
const { humanDelay, humanScroll } = require('../../squad/core/humanizer');
const { randInt } = require('./sessionManager');

// ─── Selectors ───────────────────────────────────────────────────────────────
const SEL = {
    // Messenger icon in nav
    MESSENGER_ICON: [
        '[aria-label="Messenger"], [aria-label="Tin nhắn"]',
        'a[href*="/messages"], a[href*="messenger.com"]',
    ],
    // Conversation items in list
    CONV_ITEM: '[role="row"] a, [data-testid*="mwthreadlist"] a, [role="listitem"] a',
    // Unread conversation indicator
    UNREAD: '[aria-label*="unread"], [aria-label*="chưa đọc"]',
    // Message bubbles in a conversation
    MESSAGE_BUBBLE: '[role="row"] [dir="auto"], [data-testid*="message"] [dir="auto"]',
    // Input box
    MSG_INPUT: '[role="textbox"][aria-label*="message"], [role="textbox"][aria-label*="tin nhắn"], [contenteditable="true"]',
};

const MESSENGER_URL = 'https://www.facebook.com/messages/t/';

/**
 * Check inbox for new messages
 * @param {Page} page - Playwright page
 * @param {object} opts
 * @param {Function} opts.onNewMessage - callback(senderName, message, convUrl)
 * @param {number} opts.maxConversations - max conversations to check (default 5)
 * @returns {{ checked: boolean, newMessages: number, conversations: object[] }}
 */
async function checkInbox(page, opts = {}) {
    const { onNewMessage = null, maxConversations = 5 } = opts;

    console.log(`[InboxReader] 💬 Checking inbox...`);

    const result = { checked: false, newMessages: 0, conversations: [] };

    try {
        // 1. Navigate to Messenger
        await page.goto(MESSENGER_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
        });
        await humanDelay(3000, 5000);
        result.checked = true;

        // 2. Scroll conversation list to load more
        const scrollCount = randInt(2, 3);
        for (let i = 0; i < scrollCount; i++) {
            await page.mouse.wheel(0, 200 + Math.random() * 300);
            await humanDelay(1000, 2500);
        }

        // 3. Find conversation items
        const convItems = await page.$$(SEL.CONV_ITEM);
        const toCheck = Math.min(maxConversations, convItems.length);

        console.log(`[InboxReader]   Found ${convItems.length} conversations, checking first ${toCheck}`);

        // 4. Check each conversation for new messages
        for (let i = 0; i < toCheck; i++) {
            try {
                // Re-query items (DOM might have changed after navigation)
                const items = await page.$$(SEL.CONV_ITEM);
                if (i >= items.length) break;

                const item = items[i];
                await item.scrollIntoViewIfNeeded();
                await humanDelay(500, 1500);

                // Extract sender name
                let senderName = 'Unknown';
                try {
                    const nameEl = await item.$('span');
                    if (nameEl) senderName = (await nameEl.innerText()).trim();
                } catch { }

                // Click into conversation
                await item.click();
                await humanDelay(2000, 4000);

                // Read latest messages
                const messages = await extractMessages(page);

                if (messages.length > 0) {
                    const latestIncoming = messages
                        .filter(m => m.direction === 'received')
                        .slice(-1)[0];

                    if (latestIncoming) {
                        result.newMessages++;
                        const convUrl = page.url();

                        const conv = {
                            senderName,
                            lastMessage: latestIncoming.text,
                            convUrl,
                            readAt: new Date().toISOString(),
                        };
                        result.conversations.push(conv);

                        console.log(`[InboxReader]   📩 ${senderName}: "${latestIncoming.text.substring(0, 60)}..."`);

                        // Callback for AI processing
                        if (onNewMessage) {
                            try {
                                await onNewMessage(senderName, latestIncoming.text, convUrl);
                            } catch (e) {
                                console.error(`[InboxReader]   ❌ onNewMessage callback error: ${e.message}`);
                            }
                        }
                    }
                }

                // "Read" the conversation (stay for 3-6 seconds)
                await humanDelay(3000, 6000);

                // Go back to conversation list
                await page.goto(MESSENGER_URL, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000,
                });
                await humanDelay(1500, 3000);

            } catch (e) {
                console.error(`[InboxReader]   ❌ Conversation #${i + 1} error: ${e.message}`);
                // Try to recover by going back to messages
                try {
                    await page.goto(MESSENGER_URL, {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000,
                    });
                    await humanDelay(1500, 2500);
                } catch { break; }
            }
        }

        console.log(`[InboxReader] ✅ Inbox checked: ${result.newMessages} new messages from ${result.conversations.length} conversations`);

    } catch (e) {
        console.error(`[InboxReader] ❌ Inbox error: ${e.message}`);
    }

    return result;
}

/**
 * Extract messages from the currently open conversation
 * @param {Page} page
 * @returns {Array<{text: string, direction: 'sent'|'received'}>}
 */
async function extractMessages(page) {
    const messages = [];

    try {
        const bubbles = await page.$$(SEL.MESSAGE_BUBBLE);
        const recentBubbles = bubbles.slice(-10); // Last 10 messages

        for (const bubble of recentBubbles) {
            try {
                const text = (await bubble.innerText()).trim();
                if (!text || text.length < 2) continue;

                // Determine direction: sent messages usually have different styling
                // Facebook uses different background colors — we check parent classes
                const parentClasses = await bubble.evaluate(el => {
                    let node = el;
                    for (let i = 0; i < 5; i++) {
                        node = node.parentElement;
                        if (!node) break;
                        const cl = node.className || '';
                        if (cl.includes('__fb-light-mode') || cl.length > 20) return cl;
                    }
                    return '';
                });

                // Heuristic: if the message aligns to the right, it's "sent"
                const isSent = await bubble.evaluate(el => {
                    let node = el;
                    for (let i = 0; i < 8; i++) {
                        node = node.parentElement;
                        if (!node) break;
                        const style = window.getComputedStyle(node);
                        if (style.justifyContent === 'flex-end' ||
                            style.alignSelf === 'flex-end' ||
                            style.marginLeft === 'auto') return true;
                    }
                    return false;
                });

                messages.push({
                    text: text.substring(0, 500),
                    direction: isSent ? 'sent' : 'received',
                });
            } catch { /* skip this bubble */ }
        }
    } catch (e) {
        console.error(`[InboxReader] ❌ Message extraction error: ${e.message}`);
    }

    return messages;
}

module.exports = { checkInbox, extractMessages };
