/**
 * Group Joiner — Batch join all target Facebook groups
 * 
 * @module scraper/groupJoiner
 */
const { delay, FB_URL, fs, path, extractGroupId, saveSession, state } = require('./browserManager');
const { getAuthContext } = require('./authContext');

/**
 * Auto-join all target Facebook groups for a specific account.
 * @param {Array|null} groups - Target groups (defaults to config)
 * @param {object|null} account - Specific FB account to use
 */
async function autoJoinGroups(groups = null, account = null) {
    const config = require('../../config');

    // Load groups: groups.db (source of truth) > config fallback
    let targetGroups = groups;
    if (!targetGroups || targetGroups.length === 0) {
        try {
            const groupDiscovery = require('../../ai/agents/groupDiscovery');
            targetGroups = groupDiscovery.getScanRotationList(200);
        } catch { }
    }
    if (!targetGroups || targetGroups.length === 0) {
        targetGroups = config.FB_TARGET_GROUPS || [];
    }

    if (targetGroups.length === 0) {
        console.log('[FBScraper] ⚠️ No target groups to join');
        return { joined: 0, already: 0, pending: 0, failed: 0 };
    }

    const accLabel = account?.email || 'default';
    console.log(`[FBScraper] 🚀 Auto-joining ${targetGroups.length} groups for ${accLabel}...`);

    const stats = { joined: 0, already: 0, pending: 0, failed: 0 };
    let page = null;

    try {
        const context = await getAuthContext(account);
        page = await context.newPage();

        for (let i = 0; i < targetGroups.length; i++) {
            if (i > 0 && i % 15 === 0) {
                console.log(`[FBScraper] 🔄 Recycling page (memory relief)...`);
                try { await page.close(); } catch { }
                page = await context.newPage();
                await delay(1000);
            }

            const group = targetGroups[i];
            const groupId = extractGroupId(group.url);
            if (!groupId) {
                console.warn(`[FBScraper] ⚠️ Bad URL: ${group.url}`);
                stats.failed++;
                continue;
            }

            try {
                console.log(`[FBScraper] [${i + 1}/${targetGroups.length}] ${group.name}`);
                await page.goto(`${FB_URL}/groups/${groupId}`, {
                    waitUntil: 'domcontentloaded', timeout: 25000,
                });
                await delay(2000);

                const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
                const hasFeed = await page.$('div[role="feed"], div[role="article"]');

                if (hasFeed || pageText.includes('Discussion') || pageText.includes('Thảo luận') ||
                    pageText.includes('Write something') || pageText.includes('Viết gì đó') ||
                    pageText.includes('What\'s on your mind') || pageText.includes('Bạn đang nghĩ gì') ||
                    pageText.includes('Create a post') || pageText.includes('Tạo bài viết') ||
                    pageText.includes('About') || pageText.includes('Members')) {
                    console.log(`  ✅ Already a member`);
                    stats.already++;
                    await delay(1000);
                    continue;
                }

                if (pageText.includes('Pending') || pageText.includes('Đang chờ') ||
                    pageText.includes('Cancel request') || pageText.includes('Hủy yêu cầu')) {
                    console.log(`  ⏳ Already pending approval`);
                    stats.pending++;
                    await delay(1000);
                    continue;
                }

                let joined = false;
                for (const label of ['Join group', 'Join Group', 'Tham gia nhóm', 'Tham gia', 'Join']) {
                    try {
                        const btn = await page.$(`div[role="button"]:has-text("${label}"), button:has-text("${label}")`);
                        if (btn) {
                            await btn.click({ force: true });
                            console.log(`  🔘 Clicked "${label}"`);
                            joined = true;
                            await delay(3000);
                            break;
                        }
                    } catch { }
                }

                if (!joined) {
                    try {
                        const joinBtn = await page.$('div[aria-label*="Join"], div[aria-label*="Tham gia"]');
                        if (joinBtn) {
                            await joinBtn.click({ force: true });
                            console.log(`  🔘 Clicked join (aria-label)`);
                            joined = true;
                            await delay(3000);
                        }
                    } catch { }
                }

                if (joined) {
                    const afterText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
                    if (afterText.includes('Answer') || afterText.includes('Trả lời') ||
                        afterText.includes('question') || afterText.includes('câu hỏi')) {
                        try {
                            const textareas = await page.$$('textarea');
                            for (const ta of textareas) {
                                await ta.fill('Tôi quan tâm đến vận chuyển hàng quốc tế VN-US. Xin cảm ơn!');
                            }
                            for (const submitLabel of ['Submit', 'Gửi', 'Done', 'Xong']) {
                                const submitBtn = await page.$(`button:has-text("${submitLabel}"), div[role="button"]:has-text("${submitLabel}")`);
                                if (submitBtn) {
                                    await submitBtn.click({ force: true });
                                    console.log(`  📝 Answered questions and submitted`);
                                    await delay(1000);
                                    break;
                                }
                            }
                        } catch { }
                    }
                    stats.joined++;
                    console.log(`  ✅ Join request sent!`);
                } else {
                    const currentUrl = page.url();
                    const snippet = pageText.substring(0, 150).replace(/\n/g, ' ');
                    console.log(`  ℹ️ Public/viewable (no join button)`);
                    console.log(`    URL: ${currentUrl.substring(0, 70)}`);
                    console.log(`    Page: ${snippet.substring(0, 100)}...`);
                    stats.viewable = (stats.viewable || 0) + 1;
                }
            } catch (err) {
                console.error(`  ❌ Error: ${err.message}`);
                stats.failed++;
            }
            await delay(2000);
        }

        await page.close();
    } catch (err) {
        console.error(`[FBScraper] ❌ Auto-join failed: ${err.message}`);
        if (page) try { await page.close(); } catch { }
    }

    if (state.activeContext) await saveSession(state.activeContext);

    console.log(`\n[FBScraper] 📊 Auto-Join Results:`);
    console.log(`  ✅ Joined: ${stats.joined}`);
    console.log(`  ✓ Already member: ${stats.already}`);
    console.log(`  ℹ️ Public/viewable: ${stats.viewable || 0}`);
    console.log(`  ⏳ Pending: ${stats.pending}`);
    console.log(`  ❌ Failed: ${stats.failed}`);

    return stats;
}

module.exports = { autoJoinGroups };
