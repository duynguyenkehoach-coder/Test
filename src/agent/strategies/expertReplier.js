/**
 * 🏆 Expert Replier — "Helpful Expert" Auto-Reply Strategy
 * 
 * AI viết comment reply TRỰC TIẾP trên bài post của lead.
 * Câu trả lời HỮU ÍCH THẬT SỰ cho vấn đề lead nêu ra — không spam/quảng cáo.
 * 
 * Flow:
 * 1. AI đọc bài post → hiểu vấn đề → viết reply giải đáp
 * 2. sniperAgent → navigate đến post → gõ comment humanized
 * 3. Lead thấy reply đúng vấn đề → inbox hỏi thêm → THG chốt deal
 * 
 * Tận dụng:
 * - outreachGenerator.js → generateComment()
 * - sniperAgent.js → sniperComment() (humanized typing)
 * - accountManager.js → getNextAccount()
 * 
 * @module agent/strategies/expertReplier
 */
'use strict';

const { generateComment } = require('../../ai/outreachGenerator');
const { sniperComment } = require('../../squad/agents/sniperAgent');
const accountManager = require('../accountManager');
const database = require('../../core/data_store/database');

// ─── Config ──────────────────────────────────────────────────────────────────
const MIN_SCORE = 70;           // Only reply to leads with score >= 70
const MAX_REPLIES_PER_SESSION = 3; // Max replies per session (anti-detection)
const DELAY_BETWEEN_REPLIES_MS = 60000; // 1 min between replies

/**
 * Reply to a single lead's post with helpful expert comment
 * @param {object} lead - Lead from DB (must have post_url, content)
 * @param {object} opts
 * @param {string} opts.staffName - Sales staff name for AI tone
 * @param {Page} opts.page - Playwright page (already authenticated)
 * @returns {{ success: boolean, comment: string, error?: string }}
 */
async function replyToPost(lead, opts = {}) {
    const { staffName = 'Trang', page = null } = opts;

    if (!lead.post_url) {
        return { success: false, comment: '', error: 'No post_url' };
    }

    console.log(`[ExpertReplier] 🏆 Replying to lead #${lead.id} (score: ${lead.score})`);

    try {
        // 1. AI generates helpful comment
        const result = await generateComment(lead, { staffName });
        const comment = result.message;

        if (!comment) {
            return { success: false, comment: '', error: 'AI returned empty comment' };
        }

        console.log(`[ExpertReplier] 💬 AI comment: "${comment.substring(0, 80)}..."`);

        // 2. If page provided, auto-comment via sniperAgent
        if (page) {
            const posted = await sniperComment(page, lead.post_url, {
                customTemplate: comment,
                account: staffName,
            });

            if (posted) {
                // Log to outreach_log
                logOutreach(lead.id, staffName, 'comment', comment, 'sent');
                // Update pipeline stage
                updatePipeline(lead.id, 'contacted');
                console.log(`[ExpertReplier] ✅ Comment posted on lead #${lead.id}`);
                return { success: true, comment };
            } else {
                logOutreach(lead.id, staffName, 'comment', comment, 'failed');
                return { success: false, comment, error: 'Sniper failed to post comment' };
            }
        }

        // 3. If no page — return draft only (for manual posting)
        logOutreach(lead.id, staffName, 'comment', comment, 'draft');
        return { success: true, comment, draft: true };

    } catch (e) {
        console.error(`[ExpertReplier] ❌ Error: ${e.message}`);
        return { success: false, comment: '', error: e.message };
    }
}

/**
 * Batch reply to multiple leads
 * @param {object[]} leads - Leads array (score >= MIN_SCORE, have post_url)
 * @param {object} opts - { staffName, page }
 * @returns {Array<{leadId, success, comment}>}
 */
async function batchReply(leads, opts = {}) {
    const eligible = leads
        .filter(l => l.post_url && l.score >= MIN_SCORE)
        .slice(0, MAX_REPLIES_PER_SESSION);

    console.log(`[ExpertReplier] 🏆 Batch reply: ${eligible.length} leads (max ${MAX_REPLIES_PER_SESSION})`);

    const results = [];
    for (let i = 0; i < eligible.length; i++) {
        const result = await replyToPost(eligible[i], opts);
        results.push({ leadId: eligible[i].id, ...result });

        // Delay between replies (anti-detection)
        if (i < eligible.length - 1) {
            const delay = DELAY_BETWEEN_REPLIES_MS + Math.random() * 30000;
            console.log(`[ExpertReplier] ⏳ Waiting ${Math.round(delay / 1000)}s before next reply...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    return results;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function logOutreach(leadId, staffName, channel, message, status) {
    try {
        database.db.prepare(`
            INSERT INTO outreach_log (lead_id, staff_name, channel, message, ai_generated, status, sent_at)
            VALUES (?, ?, ?, ?, 1, ?, ${status === 'sent' ? "datetime('now')" : 'NULL'})
        `).run(leadId, staffName, channel, message, status);
    } catch (e) { console.error(`[ExpertReplier] ⚠️ Log failed: ${e.message}`); }
}

function updatePipeline(leadId, stage) {
    try {
        database.db.prepare(`
            UPDATE leads SET pipeline_stage = ?, status = 'contacted',
            contacted_at = COALESCE(contacted_at, datetime('now')), updated_at = datetime('now')
            WHERE id = ?
        `).run(stage, leadId);
        database.invalidateStatsCache();
    } catch { }
}

module.exports = { replyToPost, batchReply, MIN_SCORE, MAX_REPLIES_PER_SESSION };
