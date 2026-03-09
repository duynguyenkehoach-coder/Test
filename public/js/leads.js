/**
 * leads.js — Leads tab rendering (grouped by date + time slot)
 */

// --- Helper to get Date object safely ---
function getPostDate(lead) {
  const dateStr = lead.post_created_at || lead.scraped_at || lead.created_at;
  return new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
}

function renderLeadsList(leadsArray, gridId = 'leadsGrid') {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (!leadsArray || leadsArray.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No leads found</h3><p>Try adjusting filters or run a new scan.</p></div>`;
    return;
  }

  // Apply Date & Time Filters
  const filterDate = document.getElementById('filterDate')?.value;
  const filterTime = document.getElementById('filterTime')?.value;

  const filteredLeads = leadsArray.filter(lead => {
    if (gridId === 'ignoredGrid') return true;
    if (!filterDate && !filterTime) return true;

    const dt = getPostDate(lead);
    const d = dt.toLocaleDateString('sv-SE');
    const h = String(dt.getHours()).padStart(2, '0');
    const t = `${h}:00`;

    if (filterDate && d !== filterDate) return false;
    if (filterTime && t !== filterTime) return false;
    return true;
  });

  if (filteredLeads.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No leads match filter</h3><p>Try changing your date or time selection.</p></div>`;
    return;
  }

  // Render Grid format
  let html = '';
  for (const lead of filteredLeads) {
    if (gridId === 'leadsGrid') {
      html += renderCompactLeadCard(lead);
    } else {
      html += renderLeadCard(lead);
    }
  }

  grid.innerHTML = html;
}

// ═══ MASTER-DETAIL VIEW LOGIC ═══

function renderCompactLeadCard(lead) {
  const scoreClass = lead.score >= 80 ? 'score-high' : lead.score >= 60 ? 'score-med' : 'score-low';
  const platformIcons = { facebook: '📘', instagram: '📷', tiktok: '🎵' };
  const dt = getPostDate(lead);
  const timeStr = dt.toLocaleDateString('sv-SE') + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  const author = escapeHtml(lead.author_name || 'Unknown');

  // Truncate content for summary
  const shortContent = escapeHtml(lead.content || '').substring(0, 100) + '...';

  let moneyBadge = '';
  if (lead.profit_estimate || lead.score >= 80) {
    moneyBadge = `<div class="compact-money">💰 ${lead.profit_estimate || 'HOT'}</div>`;
  }

  const isClaimed = (lead.claimed_by || lead.assigned_to) ? 'compact-claimed' : '';

  return `
    <div class="compact-card ${scoreClass} ${isClaimed}" onclick="openLeadDetail(${lead.id})">
      <div class="compact-header">
        <span class="compact-score ${scoreClass}">${lead.score}</span>
        <span class="compact-platform">${platformIcons[lead.platform] || '🌐'}</span>
        <span class="compact-time">${timeStr}</span>
        ${moneyBadge}
      </div>
      <div class="compact-author">${author}</div>
      <div class="compact-gap">${escapeHtml(lead.gap_opportunity || lead.summary || shortContent)}</div>
    </div>
  `;
}

function openLeadDetail(leadId) {
  const lead = AppState.leads.find(l => l.id === leadId) || AppState.ignoredLeads.find(l => l.id === leadId);
  if (!lead) return;

  // Hide Main View, Show Detail View
  document.getElementById('leadsMainView').style.display = 'none';
  const detailView = document.getElementById('leadDetailView');
  detailView.style.display = 'block';

  // Render the full War Room card plus a back button using the existing renderLeadCard logic
  detailView.innerHTML = `
    <div class="war-room-header">
      <button class="back-btn" onclick="closeLeadDetail()">⬅️ Quay lại danh sách</button>
      <div class="war-room-title">🎯 The Closing Room</div>
    </div>
    <div class="war-room-content">
      ${renderLeadCard(lead, 'war-room')}
    </div>
  `;
}

function closeLeadDetail() {
  document.getElementById('leadDetailView').style.display = 'none';
  document.getElementById('leadsMainView').style.display = 'block';
  document.getElementById('leadDetailView').innerHTML = '';
}


function renderLeads() {
  renderLeadsList(AppState.leads, 'leadsGrid');
}

function renderIgnoredLeads() {
  renderLeadsList(AppState.ignoredLeads, 'ignoredGrid');
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

function renderLeadCard(lead, columnType = 'warm') {
  const scoreClass = lead.score >= 80 ? 'score-high' : lead.score >= 60 ? 'score-med' : 'score-low';
  const platformIcons = { facebook: '📘', instagram: '📷', tiktok: '🎵' };
  const categoryEmojis = { POD: '🖨️', Dropship: '📦', Fulfillment: '🏭', Express: '✈️', Warehouse: '🏢', General: '🔄' };
  const content = escapeHtml(lead.content || '');
  const summary = escapeHtml(lead.summary || '');
  const author = escapeHtml(lead.author_name || 'Unknown');

  const postDateStr = lead.post_created_at || lead.scraped_at || lead.created_at;
  const timeStr = timeAgo(postDateStr);

  // ═══ SENTIMENT TAG ═══
  let sentimentTag = '';
  if (lead.urgency === 'critical' || lead.score >= 90) {
    sentimentTag = `<span class="sentiment-tag sentiment-frustrated">😤 Frustrated</span>`;
  } else if (lead.score >= 85) {
    sentimentTag = `<span class="sentiment-tag sentiment-vip">💎 VIP</span>`;
  } else if (lead.urgency === 'high') {
    sentimentTag = `<span class="sentiment-tag sentiment-urgent">⚡ Cần gấp</span>`;
  } else if (lead.urgency === 'medium') {
    sentimentTag = `<span class="sentiment-tag sentiment-inquiry">💬 Hỏi thăm</span>`;
  }

  // ═══ HOT METER ═══
  const hotPercent = Math.min(lead.score || 0, 100);
  const hotLabel = hotPercent >= 80 ? '🔥 HOT' : hotPercent >= 60 ? '⚡ WARM' : '💤 LOW';

  // ═══ MULTI-SALES CLAIM PILLS ═══
  const STAFF = ['Trang', 'Min', 'Moon', 'Lê Huyền', 'Ngọc Huyền'];
  const claimedByArr = (lead.claimed_by || lead.assigned_to || '').split(',').map(s => s.trim()).filter(Boolean);
  const isClaimed = claimedByArr.length > 0;

  const staffPills = STAFF.map(name => {
    const isMe = claimedByArr.includes(name);
    // Any active staff gets the glowing class, no more 'locked/disabled'
    const activeClass = isMe ? 'staff-pill--active' : '';
    return `<button class="staff-pill ${activeClass}" 
      onclick="claimLead(${lead.id}, '${name}', this)" 
      title="${isMe ? 'Nhả lead' : 'Cùng tiếp nhận'}">${name}${isMe ? ' ⚡' : ''}</button>`;
  }).join('');

  // ═══ WINNER / CLOSE DEAL BUTTON ═══
  const winnerSection = lead.winner_staff
    ? `<div class="winner-display">🏆 ${escapeHtml(lead.winner_staff)} chốt đơn ($${lead.deal_value || 0})</div>`
    : `<button class="close-deal-huge-btn" onclick="showCloseDealModal(${lead.id})">🏆 BÁO CÁO CHỐT ĐƠN</button>`;

  // ═══ NEURAL RESPONSE TEMPLATES ═══
  const templateButtons = `
    <div class="neural-templates">
      <div class="template-cases">
        <button class="template-btn" onclick="fillTemplate(${lead.id}, 'quote')" title="Báo giá nhanh">📋 Báo giá</button>
        <button class="template-btn" onclick="fillTemplate(${lead.id}, 'fulfill')" title="Tư vấn Kho/Fulfill">🏭 Kho/FF</button>
        <button class="template-btn" onclick="fillTemplate(${lead.id}, 'complaint')" title="Xử lý khiếu nại">🛡️ Khiếu nại</button>
      </div>
      <div class="tone-selector">
        <button class="tone-btn tone-btn--active" onclick="setTone(${lead.id}, 'friendly', this)">🤝 Thân thiện</button>
        <button class="tone-btn" onclick="setTone(${lead.id}, 'professional', this)">👔 Pro</button>
        <button class="tone-btn" onclick="setTone(${lead.id}, 'concise', this)">⚡ Ngắn</button>
      </div>
    </div>`;

  return `
    <div class="lead-card lead-card--${columnType} ${scoreClass} ${isClaimed ? 'lead-card--claimed' : ''}" id="lead-${lead.id}" data-lead-id="${lead.id}" data-tone="friendly">
      <div class="lead-main">
        <div class="lead-score-badge ${scoreClass}">${lead.score}</div>
        <div class="lead-body">

          <!-- Header tags -->
          <div class="lead-tags">
            <span class="platform-badge platform-${lead.platform}">${platformIcons[lead.platform] || '🌐'} ${lead.platform}</span>
            <span class="category-tag">${categoryEmojis[lead.category] || '🏷️'} ${lead.category || 'N/A'}</span>
            ${lead.role === 'buyer' ? '<span class="category-tag" style="background:rgba(16,185,129,0.15);color:#10b981;">🎯 Buyer</span>' : ''}
            ${sentimentTag}
            ${isClaimed ? `<span class="claim-status-badge">👥 ${claimedByArr.join(', ')}</span>` : ''}
            <span class="category-tag" style="opacity:0.8;color:#94a3b8;">🕐 ${timeStr}</span>
          </div>

          <!-- Hot Meter -->
          <div class="hot-meter" title="Lead Score: ${hotPercent}%">
            <div class="hot-meter-fill" style="width: ${hotPercent}%"></div>
            <span class="hot-meter-label">${hotLabel}</span>
          </div>

          <!-- 💎 REVENUE DASHBOARD V2 💎 -->
          <div class="revenue-dashboard-panel">
            <div class="revenue-top-row">
              <span class="speed-counter-v2" data-created="${postDateStr}">⏱️ Speed-to-lead: ${timeStr}</span>
              <div class="quality-badges">
                ${(lead.pain_score > 0) ? `<span class="pain-score-badge" title="Điểm đau của buyer">⚡ Pain:${lead.pain_score}</span>` : ''}
                ${(lead.spam_score > 0) ? `<span class="spam-score-badge" title="Tín hiệu rác">🚨 Spam:${lead.spam_score}</span>` : ''}
              </div>
            </div>
            
            <div class="revenue-money-row">
              ${lead.profit_estimate ? `
                <div class="huge-profit-box">
                  <div class="profit-label">KỲ VỌNG DOANH THU</div>
                  <div class="profit-value">💰 ${escapeHtml(lead.profit_estimate)}</div>
                </div>
              ` : ''}
              ${lead.gap_opportunity ? `
                <div class="gap-insight-box">
                  <div class="gap-label">CƠ HỘI SELL (GAP)</div>
                  <div class="gap-value">🔍 ${escapeHtml(lead.gap_opportunity)}</div>
                </div>
              ` : ''}
            </div>

            <div class="revenue-action-row">
              ${winnerSection}
            </div>
          </div>

          <!-- Author -->
          <div class="lead-author" style="margin-top:6px;display:flex;align-items:center;gap:8px;">
            ${lead.author_avatar ? `<img src="${lead.author_avatar}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid var(--border);" onerror="this.style.display='none'">` : '<span style="font-size:1.2rem;">👤</span>'}
            <strong style="color:var(--text);font-size:0.95rem;">
              ${lead.author_url ? `<a href="${lead.author_url}" target="_blank" rel="noopener" style="text-decoration:none;color:var(--accent);">${author}</a>` : author}
            </strong>
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
            <!-- Staff Claim (Multi-Sales) -->
            <div class="staff-assign" title="Tham gia tiếp nhận lead (không chặn nhau)">${staffPills}</div>
          </div>

          <!-- ─── TABBED FOOTER ─── -->
          <div class="lead-tabs">
            <button class="lead-tab lead-tab--active" onclick="switchLeadTab(${lead.id},'response',this)">💬 Response</button>
            <button class="lead-tab" onclick="switchLeadTab(${lead.id},'notes',this)">📝 Notes</button>
            <button class="lead-tab" onclick="switchLeadTab(${lead.id},'agent',this)">🧠 Agent</button>
          </div>

          <!-- Tab: Response + Neural Templates -->
          <div class="lead-tab-panel" id="tab-response-${lead.id}">
            ${templateButtons}
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
function switchLeadTab(leadId, tab, btnEl) {
  const tabs = ['response', 'notes', 'agent'];
  tabs.forEach(t => {
    const panel = document.getElementById(`tab-${t}-${leadId}`);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  if (btnEl) {
    const allTabs = btnEl.closest('.lead-tabs')?.querySelectorAll('.lead-tab');
    allTabs?.forEach(b => b.classList.remove('lead-tab--active'));
    btnEl.classList.add('lead-tab--active');
  }
}

// ═══════════════════════════════════════════════════════
// Multi-Sales Claim — Neon Active Staff Assignment (No Blocking)
// ═══════════════════════════════════════════════════════
async function claimLead(leadId, staffName, pillBtn) {
  const card = document.getElementById(`lead-${leadId}`);
  const allPills = card?.querySelectorAll('.staff-pill');
  const isMyClaim = pillBtn?.classList.contains('staff-pill--active');

  // 1. Gather current active staff from DOM
  let currentClaims = [];
  allPills?.forEach(p => {
    if (p.classList.contains('staff-pill--active')) {
      const name = p.textContent.replace(' ⚡', '').trim();
      if (name) currentClaims.push(name);
    }
  });

  // 2. Toggle current staff
  if (isMyClaim) {
    currentClaims = currentClaims.filter(n => n !== staffName);
  } else {
    if (!currentClaims.includes(staffName)) currentClaims.push(staffName);
  }

  const newClaimedBy = currentClaims.join(', ');

  try {
    const resp = await fetch(`/api/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimed_by: newClaimedBy,
        action_staff: staffName // Tell API who clicked
      }),
    });
    const data = await resp.json();

    if (data.ok) {
      // 3. Update UI on success
      if (isMyClaim) {
        pillBtn?.classList.remove('staff-pill--active');
        pillBtn.textContent = staffName;
      } else {
        pillBtn?.classList.add('staff-pill--active');
        pillBtn.textContent = staffName + ' ⚡';
      }

      const claimBadge = card?.querySelector('.claim-status-badge');
      if (currentClaims.length > 0) {
        card?.classList.add('lead-card--claimed');
        if (claimBadge) claimBadge.innerHTML = '👥 ' + currentClaims.join(', ');
      } else {
        card?.classList.remove('lead-card--claimed');
        if (claimBadge) claimBadge.innerHTML = ''; // hide badge if empty
      }

      showToast(`${isMyClaim ? 'Nhả' : 'Tiếp nhận'} lead thành công!`, 'success');
      loadAgentStats(); // Refresh header stats
    } else {
      showToast('Lỗi tiếp nhận lead', 'error');
    }
  } catch (err) {
    console.error('claimLead error:', err);
    showToast('Lỗi mạng', 'error');
  }
}

// ═══════════════════════════════════════════════════════
// Neural Response — Templates & Tone
// ═══════════════════════════════════════════════════════
const TEMPLATES = {
  quote: {
    friendly: 'Chào bạn! Em THG Logistics ở đây. Về nhu cầu của bạn, bên em có thể hỗ trợ báo giá chi tiết. Bạn cho em biết thêm về sản phẩm và số lượng nhé, em sẽ gửi bảng giá sớm nhất! 😊',
    professional: 'Kính gửi Anh/Chị,\n\nTHG Logistics xin gửi lời chào. Chúng tôi đã ghi nhận nhu cầu của Anh/Chị. Để báo giá chính xác, xin vui lòng cung cấp:\n- Loại sản phẩm\n- Số lượng\n- Điểm đến\n\nTrân trọng,\nTHG Logistics Team',
    concise: 'THG báo giá: Inbox em thông tin sản phẩm + SL, em gửi giá ngay ạ!',
  },
  fulfill: {
    friendly: 'Chào bạn! THG có dịch vụ fulfill chuyên nghiệp, hỗ trợ pick-pack-ship từ kho VN/US/EU. Bạn đang bán trên sàn nào, em tư vấn giải pháp phù hợp nhé! 🚀',
    professional: 'Kính gửi Anh/Chị,\n\nTHG Logistics cung cấp dịch vụ Fulfillment toàn diện:\n✅ Nhập kho & Quản lý tồn kho\n✅ Pick-Pack-Ship tự động\n✅ Tracking real-time\n\nXin liên hệ để được tư vấn.\nTrân trọng,\nTHG Logistics',
    concise: 'THG Fulfill: Kho VN/US/EU, pick-pack-ship tự động. Inbox để tư vấn!',
  },
  complaint: {
    friendly: 'Dạ em xin lỗi về sự bất tiện bạn đã gặp phải! Em sẽ kiểm tra và xử lý ngay cho bạn. Bạn gửi em mã đơn hoặc thông tin chi tiết nhé, em ưu tiên giải quyết sớm nhất! 🙏',
    professional: 'Kính gửi Anh/Chị,\n\nChúng tôi rất tiếc về sự cố này. Đội ngũ THG đã tiếp nhận và đang xử lý ưu tiên.\n\nXin Anh/Chị cung cấp mã vận đơn để chúng tôi truy xuất nhanh nhất.\n\nTrân trọng,\nBộ phận CSKH - THG Logistics',
    concise: 'Em ghi nhận và sẽ xử lý ngay. Gửi em mã đơn để kiểm tra ạ!',
  },
};

function fillTemplate(leadId, caseType) {
  const card = document.getElementById(`lead-${leadId}`);
  const tone = card?.dataset?.tone || 'friendly';
  const textarea = document.getElementById(`response-${leadId}`);
  if (textarea && TEMPLATES[caseType]?.[tone]) {
    textarea.value = TEMPLATES[caseType][tone];
    textarea.style.borderColor = '#22d3ee';
    setTimeout(() => { textarea.style.borderColor = ''; }, 1500);
  }
  // Highlight active template button
  const btns = card?.querySelectorAll('.template-btn');
  btns?.forEach(b => b.classList.remove('template-btn--active'));
  event?.target?.classList.add('template-btn--active');
}

function setTone(leadId, tone, btnEl) {
  const card = document.getElementById(`lead-${leadId}`);
  if (card) card.dataset.tone = tone;
  // Highlight active tone button
  const allTones = btnEl?.closest('.tone-selector')?.querySelectorAll('.tone-btn');
  allTones?.forEach(b => b.classList.remove('tone-btn--active'));
  btnEl?.classList.add('tone-btn--active');
  // Re-apply current template if one is active
  const activeTemplate = card?.querySelector('.template-btn--active');
  if (activeTemplate) activeTemplate.click();
}

// showToast is defined in utils.js — do not duplicate here


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
  setTimeout(loadClosingFeed, 1500);
  // Speed-to-Lead live updater (every 30s)
  setInterval(updateSpeedCounters, 30000);
});

// ═══════════════════════════════════════════════════════
// Close Deal Modal
// ═══════════════════════════════════════════════════════
function showCloseDealModal(leadId) {
  const STAFF = ['Trang', 'Min', 'Moon', 'Lê Huyền', 'Ngọc Huyền'];
  const card = document.getElementById(`lead-${leadId}`);
  const claimedBy = card?.querySelector('.staff-pill--claimed')?.textContent?.replace(' 🛡️', '') || '';

  const modal = document.createElement('div');
  modal.className = 'close-deal-overlay';
  modal.id = `close-modal-${leadId}`;
  modal.innerHTML = `
    <div class="close-deal-modal">
      <h3 style="margin:0 0 16px;color:#22d3ee;font-size:1.1rem;">🏆 Chốt Đơn — Lead #${leadId}</h3>
      <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px;">Người chốt đơn:</label>
      <select id="close-winner-${leadId}" class="close-deal-select">
        ${STAFF.map(s => `<option value="${s}" ${s === claimedBy ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px;">Giá trị đơn ($):</label>
      <input type="number" id="close-value-${leadId}" class="close-deal-input" placeholder="vd: 1500" min="0" step="50" />
      <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px;">Ghi chú:</label>
      <input type="text" id="close-note-${leadId}" class="close-deal-input" placeholder="vd: Khách đặt 200kg FF đi US" />
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="close-deal-confirm" onclick="closeDeal(${leadId})">🏆 Xác nhận</button>
        <button class="close-deal-cancel" onclick="document.getElementById('close-modal-${leadId}').remove()">Hủy</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function closeDeal(leadId) {
  const winner = document.getElementById(`close-winner-${leadId}`)?.value;
  const dealValue = parseFloat(document.getElementById(`close-value-${leadId}`)?.value) || 0;
  const note = document.getElementById(`close-note-${leadId}`)?.value || '';

  try {
    const resp = await fetch(`/api/leads/${leadId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner_staff: winner, deal_value: dealValue, note }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast(`🏆 ${winner} chốt đơn $${dealValue} thành công!`, 'success');
      document.getElementById(`close-modal-${leadId}`)?.remove();
      loadLeads();
      loadStats();
      loadClosingFeed();
    } else {
      showToast(data.error || 'Lỗi khi chốt đơn', 'error');
    }
  } catch (err) {
    showToast('❌ Lỗi khi chốt đơn', 'error');
  }
}

// ═══════════════════════════════════════════════════════
// Closing Feed — Victory Ticker
// ═══════════════════════════════════════════════════════
async function loadClosingFeed() {
  try {
    const res = await fetch('/api/activities/feed?limit=10');
    const { data } = await res.json();
    const ticker = document.getElementById('closingFeed');
    if (!ticker || !data || data.length === 0) {
      if (ticker) ticker.style.display = 'none';
      return;
    }
    ticker.style.display = '';
    const items = data.map(d => {
      const timeAgoStr = timeAgo(d.created_at);
      return `🏆 <strong>${d.staff_name}</strong> chốt $${d.deal_value || 0} ${d.category || ''} từ ${d.source_group || 'lead'} (${timeAgoStr})`;
    }).join('  •  ');
    ticker.innerHTML = `<div class="closing-feed-inner"><span class="closing-feed-text">${items}</span></div>`;
  } catch (err) { /* silently fail */ }
}

// ═══════════════════════════════════════════════════════
// Speed-to-Lead — Live Counter
// ═══════════════════════════════════════════════════════
function updateSpeedCounters() {
  document.querySelectorAll('.speed-counter').forEach(el => {
    const created = el.dataset?.created;
    if (!created) return;
    el.textContent = '⏱️ ' + timeAgo(created);
  });
}
