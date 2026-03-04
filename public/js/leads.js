/**
 * leads.js — Leads tab rendering (grouped by date + time slot)
 */

// --- Helper to get Date object safely ---
function getPostDate(lead) {
  const dateStr = lead.post_created_at || lead.scraped_at || lead.created_at;
  return new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
}

function renderLeads() {
  const grid = document.getElementById('leadsGrid');
  if (!AppState.leads || AppState.leads.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No leads found</h3><p>Try adjusting filters or run a new scan.</p></div>`;
    return;
  }

  // Apply Date & Time Filters
  const filterDate = document.getElementById('filterDate')?.value;
  const filterTime = document.getElementById('filterTime')?.value;

  const filteredLeads = AppState.leads.filter(lead => {
    if (!filterDate && !filterTime) return true;

    const dt = getPostDate(lead);
    const d = dt.toLocaleDateString('sv-SE');
    const h = String(dt.getHours()).padStart(2, '0');
    const t = `${h}:00`; // Filter by hourly slots

    if (filterDate && d !== filterDate) return false;
    if (filterTime && t !== filterTime) return false;
    return true;
  });

  if (filteredLeads.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No leads match filter</h3><p>Try changing your date or time selection.</p></div>`;
    return;
  }

  // Group leads by exact post hour (1-hour blocks)
  const grouped = groupLeadsByDateTime(filteredLeads);
  let html = '';

  for (const [dateKey, timeSlots] of Object.entries(grouped)) {
    const isToday = dateKey === todayStr();
    const isYesterday = dateKey === yesterdayStr();
    const dateLabel = isToday ? `📅 Hôm nay — ${dateKey}`
      : isYesterday ? `📅 Hôm qua — ${dateKey}`
        : `📅 ${dateKey}`;
    const totalForDay = Object.values(timeSlots).reduce((s, arr) => s + arr.length, 0);

    html += `<div class="leads-date-group">
      <div class="leads-date-header">
        <span>${dateLabel}</span>
        <span class="leads-date-count">${totalForDay} leads</span>
      </div>`;

    for (const [timeKey, leads] of Object.entries(timeSlots)) {
      html += `<div class="leads-time-group">
        <div class="leads-time-header">
          <span>🕐 Khung giờ: ${timeKey}</span>
          <span class="leads-time-count">${leads.length} bài đăng</span>
        </div>
        <div class="leads-time-cards">`;

      for (const lead of leads) {
        html += renderLeadCard(lead);
      }

      html += `</div></div>`;
    }

    html += `</div>`;
  }

  grid.innerHTML = html;
}

function groupLeadsByDateTime(leads) {
  const groups = {};

  for (const lead of leads) {
    const dt = getPostDate(lead);
    const dateKey = dt.toLocaleDateString('sv-SE'); // YYYY-MM-DD
    const hours = String(dt.getHours()).padStart(2, '0');
    const timeKey = `${hours}:00`; // Exact hour bucket

    if (!groups[dateKey]) groups[dateKey] = {};
    if (!groups[dateKey][timeKey]) groups[dateKey][timeKey] = [];
    groups[dateKey][timeKey].push(lead);
  }

  // Sort: dates descending, time slots descending
  const sorted = {};
  const dateKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  for (const dk of dateKeys) {
    sorted[dk] = {};
    const timeKeys = Object.keys(groups[dk]).sort((a, b) => b.localeCompare(a));
    for (const tk of timeKeys) {
      sorted[dk][tk] = groups[dk][tk];
    }
  }
  return sorted;
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE');
}
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const dt = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  const Math_floor = Math.floor;

  const diffMs = Date.now() - dt.getTime();
  if (isNaN(diffMs)) return '';

  const mins = Math_floor(diffMs / 60000);
  if (mins < 60) return `⏱️ ${mins} phút trước`;
  const hours = Math_floor(mins / 60);
  if (hours < 24) return `⏱️ ${hours} giờ trước`;
  const days = Math_floor(hours / 24);
  return `📅 ${days} ngày trước`;
}

function renderLeadCard(lead) {
  const scoreClass = lead.score >= 80 ? 'score-high' : lead.score >= 60 ? 'score-med' : 'score-low';
  const platformIcons = { facebook: '📘', instagram: '📷', tiktok: '🎵' };
  const categoryEmojis = { POD: '🖨️', Dropship: '📦', Fulfillment: '🏭', Express: '✈️', Warehouse: '🏢', General: '🔄' };
  const content = escapeHtml(lead.content || '');
  const summary = escapeHtml(lead.summary || '');
  const author = escapeHtml(lead.author_name || 'Unknown');

  const postDateStr = lead.post_created_at || lead.scraped_at || lead.created_at;
  const timeStr = timeAgo(postDateStr);
  const exactTimeStr = new Date(postDateStr.endsWith('Z') ? postDateStr : postDateStr + 'Z').toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  return `
    <div class="lead-card ${lead.status !== 'new' ? 'status-' + lead.status : ''}" data-id="${lead.id}">
      <div class="score-badge ${scoreClass}">${lead.score}</div>
      <div class="lead-body">
        <div class="lead-meta" style="flex-wrap: wrap; gap: 6px;">
          <span class="platform-badge platform-${lead.platform}">${platformIcons[lead.platform] || '🌐'} ${lead.platform}</span>
          <span class="category-tag">${categoryEmojis[lead.category] || '🏷️'} ${lead.category || 'N/A'}</span>
          <span class="urgency-tag urgency-${lead.urgency || 'low'}">${lead.urgency || 'low'}</span>
          ${lead.role === 'buyer' ? '<span class="category-tag" style="background:rgba(16,185,129,0.15);color:#10b981;">🎯 Buyer</span>' : ''}
          ${lead.status !== 'new' ? `<span class="category-tag" style="background:rgba(59,130,246,0.1);color:#3b82f6;">● ${lead.status}</span>` : ''}
          <span class="category-tag" style="opacity:0.9; background:#f1f5f9; color:#475569; border: 1px solid #cbd5e1;">✏️ Đăng: ${exactTimeStr}</span>
          <span class="category-tag" style="opacity:0.8;${timeStr.includes('ngày') ? 'color:#ef4444;background:rgba(239,68,68,0.1);' : 'color:#10b981;background:rgba(16,185,129,0.1);'}">${timeStr}</span>
        </div>
        <div class="lead-author" style="margin-top: 8px; display:flex; align-items:center; gap:10px;">
          ${lead.author_avatar ? `<img src="${lead.author_avatar}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--border);" onerror="this.style.display='none'">` : '<span style="font-size:1.6rem;">👤</span>'}
          <strong style="color:var(--text);font-size:1.05rem;">
            ${lead.author_url ? `<a href="${lead.author_url}" target="_blank" rel="noopener" style="text-decoration:none;color:var(--accent);">${author}</a>` : author}
          </strong>
        </div>
        ${summary ? `<div class="lead-summary">💡 ${summary}</div>` : ''}
        ${lead.buyer_signals ? `<div class="lead-summary" style="color:var(--accent);opacity:0.8;">🎯 ${escapeHtml(lead.buyer_signals)}</div>` : ''}
        <div class="lead-content" id="content-${lead.id}">
          ${content}
          <div class="lead-content-fade" id="fade-${lead.id}"></div>
        </div>
        <button class="expand-btn" onclick="toggleContent(${lead.id})">Show more ▼</button>

        <!--Editable Response-->
        <div class="lead-response">
          <div class="lead-response-header">
            <span class="lead-response-label">💬 Response (editable)</span>
            <div style="display:flex;gap:6px;">
              <button class="copy-btn" onclick="copyResponse(${lead.id})">📋 Copy</button>
              <button class="copy-btn" onclick="saveResponse(${lead.id})">💾 Save</button>
            </div>
          </div>
          <textarea class="response-textarea" id="response-${lead.id}" rows="3">${lead.suggested_response || ''}</textarea>
        </div>

        <!--Notes-->
        <div class="lead-notes">
          <div class="lead-response-header">
            <span class="lead-response-label">📝 Notes</span>
            <button class="copy-btn" onclick="saveNotes(${lead.id})">💾 Save</button>
          </div>
          <textarea class="notes-textarea" id="notes-${lead.id}" rows="2" placeholder="Ghi chú: giá đã báo, deal progress...">${lead.notes || ''}</textarea>
        </div>

        <!--Agent Feedback-->
        <div class="lead-feedback" id="feedback-${lead.id}">
          <div class="lead-response-header">
            <span class="lead-response-label">🧠 Agent Feedback</span>
            <span class="feedback-status" id="feedback-status-${lead.id}"></span>
          </div>
          <div class="feedback-buttons">
            <button class="feedback-btn fb-correct" onclick="sendFeedback(${lead.id}, 'correct')" title="AI phân loại đúng">👍 Đúng</button>
            <button class="feedback-btn fb-wrong" onclick="sendFeedback(${lead.id}, 'wrong')" title="AI phân loại sai">👎 Sai</button>
            <button class="feedback-btn fb-upgrade" onclick="sendFeedback(${lead.id}, 'upgrade')" title="Lead tốt hơn AI nghĩ">⬆️ Nâng</button>
            <button class="feedback-btn fb-downgrade" onclick="sendFeedback(${lead.id}, 'downgrade')" title="Lead kém hơn AI nghĩ">⬇️ Giảm</button>
          </div>
        </div>

      </div>
      <div class="lead-actions">
        ${lead.post_url ? `<a href="${lead.post_url}" target="_blank" rel="noopener" class="action-btn view-post-btn">🔗 View Post</a>` : ''}
        <button class="action-btn ${lead.status === 'contacted' ? 'active-contacted' : ''}" onclick="contactLead(${lead.id})">📞 Contacted</button>
        <button class="action-btn ${lead.status === 'converted' ? 'active-converted' : ''}" onclick="convertLead(${lead.id})">✅ Converted</button>
        <button class="action-btn ${lead.status === 'ignored' ? 'active-ignored' : ''}" onclick="updateStatus(${lead.id}, 'ignored')">⛔ Ignore</button>
        <button class="action-btn" style="color:#ef4444;" onclick="deleteLead(${lead.id})">🗑️ Delete</button>
      </div>
    </div>
  `;
}

function debounceSearch() {
  clearTimeout(AppState.searchTimeout);
  AppState.searchTimeout = setTimeout(() => loadLeads(), 400);
}

// ═══════════════════════════════════════════════════════
// Agent Feedback
// ═══════════════════════════════════════════════════════
async function sendFeedback(leadId, type) {
  const statusEl = document.getElementById(`feedback-status-${leadId}`);
  const feedbackDiv = document.getElementById(`feedback-${leadId}`);

  try {
    statusEl.textContent = '⏳ Đang gửi...';
    statusEl.style.color = '#f59e0b';

    const resp = await fetch(`/api/leads/${leadId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    const data = await resp.json();

    if (data.ok) {
      statusEl.textContent = '✅ Agent đã học!';
      statusEl.style.color = '#10b981';

      // Highlight the clicked button
      const btns = feedbackDiv.querySelectorAll('.feedback-btn');
      btns.forEach(btn => btn.classList.remove('fb-active'));
      const activeBtn = feedbackDiv.querySelector(`.fb-${type}`);
      if (activeBtn) activeBtn.classList.add('fb-active');

      // Refresh agent stats if visible
      loadAgentStats();
    } else {
      statusEl.textContent = '❌ ' + (data.error || 'Lỗi');
      statusEl.style.color = '#ef4444';
    }
  } catch (err) {
    statusEl.textContent = '❌ Network error';
    statusEl.style.color = '#ef4444';
  }

  // Clear status after 3s
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
}

async function loadAgentStats() {
  const el = document.getElementById('agent-stats');
  if (!el) return;

  try {
    const resp = await fetch('/api/agent/stats');
    const data = await resp.json();
    const a = data.agent || {};
    const kb = a.knowledgeBase || {};
    const mem = a.memory || {};

    el.innerHTML = `
      <div class="agent-stats-grid">
        <div class="agent-stat">
          <span class="agent-stat-value">${kb.chunks || 0}</span>
          <span class="agent-stat-label">📚 KB Chunks</span>
        </div>
        <div class="agent-stat">
          <span class="agent-stat-value">${mem.total || 0}</span>
          <span class="agent-stat-label">💾 Memory</span>
        </div>
        <div class="agent-stat">
          <span class="agent-stat-value">${mem.withFeedback || 0}</span>
          <span class="agent-stat-label">🎓 Trained</span>
        </div>
        <div class="agent-stat">
          <span class="agent-stat-value">${mem.buyers || 0}</span>
          <span class="agent-stat-label">🎯 Buyers</span>
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = '<span style="color:#94a3b8;">Agent stats unavailable</span>';
  }
}

// Load agent stats on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadAgentStats, 1000);
});

