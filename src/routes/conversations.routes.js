/**
 * Conversations Routes — Inbox, webhook, test message
 */
const router = require('express').Router();
const database = require('../core/data_store/database');
const { generateCopilotReply, classifyIntent } = require('../ai/prompts/salesCopilot');

// ── GET /api/conversations — List conversations ─────────────────────────────
router.get('/api/conversations', (req, res) => {
    try {
        const filter = req.query.status || null;
        const agentName = req.query.agent || null;
        const convs = database.getConversations(filter, agentName);
        const stats = database.getConversationStats();
        res.json({ success: true, data: convs, stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── PATCH /api/conversations/:id — Update conversation ──────────────────────
router.patch('/api/conversations/:id', (req, res) => {
    try {
        const { sale_reply, status } = req.body;
        const id = parseInt(req.params.id);
        database.updateConversation.run({
            id,
            sale_reply: sale_reply || null,
            status: status || null,
        });

        // If regen requested, regenerate AI suggestion
        if (req.body.regenerate) {
            const conv = database.getConversationById.get(id);
            if (!conv) return res.status(404).json({ success: false, error: 'Conversation not found' });
        }

        const updated = database.getConversationById.get(id);
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/conversations/:id/regenerate — Regenerate AI reply ────────────
router.post('/api/conversations/:id/regenerate', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const conv = database.getConversationById.get(id);
        if (!conv) return res.status(404).json({ success: false, error: 'Conversation not found' });

        const newSuggestion = await generateCopilotReply(conv.customer_message, conv.sender_id);
        database.db.prepare(
            `UPDATE conversations SET ai_suggestion = ? WHERE id = ?`
        ).run(newSuggestion, id);

        const updated = database.getConversationById.get(id);
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /api/conversations/test — Manual test webhook ──────────────────────
router.post('/api/conversations/test', async (req, res) => {
    try {
        const { message, sender_name } = req.body;
        if (!message) return res.status(400).json({ success: false, error: 'message required' });

        const senderId = `test_${Date.now()}`;
        const aiSuggestion = await generateCopilotReply(message, senderId);
        const intent = await classifyIntent(message);

        const result = database.insertConversation.run({
            sender_id: senderId,
            sender_name: sender_name || 'Test User',
            customer_message: message,
            ai_suggestion: aiSuggestion,
            intent: intent?.type || 'unknown',
            confidence: intent?.confidence || 0,
        });

        const conv = database.getConversationById.get(result.lastInsertRowid);
        res.json({ success: true, data: conv });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
