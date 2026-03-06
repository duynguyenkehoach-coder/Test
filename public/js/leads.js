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

  // Staff assignment pills
  const STAFF = ['Trang', 'Min', 'Moon', 'Lê Huyền', 'Ngọc Huyền'];
  const assigned = lead.assigned_to || '';
  const staffPills = STAFF.map(name => {
    const isAssigned = assigned === name;
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return `<button class="staff-pill ${isAssigned ? 'staff-pill--active' : ''}" 
      onclick="assignStaff(${lead.id}, '${name}', this)" 
      title="${name}">${initials}</button>`;
  }).join('');

  return `
    <div class="lead-card ${scoreClass}" id="lead-${lead.id}" data-lead-id="${lead.id}">
      <div class="lead-main">
        <div class="lead-score-badge ${scoreClass}">${lead.score}</div>
        <div class="lead-body">

          <!-- Header tags -->
          <div class="lead-tags">
            <span class="platform-badge platform-${lead.platform}">${platformIcons[lead.platform] || '🌐'} ${lead.platform}</span>
            <span class="category-tag">${categoryEmojis[lead.category] || '🏷️'} ${lead.category || 'N/A'}</span>
            ${lead.role === 'buyer' ? '<span class="category-tag" style="background:rgba(16,185,129,0.15);color:#10b981;">🎯 Buyer</span>' : ''}
            ${lead.status !== 'new' ? `<span class="category-tag" style="background:rgba(59,130,246,0.1);color:#3b82f6;">● ${lead.status}</span>` : ''}
            <span class="category-tag" style="opacity:0.8;color:#94a3b8;">🕐 ${timeStr}</span>
          </div>

          <!-- Author -->
          <div class="lead-author" style="margin-top:6px;display:flex;align-items:center;gap:8px;">
            ${lead.author_avatar ? `<img src="${lead.author_avatar}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid var(--border);" onerror="this.style.display='none'">` : '<span style="font-size:1.2rem;">👤</span>'}
            <strong style="color:var(--text);font-size:0.95rem;">
              ${lead.author_url ? `<a href="${lead.author_url}" target="_blank" rel="noopener" style="text-decoration:none;color:var(--accent);">${author}</a>` : author}
            </strong>
            ${assigned ? `<span style="font-size:11px;color:#8b5cf6;background:rgba(139,92,246,0.1);padding:2px 7px;border-radius:10px;">👤 ${assigned}</span>` : ''}
          </div>

          ${summary ? `<div class="lead-summary">💡 ${summary}</div>` : ''}
          ${lead.buyer_signals ? `<div class="lead-summary" style="color:var(--accent);opacity:0.8;">🎯 ${escapeHtml(lead.buyer_signals)}</div>` : ''}

          <!-- Content -->
          <div class="lead-content" id="content-${lead.id}">${content}<div class="lead-content-fade" id="fade-${lead.id}"></div></div>
          <button class="expand-btn" onclick="toggleContent(${lead.id})">Xem thêm ▼</button>

          <!-- ─── COMPACT ACTION BAR ─── -->
          <div class="lead-action-bar">
            ${lead.post_url ? `<a href="${lead.post_url}" target="_blank" rel="noopener" class="lab-btn" title="Xem post">🔗</a>` : ''}
            ${lead.author_url ? `<a href="${lead.author_url}" target="_blank" rel="noopener" class="lab-btn" title="Profile">👤</a>` : ''}
            <button class="lab-btn ${lead.status === 'contacted' ? 'lab-active-blue' : ''}" onclick="contactLead(${lead.id})" title="Contacted">📞</button>
            <button class="lab-btn ${lead.status === 'converted' ? 'lab-active-green' : ''}" onclick="convertLead(${lead.id})" title="Converted">✅</button>
            <button class="lab-btn ${lead.status === 'ignored' ? 'lab-active-red' : ''}" onclick="updateStatus(${lead.id}, 'ignored')" title="Ignore">⛔</button>
            <button class="lab-btn" onclick="deleteLead(${lead.id})" title="Xóa" style="color:#ef4444;">🗑️</button>
            <div style="flex:1"></div>
            <!-- Staff assignment -->
            <div class="staff-assign" title="Assign nhân viên">${staffPills}</div>
          </div>

          <!-- ─── TABBED FOOTER ─── -->
          <div class="lead-tabs">
            <button class="lead-tab lead-tab--active" onclick="switchTab(${lead.id},'response',this)">💬 Response</button>
            <button class="lead-tab" onclick="switchTab(${lead.id},'notes',this)">📝 Notes</button>
            <button class="lead-tab" onclick="switchTab(${lead.id},'agent',this)">🧠 Agent</button>
          </div>

          <!-- Tab: Response -->
          <div class="lead-tab-panel" id="tab-response-${lead.id}">
            <div style="display:flex;gap:6px;margin-bottom:4px;">
              <button class="copy-btn" onclick="copyResponse(${lead.id})">📋 Copy</button>
              <button class="copy-btn" onclick="saveResponse(${lead.id})">💾 Save</button>
            </div>
            <textarea class="response-textarea" id="response-${lead.id}" rows="3">${lead.suggested_response || ''}</textarea>
          </div>

          <!-- Tab: Notes -->
          <div class="lead-tab-panel" id="tab-notes-${lead.id}" style="display:none;">
            <div style="display:flex;gap:6px;margin-bottom:4px;">
              <button class="copy-btn" onclick="saveNotes(${lead.id})">💾 Save ghi chú</button>
            </div>
            <textarea class="notes-textarea" id="notes-${lead.id}" rows="2" placeholder="Ghi chú: giá đã báo, deal progress...">${lead.notes || ''}</textarea>
          </div>

          <!-- Tab: Dạy Agent -->
          <div class="lead-tab-panel" id="tab-agent-${lead.id}" style="display:none;">
            <div class="lead-feedback-inline">
              <span class="feedback-status" id="feedback-status-${lead.id}"></span>
              <div class="feedback-quick-tags">
                <button class="feedback-tag" onclick="quickFeedback(${lead.id}, 'correct', null, '✅ Đúng — buyer xác nhận')">✅ Đúng</button>
                <button class="feedback-tag" onclick="quickFeedback(${lead.id}, 'wrong', 'provider', '❌ Sai — provider/đối thủ')">❌ Sai→Provider</button>
                <button class="feedback-tag" onclick="insertTag(${lead.id}, '⬆️ Score nên cao hơn, khoảng ')">⬆️ Nâng</button>
                <button class="feedback-tag" onclick="insertTag(${lead.id}, '⬇️ Score nên thấp hơn, khoảng ')">⬇️ Giảm</button>
              </div>
              <div class="feedback-input-row">
                <textarea class="feedback-textarea" id="feedback-text-${lead.id}" rows="2" placeholder="Ghi chú thêm cho Agent..."></textarea>
                <button class="feedback-send-btn" onclick="sendFeedback(${lead.id})">📤</button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;
}

function debounceSearch() {
  clearTimeout(AppState.searchTimeout);
  AppState.searchTimeout = setTimeout(() => loadLeads(), 400);
}

// ═══════════════════════════════════════════════════════
// Tab switching for lead card footer
// ═══════════════════════════════════════════════════════
function switchTab(leadId, tab, btnEl) {
  const tabs = ['response', 'notes', 'agent'];
  tabs.forEach(t => {
    const panel = document.getElementById(`tab-${t}-${leadId}`);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  // Update active tab button
  if (btnEl) {
    const allTabs = btnEl.closest('.lead-tabs')?.querySelectorAll('.lead-tab');
    allTabs?.forEach(b => b.classList.remove('lead-tab--active'));
    btnEl.classList.add('lead-tab--active');
  }
}

// ═══════════════════════════════════════════════════════
// Staff Assignment
// ═══════════════════════════════════════════════════════
async function assignStaff(leadId, staffName, pillBtn) {
  const card = document.getElementById(`lead-${leadId}`);
  const allPills = card?.querySelectorAll('.staff-pill');
  const currentAssigned = pillBtn?.classList.contains('staff-pill--active');
  const newAssigned = currentAssigned ? '' : staffName; // toggle off if same

  try {
    const resp = await fetch(`/api/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to: newAssigned }),
    });
    const data = await resp.json();
    if (data.ok || data.id) {
      // Update pills UI
      allPills?.forEach(p => p.classList.remove('staff-pill--active'));
      if (newAssigned) pillBtn?.classList.add('staff-pill--active');
      // Update badge in author row
      const authorRow = card?.querySelector('.lead-author');
      const existingBadge = authorRow?.querySelector('.assigned-badge');
      if (existingBadge) existingBadge.remove();
      if (newAssigned && authorRow) {
        const badge = document.createElement('span');
        badge.className = 'assigned-badge';
        badge.style.cssText = 'font-size:11px;color:#8b5cf6;background:rgba(139,92,246,0.1);padding:2px 7px;border-radius:10px;';
        badge.textContent = `👤 ${newAssigned}`;
        authorRow.appendChild(badge);
      }
    }
  } catch (err) {
    console.error('assignStaff error:', err);
  }
}



// ═══════════════════════════════════════════════════════
// Agent Feedback — Text-based learning
// ═══════════════════════════════════════════════════════
function insertTag(leadId, text) {
  const textarea = document.getElementById(`feedback-text-${leadId}`);
  if (!textarea) return;
  textarea.value = text;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// Quick feedback button — gửi ngay không cần nhập textarea
async function quickFeedback(leadId, type, correctRole, note) {
  const statusEl = document.getElementById(`feedback-status-${leadId}`);
  if (statusEl) { statusEl.textContent = '⏳ Đang lưu...'; statusEl.style.color = '#f59e0b'; }
  try {
    const resp = await fetch(`/api/leads/${leadId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, correct_role: correctRole, note }),
    });
    const data = await resp.json();
    if (data.ok) {
      if (statusEl) { statusEl.textContent = '✅ Agent đã học!'; statusEl.style.color = '#10b981'; }
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      loadAgentStats();
    } else {
      if (statusEl) { statusEl.textContent = '❌ ' + (data.error || 'Lỗi'); statusEl.style.color = '#ef4444'; }
    }
  } catch (err) {
    if (statusEl) { statusEl.textContent = '❌ Network error'; statusEl.style.color = '#ef4444'; }
  }
}

async function sendFeedback(leadId) {
  const textarea = document.getElementById(`feedback-text-${leadId}`);
  const statusEl = document.getElementById(`feedback-status-${leadId}`);
  const feedbackText = (textarea?.value || '').trim();

  if (!feedbackText) {
    statusEl.textContent = '⚠️ Nhập feedback trước';
    statusEl.style.color = '#f59e0b';
    textarea?.focus();
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    return;
  }

  try {
    statusEl.textContent = '⏳ Đang gửi...';
    statusEl.style.color = '#f59e0b';

    const resp = await fetch(`/api/leads/${leadId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'text_feedback',
        note: feedbackText,
      }),
    });
    const data = await resp.json();

    if (data.ok) {
      statusEl.textContent = '✅ Agent đã học!';
      statusEl.style.color = '#10b981';
      textarea.value = '';
      textarea.placeholder = '✅ Đã gửi! Nhập thêm nếu cần...';
      loadAgentStats();
    } else {
      statusEl.textContent = '❌ ' + (data.error || 'Lỗi');
      statusEl.style.color = '#ef4444';
    }
  } catch (err) {
    statusEl.textContent = '❌ Network error';
    statusEl.style.color = '#ef4444';
  }

  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
}

async function loadAgentStats() {
  const el = document.getElementById('agent-stats');
  if (!el) return;

  try {
    const [statsResp, histResp] = await Promise.all([
      fetch('/api/agent/stats'),
      fetch('/api/agent/feedback-history'),
    ]);
    const statsData = await statsResp.json();
    const histData = await histResp.json();

    const a = statsData.agent || {};
    const kb = a.knowledgeBase || {};
    const mem = a.memory || {};
    const history = histData.data || [];

    const histHTML = history.length === 0
      ? `<div style="color:#64748b;font-size:12px;padding:8px 0;">Chưa có training nào. Bấm ✅/❌ trên leads để dạy Agent.</div>`
      : history.map(r => `
        <div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:11px;">
          <span style="font-weight:600;color:#a78bfa;">${r.type}</span>
          ${r.correct_role ? `<span style="color:#64748b;margin-left:4px;">→${r.correct_role}</span>` : ''}
          <div style="color:#94a3b8;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(r.note || r.preview || '').substring(0, 80)}</div>
          <div style="color:#475569;font-size:10px;">${r.trained_at ? new Date(r.trained_at).toLocaleString('vi-VN') : ''}</div>
        </div>`).join('');

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
      ${history.length > 0 ? `
      <div style="margin-top:12px;">
        <div style="font-size:11px;font-weight:600;color:#8b5cf6;margin-bottom:6px;">🕓 Lịch sử training (${history.length})</div>
        <div style="max-height:200px;overflow-y:auto;">${histHTML}</div>
      </div>` : `<div style="margin-top:8px;font-size:11px;color:#64748b;">Chưa có training. Bấm ✅/❌ trên leads để dạy Agent.</div>`}
    `;
  } catch (err) {
    el.innerHTML = '<span style="color:#94a3b8;">Agent stats unavailable</span>';
  }
}

// Load agent stats on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadAgentStats, 1000);
});
