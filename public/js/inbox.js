/**
 * inbox.js — Inbox tab rendering (conversations + test modal)
 */

function renderConversations() {
    const grid = document.getElementById('inboxGrid');
    if (!AppState.conversations || AppState.conversations.length === 0) {
        grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📬</div>
        <h3>No messages yet</h3>
        <p>Messages from Facebook Messenger will appear here with AI-drafted replies.</p>
        <p style="margin-top:12px;font-size:0.85rem;opacity:0.7;">Use 🧪 "Test Message" to try the AI Copilot now.</p>
      </div>`;
        return;
    }
    grid.innerHTML = AppState.conversations.map(conv => renderConversationCard(conv)).join('');
}

function renderConversationCard(conv) {
    const intentEmojis = { price_inquiry: '💰', service_inquiry: '📋', urgent_need: '🔥', general: '💬', spam: '🚫' };
    const statusColors = { pending: '#f59e0b', replied: '#10b981', ignored: '#6b7280' };
    const statusEmojis = { pending: '⏳', replied: '✅', ignored: '⛔' };
    const message = escapeHtml(conv.message || '');
    const aiReply = conv.ai_suggestion || '';
    const saleReply = conv.sale_reply || '';

    return `
    <div class="lead-card conv-card ${conv.status === 'pending' ? 'conv-pending' : ''}" data-id="${conv.id}">
      <div class="score-badge" style="background:${statusColors[conv.status] || '#6b7280'};font-size:0.8rem;">
        ${statusEmojis[conv.status] || '💬'}
      </div>
      <div class="lead-body">
        <div class="lead-meta">
          <span class="platform-badge platform-${conv.platform || 'facebook'}">${conv.platform === 'facebook' ? '📘 Messenger' : '💬 ' + (conv.platform || 'manual')}</span>
          <span class="category-tag">${intentEmojis[conv.intent] || '💬'} ${conv.intent || 'general'}</span>
          <span class="category-tag" style="opacity:0.6;">${new Date(conv.created_at).toLocaleString('vi-VN')}</span>
        </div>
        <div class="lead-author">👤 ${escapeHtml(conv.sender_name || 'Unknown')}</div>
        
        <!-- Customer message -->
        <div class="conv-message-box">
          <div class="conv-message-label">🗣️ Khách nói:</div>
          <div class="conv-message-text">"${message}"</div>
        </div>

        <!-- AI Copilot suggestion -->
        <div class="lead-response">
          <div class="lead-response-header">
            <span class="lead-response-label">🤖 AI Copilot Draft</span>
            <button class="copy-btn" id="regen-${conv.id}" onclick="regenerateReply(${conv.id})">🔄 Regen</button>
            <button class="copy-btn" onclick="copyText(document.getElementById('reply-${conv.id}').value)">📋 Copy</button>
          </div>
          <textarea class="conv-reply-editor" id="reply-${conv.id}" rows="4">${escapeHtml(saleReply || aiReply)}</textarea>
        </div>
      </div>

      <div class="lead-actions">
        ${conv.status === 'pending' ? `
          <button class="action-btn active-converted" onclick="markReplied(${conv.id})">✅ Mark as Replied</button>
          <button class="action-btn active-ignored" onclick="updateConversation(${conv.id}, null, 'ignored')">⛔ Ignore</button>
        ` : `
          <span class="category-tag" style="background:${statusColors[conv.status]}20;color:${statusColors[conv.status]};">
            ${statusEmojis[conv.status]} ${conv.status}
          </span>
        `}
      </div>
    </div>
  `;
}

function markReplied(id) {
    const textarea = document.getElementById(`reply-${id}`);
    const reply = textarea ? textarea.value : '';
    updateConversation(id, reply, 'replied');
}

// --- Test Message Modal ---
function showTestModal() { document.getElementById('testModal').style.display = 'flex'; }
function hideTestModal(e) {
    if (!e || e.target === document.getElementById('testModal'))
        document.getElementById('testModal').style.display = 'none';
}
