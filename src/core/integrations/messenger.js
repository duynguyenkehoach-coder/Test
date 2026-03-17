/**
 * messenger.js — Facebook Messenger API Integration
 * 
 * ⚠️  AUTO_REPLY_ENABLED = false by default
 * Set AUTO_REPLY_ENABLED=true in .env ONLY when ready to go live.
 * All send functions are no-ops until enabled.
 */

const axios = require('axios');

const AUTO_REPLY_ENABLED = process.env.AUTO_REPLY_ENABLED === 'true';
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'thg_webhook_verify';
const APP_SECRET = process.env.FB_APP_SECRET || '';

const GRAPH_API = 'https://graph.facebook.com/v18.0';

// ─── Guard ──────────────────────────────────────────────────────────────────
function guardEnabled(label) {
    if (!AUTO_REPLY_ENABLED) {
        console.log(`[Messenger] ⚠️  ${label} skipped — AUTO_REPLY_ENABLED=false`);
        return false;
    }
    if (!PAGE_ACCESS_TOKEN) {
        console.warn('[Messenger] Missing FB_PAGE_ACCESS_TOKEN');
        return false;
    }
    return true;
}

// ─── Webhook Verification ────────────────────────────────────────────────────
/**
 * Express middleware for GET /webhook
 * Facebook sends: hub.mode, hub.verify_token, hub.challenge
 */
function verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('[Messenger] ✅ Webhook verified');
        return res.status(200).send(challenge);
    }
    console.warn('[Messenger] ❌ Webhook verification failed');
    res.sendStatus(403);
}

// ─── Receive Events ──────────────────────────────────────────────────────────
/**
 * Express handler for POST /webhook — receives messages & comment events
 */
function receiveWebhook(req, res) {
    res.sendStatus(200); // Always ack immediately

    if (!AUTO_REPLY_ENABLED) return;

    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of (body.entry || [])) {
        for (const event of (entry.messaging || [])) {
            if (event.message && !event.message.is_echo) {
                // Incoming DM
                console.log('[Messenger] 📨 New DM from', event.sender.id, ':', event.message.text);
                // TODO: match to lead by sender_id → auto-reply with agent voice
            }
        }

        for (const change of (entry.changes || [])) {
            if (change.field === 'feed' && change.value?.item === 'comment') {
                // Incoming comment on a post
                console.log('[Messenger] 💬 New comment:', change.value.message);
                // TODO: match post_url to lead → auto-reply comment
            }
        }
    }
}

// ─── Send Message (DM) ──────────────────────────────────────────────────────
/**
 * Send a private message to a Facebook user
 * @param {string} recipientId - Facebook PSID
 * @param {string} text - message text
 * @param {string} agentName - sales agent name (for logging)
 */
async function sendMessage(recipientId, text, agentName = 'AI') {
    if (!guardEnabled(`sendMessage to ${recipientId}`)) return { skipped: true };

    try {
        const res = await axios.post(
            `${GRAPH_API}/me/messages`,
            {
                recipient: { id: recipientId },
                message: { text },
                messaging_type: 'RESPONSE',
            },
            { params: { access_token: PAGE_ACCESS_TOKEN } }
        );
        console.log(`[Messenger] ✅ DM sent by ${agentName} → ${recipientId}`);
        return { success: true, message_id: res.data.message_id };
    } catch (err) {
        console.error('[Messenger] ❌ sendMessage error:', err.response?.data || err.message);
        return { error: err.response?.data || err.message };
    }
}

// ─── Reply to Comment ────────────────────────────────────────────────────────
/**
 * Reply to a Facebook post comment
 * @param {string} commentId - Facebook comment ID
 * @param {string} text - reply text
 * @param {string} agentName - sales agent name (for logging)
 */
async function replyComment(commentId, text, agentName = 'AI') {
    if (!guardEnabled(`replyComment to ${commentId}`)) return { skipped: true };

    try {
        const res = await axios.post(
            `${GRAPH_API}/${commentId}/comments`,
            { message: text },
            { params: { access_token: PAGE_ACCESS_TOKEN } }
        );
        console.log(`[Messenger] ✅ Comment reply sent by ${agentName}`);
        return { success: true, id: res.data.id };
    } catch (err) {
        console.error('[Messenger] ❌ replyComment error:', err.response?.data || err.message);
        return { error: err.response?.data || err.message };
    }
}

// ─── Status ──────────────────────────────────────────────────────────────────
function getStatus() {
    return {
        enabled: AUTO_REPLY_ENABLED,
        has_token: !!PAGE_ACCESS_TOKEN,
        has_app_secret: !!APP_SECRET,
        verify_token_set: VERIFY_TOKEN !== 'thg_webhook_verify',
    };
}

module.exports = {
    verifyWebhook,
    receiveWebhook,
    sendMessage,
    replyComment,
    getStatus,
    AUTO_REPLY_ENABLED,
};
