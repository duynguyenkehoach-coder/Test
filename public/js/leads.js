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
    grid.innerHTML = `<div class="ant-empty"><div class="ant-empty-icon">🔍</div><div class="ant-empty-text">Chưa có leads</div><div class="ant-empty-sub">Hãy chạy scan hoặc chọn mục khác</div></div>`;
    return;
  }

  const filterDate = document.getElementById('filterDate')?.value || '';
  const filterTime = document.getElementById('filterTime')?.value || '';
  const currentCat = AppState.currentCategory || '';
  console.log('[THG] renderLeadsList:', leadsArray.length, 'in, cat:', currentCat, ', gridId:', gridId);


  const isVietnamese = (text) => {
    if (!text) return false;
    return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
  };

  const filteredLeads = leadsArray.filter(lead => {
    if (gridId === 'ignoredGrid') return true;

    if (currentCat && currentCat !== 'All' && currentCat !== 'Foreign-All' && currentCat !== 'Viet-All') {
      let svcCat = currentCat;
      const isViet = isVietnamese(lead.content || '');

      // Handle Geography Split
      if (currentCat.startsWith('Foreign-')) {
        if (isViet) return false;
        svcCat = currentCat.replace('Foreign-', '');
      } else if (currentCat.startsWith('Viet-')) {
        if (!isViet) return false;
        svcCat = currentCat.replace('Viet-', '');
      }

      if (svcCat !== 'All') {
        const cat = lead.category || '';
        if (svcCat === 'THG Fulfillment' || svcCat === 'Fulfill') {
          if (!['THG Fulfillment', 'Fulfillment', 'POD', 'Dropship', 'THG Fulfill'].includes(cat)) return false;
        } else if (svcCat === 'THG Express' || svcCat === 'Express') {
          if (cat !== 'Express' && cat !== 'THG Express') return false;
        } else if (svcCat === 'THG Warehouse' || svcCat === 'Warehouse') {
          if (cat !== 'Warehouse' && cat !== 'THG Warehouse') return false;
        } else if (svcCat === 'General') {
          if (!['General', 'NotRelevant', ''].includes(cat)) return false;
        } else {
          if (!cat.toLowerCase().includes(svcCat.toLowerCase())) return false;
        }
      }
    } else if (currentCat === 'Foreign-All') {
      if (isVietnamese(lead.content || '')) return false;
    } else if (currentCat === 'Viet-All') {
      if (!isVietnamese(lead.content || '')) return false;
    }

    if (!filterDate && !filterTime) return true;
    const dt = getPostDate(lead);
    const d = dt.toLocaleDateString('sv-SE');
    const h = String(dt.getHours()).padStart(2, '0');
    if (filterDate && d !== filterDate) return false;
    if (filterTime && `${h}:00` !== filterTime) return false;
    return true;
  });

  if (filteredLeads.length === 0) {
    grid.innerHTML = `<div class="ant-empty"><div class="ant-empty-icon">🔍</div><div class="ant-empty-text">Không có leads khớp filter</div><div class="ant-empty-sub">Thử thay đổi bộ lọc hoặc chọn All Leads</div></div>`;
    return;
  }

  const rows = filteredLeads.map(lead => {
    try { return renderLeadTableRow(lead, gridId); } catch (e) { console.error(e); return ''; }
  }).join('');

  grid.innerHTML = `
    <div class="ant-table-wrapper">
      <table class="ant-table">
        <thead class="ant-table-thead">
          <tr>
            <th class="ant-th" style="width:90px">Score</th>
            <th class="ant-th" style="width:100px">Platform</th>
            <th class="ant-th" style="width:140px">Seller</th>
            <th class="ant-th">Summary / Opportunity</th>
            <th class="ant-th" style="width:100px">Service</th>
            <th class="ant-th" style="width:90px">Status</th>
            <th class="ant-th" style="width:80px">Time</th>
            <th class="ant-th" style="width:80px">Action</th>
          </tr>
        </thead>
        <tbody class="ant-table-tbody">${rows}</tbody>
      </table>
    </div>
  `;
}

function renderLeadTableRow(lead, gridId) {
  const score = lead.score || 0;
  const scoreClass = score >= 80 ? 'score-tag-high' : score >= 60 ? 'score-tag-med' : 'score-tag-low';
  const scoreLabel = score >= 80 ? '🔥 HOT' : score >= 60 ? '⚡ WARM' : '💤 LOW';

  const platformMap = {
    facebook: { icon: '📘', label: 'Facebook', color: '#1877f2' },
    instagram: { icon: '📷', label: 'Instagram', color: '#e1306c' },
    tiktok: { icon: '🎵', label: 'TikTok', color: '#ff0050' },
  };
  const platform = platformMap[lead.platform] || { icon: '🌐', label: lead.platform || 'Web', color: '#8c8c8c' };

  const categoryMap = {
    'THG Fulfillment': { label: 'Fulfill', color: '#722ed1' },
    'Fulfillment': { label: 'Fulfill', color: '#722ed1' },
    'POD': { label: 'POD', color: '#722ed1' },
    'Dropship': { label: 'Dropship', color: '#722ed1' },
    'THG Express': { label: 'Express', color: '#1890ff' },
    'Express': { label: 'Express', color: '#1890ff' },
    'THG Warehouse': { label: 'Warehouse', color: '#fa8c16' },
    'Warehouse': { label: 'Warehouse', color: '#fa8c16' },
  };
  const catInfo = categoryMap[lead.category] || { label: lead.category || 'General', color: '#8c8c8c' };

  const statusMap = {
    'new': { label: '● New', color: '#52c41a', bg: 'rgba(82,196,26,0.1)' },
    'contacted': { label: '● Contacted', color: '#faad14', bg: 'rgba(250,173,20,0.1)' },
    'converted': { label: '● Converted', color: '#1890ff', bg: 'rgba(24,144,255,0.1)' },
    'ignored': { label: '● Ignored', color: '#ff4d4f', bg: 'rgba(255,77,79,0.1)' },
  };
  const status = statusMap[lead.status] || statusMap['new'];

  const author = escapeHtml(lead.author_name || 'Unknown');

  // ── Smart summary: skip trivial values like "có", pick first meaningful text ──
  const TRIVIAL = /^(có|co|yes|ok|oke|không|khong|no|na|\.+|-+)$/i;
  const rawSummary = [lead.gap_opportunity, lead.summary, lead.content]
    .map(s => (s || '').trim())
    .find(s => s.length > 8 && !TRIVIAL.test(s)) || '';
  const summary = escapeHtml(rawSummary.substring(0, 140));
  const summaryDisplay = summary
    ? summary
    : '<em style="opacity:0.38;font-style:italic;font-size:0.78rem">Chưa có tóm tắt</em>';

  const dt = getPostDate(lead);
  const dateLabel = dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  const timeLabel = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');

  const isClaimed = !!(lead.claimed_by || lead.assigned_to);
  const urgencyDot = lead.urgency === 'critical'
    ? '<span class="urgency-dot urgency-critical" title="Critical"></span>'
    : lead.urgency === 'high'
      ? '<span class="urgency-dot urgency-high" title="High urgency"></span>'
      : '';

  // ── Platform cell: type-aware (post vs comment) ──
  const rawPostUrl = lead.post_url || '';
  const rawAuthorUrl = lead.author_url || '';
  const isComment = (lead.item_type === 'comment');

  // For comments: show 💬 icon in amber; for posts: show platform emoji in brand color
  const linkIcon = isComment ? '💬' : platform.icon;
  const linkLabel = isComment ? 'Comment' : platform.label;
  const linkColor = isComment ? '#f59e0b' : platform.color;
  const linkTitle = isComment
    ? `💬 Comment trên bài post ${platform.label} — Click để xem bài viết gốc`
    : `🔗 Xem bài đăng ${platform.label}`;

  const postIconEl = rawPostUrl
    ? `<a href="${rawPostUrl}" target="_blank" rel="noopener noreferrer" title="${linkTitle}" style="text-decoration:none;font-size:1.2rem;line-height:1;display:block">${linkIcon}</a>`
    : `<span style="font-size:1.2rem;opacity:0.5" title="Không có link">${linkIcon}</span>`;

  // ── Seller cell: name → author profile link ──
  const sellerEl = rawAuthorUrl
    ? `<a href="${rawAuthorUrl}" target="_blank" rel="noopener noreferrer" title="👤 Xem profile người đăng" class="author-name author-link-cell">${author}</a>`
    : `<span class="author-name">${author}</span>`;

  return `
    <tr class="ant-tr${isClaimed ? ' ant-tr-claimed' : ''}${score >= 80 ? ' hot-lead-row' : ''}" onclick="openLeadDetail(${lead.id})" title="Click to open The Closing Room">
      <td class="ant-td" style="text-align:center">
        <div class="score-tag ${scoreClass}">
          <span class="score-num">${score}</span>
          <span class="score-lbl">${scoreLabel}</span>
        </div>
      </td>
      <td class="ant-td" style="text-align:center" onclick="event.stopPropagation()">
        <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
          ${postIconEl}
          <span style="color:${linkColor};font-weight:600;font-size:0.76rem;letter-spacing:0.02em">${linkLabel}</span>
        </div>
      </td>
      <td class="ant-td" onclick="event.stopPropagation()">
        <div class="author-cell">
          ${urgencyDot}
          ${sellerEl}
          ${isClaimed ? '<span class="claimed-badge" title="Being handled">⚡</span>' : ''}
        </div>
      </td>
      <td class="ant-td">
        <div class="summary-cell">${summaryDisplay}</div>
      </td>
      <td class="ant-td" onclick="event.stopPropagation()">
        <div class="cat-toggle-group">
          <button class="cat-toggle-btn${catInfo.label === 'Fulfill' ? ' cat-active' : ''}" style="--cat-color:#722ed1" onclick="updateCategory(${lead.id},'THG Fulfillment')" title="Fulfillment / POD / Dropship">Fulfill</button>
          <button class="cat-toggle-btn${catInfo.label === 'Express' ? ' cat-active' : ''}" style="--cat-color:#1890ff" onclick="updateCategory(${lead.id},'THG Express')" title="Express Shipping">Express</button>
          <button class="cat-toggle-btn${catInfo.label === 'Warehouse' ? ' cat-active' : ''}" style="--cat-color:#fa8c16" onclick="updateCategory(${lead.id},'THG Warehouse')" title="Warehouse Storage">WH</button>
        </div>
      </td>
      <td class="ant-td">
        <span class="status-tag" style="color:${status.color};background:${status.bg}">${status.label}</span>
      </td>
      <td class="ant-td" style="font-size:0.78rem;color:var(--text-secondary);line-height:1.4">
        <div>${dateLabel}</div>
        <div>${timeLabel}</div>
      </td>
      <td class="ant-td" onclick="event.stopPropagation()">
        <button class="ant-btn-view" onclick="openLeadDetail(${lead.id})">View →</button>
      </td>
    </tr>
  `;
}

// ═══ MASTER-DETAIL VIEW LOGIC ═══

function renderCompactLeadCard(lead) {
  return renderLeadTableRow(lead, 'leadsGrid');
}


async function openLeadDetail(leadId) {
  let lead = AppState.leads.find(l => l.id === leadId) || AppState.ignoredLeads.find(l => l.id === leadId);
  if (!lead) return;

  // Fetch full details (includes 'content' and 'original_post' which are omitted from list view for speed)
  const fullData = await loadLeadById(leadId);
  if (fullData) {
    // Merge full data into the existing dashboard object
    Object.assign(lead, fullData);
  }

  document.getElementById('leadsMainView').style.display = 'none';
  const detailView = document.getElementById('leadDetailView');
  detailView.style.display = 'block';
  detailView.innerHTML = renderClosingRoom(lead);
}

function renderClosingRoom(lead) {
  const score = lead.score || 0;
  const scoreClass = score >= 80 ? 'score-tag-high' : score >= 60 ? 'score-tag-med' : 'score-tag-low';
  const hotLabel = score >= 80 ? '🔥 HOT' : score >= 60 ? '⚡ WARM' : '💤 COLD';
  const hotColor = score >= 80 ? '#ff4d4f' : score >= 60 ? '#faad14' : '#8c8c8c';

  const platformMap = { facebook: { icon: '📘', label: 'Facebook', color: '#4096ff' }, instagram: { icon: '📷', label: 'Instagram', color: '#e1306c' }, tiktok: { icon: '🎵', label: 'TikTok', color: '#ff0050' } };
  const platform = platformMap[lead.platform] || { icon: '🌐', label: lead.platform || 'Web', color: '#8c8c8c' };

  const categoryMap = { 'THG Fulfillment': { label: 'Fulfill', color: '#722ed1' }, 'Fulfillment': { label: 'Fulfill', color: '#722ed1' }, 'THG Express': { label: 'Express', color: '#1890ff' }, 'Express': { label: 'Express', color: '#1890ff' }, 'THG Warehouse': { label: 'Warehouse', color: '#fa8c16' }, 'Warehouse': { label: 'Warehouse', color: '#fa8c16' } };
  const catInfo = categoryMap[lead.category] || { label: lead.category || 'General', color: '#8c8c8c' };

  const statusMap = { 'new': { label: '● New', color: '#52c41a', bg: 'rgba(82,196,26,0.1)' }, 'contacted': { label: '● Contacted', color: '#faad14', bg: 'rgba(250,173,20,0.1)' }, 'converted': { label: '● Converted', color: '#1890ff', bg: 'rgba(24,144,255,0.1)' }, 'ignored': { label: '● Ignored', color: '#ff4d4f', bg: 'rgba(255,77,79,0.1)' } };
  const status = statusMap[lead.status] || statusMap['new'];

  const author = escapeHtml(lead.author_name || 'Unknown');

  // Clean raw scraped content
  let rawContent = lead.content || '—';
  if (lead.platform === 'facebook') {
    rawContent = rawContent.replace(/(Facebook\n)+/gi, ''); // remove facebook watermark
    let bulletIdx = rawContent.indexOf('·\n');
    if (bulletIdx === -1) bulletIdx = rawContent.indexOf('· \n'); // some browsers add space
    if (bulletIdx !== -1 && bulletIdx < 500) {
      rawContent = rawContent.substring(bulletIdx + 2);
    }
    const stops = ['Like\nComment', 'Thích\nBình luận', 'Tất cả cảm xúc:', 'All reactions:'];
    for (const s of stops) {
      const idx = rawContent.indexOf(s);
      if (idx !== -1) rawContent = rawContent.substring(0, idx);
    }
    // Remove isolated "+ number" before reactions often found
    rawContent = rawContent.replace(/\+\d+\n$/, '');
  }
  const content = escapeHtml(rawContent.trim() || '—');

  const summary = escapeHtml(lead.summary || '');
  const gap = escapeHtml(lead.gap_opportunity || '');
  const postDateStr = lead.post_created_at || lead.scraped_at || lead.created_at;
  const timeLabel = timeAgo(postDateStr);
  const dt = getPostDate(lead);
  const fullDate = dt.toLocaleString('vi-VN');

  // Staff pills
  const STAFF = ['Trang', 'Min', 'Moon', 'Lê Huyền', 'Ngọc Huyền'];
  const claimedByArr = (lead.claimed_by || lead.assigned_to || '').split(',').map(s => s.trim()).filter(Boolean);
  const isClaimed = claimedByArr.length > 0;

  const staffPills = STAFF.map(name => {
    const isMe = claimedByArr.includes(name);
    return `<button class="cr-staff-pill ${isMe ? 'cr-staff-pill--active' : ''}" onclick="claimLead(${lead.id},'${name}',this)" title="${isMe ? 'Nhả lead' : 'Claim lead'}">${name}${isMe ? ' ✓' : ''}</button>`;
  }).join('');

  const winnerSection = lead.winner_staff
    ? `<div class="cr-winner">🏆 <strong>${escapeHtml(lead.winner_staff)}</strong> đã chốt — $${lead.deal_value || 0}</div>`
    : `<button class="cr-deal-btn" onclick="showCloseDealModal(${lead.id})">🏆 BÁO CÁO CHỐT ĐƠN</button>`;

  const urgencyBadge = lead.urgency === 'critical'
    ? `<span class="cr-badge cr-badge--red">🚨 Critical</span>`
    : lead.urgency === 'high'
      ? `<span class="cr-badge cr-badge--orange">⚡ Cần gấp</span>` : '';

  const sentimentBadge = score >= 90 ? `<span class="cr-badge cr-badge--purple">😤 Frustrated</span>`
    : score >= 85 ? `<span class="cr-badge cr-badge--gold">💎 VIP</span>` : '';

  return `
  <div class="cr-wrapper">
    <!-- Breadcrumb bar -->
    <div class="cr-topbar">
      <button class="cr-back-btn" onclick="closeLeadDetail()">← Quay lại</button>
      <div class="cr-breadcrumb">
        <span>Leads</span><span class="cr-breadcrumb-sep">›</span>
        <span style="color:var(--text-primary)">${author}</span>
      </div>
      <div class="cr-topbar-title">🎯 The Closing Room</div>
      <div class="cr-topbar-actions">
        ${lead.post_url ? `<a href="${lead.post_url}" target="_blank" class="cr-icon-btn" title="${lead.item_type === 'comment' ? 'Xem comment gốc' : 'Xem post gốc'}">${lead.item_type === 'comment' ? '💬 Comment' : '🔗 Post'}</a>` : ''}
        ${lead.author_url ? `<a href="${lead.author_url}" target="_blank" class="cr-icon-btn" title="Xem profile">👤 Profile</a>` : ''}
      </div>
    </div>

    <!-- Main two-column layout -->
    <div class="cr-body">

      <!-- LEFT: Lead info + content -->
      <div class="cr-left">

        <!-- Info card -->
        <div class="cr-card">
          <div class="cr-card-header">
            <div class="cr-author-row">
              ${lead.author_avatar ? `<img src="${lead.author_avatar}" class="cr-avatar" onerror="this.style.display='none'">` : '<div class="cr-avatar-placeholder">👤</div>'}
              <div>
                <div class="cr-author-name">
                  ${lead.author_url ? `<a href="${lead.author_url}" target="_blank" class="cr-author-link">${author}</a>` : author}
                </div>
                <div class="cr-meta-row">
                  <span style="color:${platform.color};font-size:0.8rem;font-weight:600">${platform.icon} ${platform.label}</span>
                  <span class="cr-dot">·</span>
                  <span class="cr-time">${fullDate}</span>
                  <span class="cr-dot">·</span>
                  <span class="cr-time">${timeLabel}</span>
                </div>
              </div>
            </div>
            <div class="cr-tag-row">
              <span class="category-tag" style="color:${catInfo.color};border-color:${catInfo.color}55;background:${catInfo.color}18">${catInfo.label}</span>
              <span class="status-tag" style="color:${status.color};background:${status.bg}">${status.label}</span>
              ${urgencyBadge}${sentimentBadge}
            </div>
          </div>
        </div>

        <!-- Raw content card -->
        <div class="cr-card">
          <div class="cr-section-title">📄 Nội dung gốc</div>
          <div class="cr-content-box" id="content-${lead.id}" style="white-space: pre-wrap;">${content}</div>
          <button class="cr-expand-btn" onclick="toggleContent(${lead.id})">Xem thêm ▼</button>
        </div>

        <!-- AI Analysis card -->
        ${summary || gap ? `
        <div class="cr-card">
          <div class="cr-section-title">🧠 AI Analysis</div>
          ${summary ? `
          <div class="cr-info-block">
            <div class="cr-info-label">💡 Tóm tắt</div>
            <div class="cr-info-content">${summary}</div>
          </div>` : ''}
          ${gap ? `
          <div class="cr-info-block" style="margin-top:10px">
            <div class="cr-info-label">🔍 Cơ hội (Gap)</div>
            <div class="cr-info-content cr-gap-text">${gap}</div>
          </div>` : ''}
          ${lead.buyer_signals ? `
          <div class="cr-info-block" style="margin-top:10px">
            <div class="cr-info-label">🎯 Buyer Signals</div>
            <div class="cr-info-content">${escapeHtml(lead.buyer_signals)}</div>
          </div>` : ''}
          ${lead.profit_estimate ? `
          <div class="cr-profit-box">
            <div class="cr-profit-label">KỲ VỌNG DOANH THU</div>
            <div class="cr-profit-value">💰 ${escapeHtml(lead.profit_estimate)}</div>
          </div>` : ''}
        </div>` : ''}

        <!-- Response / Notes / Agent tabs -->
        <div class="cr-card">
          <div class="cr-tabs">
            <button class="cr-tab cr-tab--active" onclick="switchLeadTab(${lead.id},'response',this)">💬 Response</button>
            <button class="cr-tab" onclick="switchLeadTab(${lead.id},'notes',this)">📝 Notes</button>
            <button class="cr-tab" onclick="switchLeadTab(${lead.id},'agent',this)">🧠 Agent</button>
          </div>

          <!-- Response tab -->
          <div class="cr-tab-panel" id="tab-response-${lead.id}">
            <div class="cr-template-row">
              <button class="cr-template-btn" onclick="fillTemplate(${lead.id},'quote')">📋 Báo giá</button>
              <button class="cr-template-btn" onclick="fillTemplate(${lead.id},'fulfill')">🏭 Kho/FF</button>
              <button class="cr-template-btn" onclick="fillTemplate(${lead.id},'complaint')">🛡️ Khiếu nại</button>
              <div class="cr-tone-sep"></div>
              <button class="cr-tone-btn cr-tone-btn--active" onclick="setTone(${lead.id},'friendly',this)">🤝 Thân thiện</button>
              <button class="cr-tone-btn" onclick="setTone(${lead.id},'professional',this)">👔 Pro</button>
              <button class="cr-tone-btn" onclick="setTone(${lead.id},'concise',this)">⚡ Ngắn</button>
            </div>
            <textarea class="cr-textarea" id="response-${lead.id}" rows="4">${lead.suggested_response || ''}</textarea>
            <div class="cr-btn-row">
              <button class="cr-btn cr-btn-secondary" onclick="copyResponse(${lead.id})">📋 Copy</button>
              <button class="cr-btn cr-btn-secondary" onclick="saveResponse(${lead.id})">💾 Save</button>
            </div>
          </div>

          <!-- Notes tab -->
          <div class="cr-tab-panel" id="tab-notes-${lead.id}" style="display:none">
            <textarea class="cr-textarea" id="notes-${lead.id}" rows="4" placeholder="Ghi chú: giá đã báo, deal progress, follow-up date...">${lead.notes || ''}</textarea>
            <div class="cr-btn-row">
              <button class="cr-btn cr-btn-secondary" onclick="saveNotes(${lead.id})">💾 Lưu ghi chú</button>
            </div>
          </div>

          <!-- Agent tab -->
          <div class="cr-tab-panel" id="tab-agent-${lead.id}" style="display:none">
            <div class="cr-feedback-row">
              <button class="cr-feedback-tag" onclick="quickFeedback(${lead.id},'correct',null,'✅ Đúng — buyer xác nhận')">✅ Đúng</button>
              <button class="cr-feedback-tag" onclick="quickFeedback(${lead.id},'wrong','provider','❌ Sai — provider')">❌ Sai→Provider</button>
              <button class="cr-feedback-tag" onclick="insertTag(${lead.id},'⬆️ Score nên cao hơn, khoảng ')">⬆️ Nâng score</button>
              <button class="cr-feedback-tag" onclick="insertTag(${lead.id},'⬇️ Score nên thấp hơn, khoảng ')">⬇️ Giảm score</button>
            </div>
            <span class="cr-feedback-status" id="feedback-status-${lead.id}"></span>
            <textarea class="cr-textarea" id="feedback-text-${lead.id}" rows="3" placeholder="Ghi chú thêm cho Agent..."></textarea>
            <div class="cr-btn-row">
              <button class="cr-btn cr-btn-primary" onclick="sendFeedback(${lead.id})">📤 Gửi feedback</button>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Action panel -->
      <div class="cr-right">

        <!-- Score card -->
        <div class="cr-card cr-score-card">
          <div class="cr-score-big score-tag ${scoreClass}">
            <span class="score-num">${score}</span>
            <span class="score-lbl">${hotLabel}</span>
          </div>
          <div class="cr-score-bar-wrap">
            <div class="cr-score-bar" style="width:${score}%;background:${hotColor}"></div>
          </div>
          <div class="cr-score-sub" style="color:${hotColor}">Lead Score</div>
          ${lead.pain_score > 0 ? `<div class="cr-meta-pill">⚡ Pain Score: ${lead.pain_score}</div>` : ''}
          ${lead.spam_score > 0 ? `<div class="cr-meta-pill cr-meta-pill--warn">🚨 Spam Signal: ${lead.spam_score}</div>` : ''}
        </div>

        <!-- Status actions -->
        <div class="cr-card">
          <div class="cr-section-title">⚡ Quick Actions</div>
          <div class="cr-action-grid">
            <button class="cr-action-btn cr-action-blue ${lead.status === 'contacted' ? 'cr-action-btn--active' : ''}" onclick="contactLead(${lead.id})">📞 Contacted</button>
            <button class="cr-action-btn cr-action-green ${lead.status === 'converted' ? 'cr-action-btn--active' : ''}" onclick="convertLead(${lead.id})">✅ Converted</button>
            <button class="cr-action-btn cr-action-red ${lead.status === 'ignored' ? 'cr-action-btn--active' : ''}" onclick="updateStatus(${lead.id},'ignored')">⛔ Ignore</button>
            <button class="cr-action-btn cr-action-danger" onclick="deleteLead(${lead.id})">🗑️ Delete</button>
          </div>
        </div>

        <!-- Deal section -->
        <div class="cr-card">
          <div class="cr-section-title">🏆 Deal</div>
          ${winnerSection}
        </div>

        <!-- Staff assignment -->
        <div class="cr-card">
          <div class="cr-section-title">👥 Phân công Sale</div>
          <div class="cr-staff-grid">${staffPills}</div>
          ${isClaimed ? `<div class="cr-claimed-by">Đang xử lý: <strong>${claimedByArr.join(', ')}</strong></div>` : '<div class="cr-claimed-by" style="opacity:0.5">Chưa có sale nào claim</div>'}
        </div>

        <!-- Lead metadata -->
        <div class="cr-card">
          <div class="cr-section-title">📋 Lead Info</div>
          <div class="cr-meta-list">
            <div class="cr-meta-item"><span class="cr-meta-key">ID</span><span class="cr-meta-val">#${lead.id}</span></div>
            <div class="cr-meta-item"><span class="cr-meta-key">Platform</span><span class="cr-meta-val" style="color:${platform.color}">${platform.icon} ${platform.label}</span></div>
            <div class="cr-meta-item"><span class="cr-meta-key">Service</span><span class="cr-meta-val"><span class="category-tag" style="color:${catInfo.color};border-color:${catInfo.color}55;background:${catInfo.color}18;font-size:0.72rem">${catInfo.label}</span></span></div>
            <div class="cr-meta-item"><span class="cr-meta-key">Status</span><span class="cr-meta-val"><span class="status-tag" style="color:${status.color};background:${status.bg};font-size:0.72rem">${status.label}</span></span></div>
            <div class="cr-meta-item"><span class="cr-meta-key">Urgency</span><span class="cr-meta-val">${lead.urgency || '—'}</span></div>
            <div class="cr-meta-item"><span class="cr-meta-key">Scraped</span><span class="cr-meta-val">${timeLabel}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `;
}



function closeLeadDetail() {
  const detailView = document.getElementById('leadDetailView');
  const mainView = document.getElementById('leadsMainView');
  detailView.style.display = 'none';
  mainView.style.display = 'block';
  detailView.innerHTML = '';
  // Scroll to top of leads table for clean re-entry
  mainView.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    if (panel) {
      panel.style.display = t === tab ? '' : 'none';
      if (t === tab) panel.style.opacity = '1';
    }
  });
  if (btnEl) {
    // Support both inline card tabs (.lead-tab) and Closing Room tabs (.cr-tab)
    const container = btnEl.closest('.lead-tabs') || btnEl.closest('.cr-tabs');
    if (container) {
      container.querySelectorAll('.lead-tab, .cr-tab').forEach(b => {
        b.classList.remove('lead-tab--active', 'cr-tab--active');
      });
    }
    btnEl.classList.add(
      btnEl.classList.contains('cr-tab') ? 'cr-tab--active' : 'lead-tab--active'
    );
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

      // ─── AWARD POINTS to Leaderboard ─────────────────────────
      // 100 base pts for closing + bonus from deal value
      const basePoints = 100;
      try {
        await fetch('/api/points/award', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sales_name: winner,
            action_type: 'CLOSE_DEAL',
            points: basePoints,
            deal_value: dealValue,
            lead_id: leadId,
            note: note || `Chốt đơn $${dealValue} từ Lead #${leadId}`,
          }),
        });
        // Show ticker notification (if leaderboard.js is loaded)
        if (typeof showTickerToast === 'function') {
          showTickerToast({
            id: Date.now(),
            sales_name: winner,
            action_type: 'CLOSE_DEAL',
            points: basePoints,
            deal_value: dealValue,
            note: note || `Chốt $${dealValue}`,
            created_at: new Date().toISOString(),
          });
        }
        // Refresh leaderboard if tab is open
        const lbTab = document.getElementById('leaderboardTab');
        if (lbTab && lbTab.style.display !== 'none' && typeof loadLeaderboard === 'function') {
          setTimeout(loadLeaderboard, 800);
        }

      } catch (ptErr) {
        console.warn('[Points] Award failed silently:', ptErr.message);
      }
      // ─────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════
// ANT DESIGN SIDEBAR NAVIGATION
// ═══════════════════════════════════════════════════════
// ANT DESIGN SIDEBAR NAVIGATION
// ═══════════════════════════════════════════════════════

function toggleNavGroup(groupId) {
  const group = document.getElementById(`navGroup${groupId.charAt(0).toUpperCase() + groupId.slice(1)}`);
  if (!group) return;
  group.classList.toggle('collapsed');
}

function filterByMenu(category, btnEl) {
  // 1. Clear all active states across the full sidebar
  document.querySelectorAll('.nav-item, .nav-sub-item, .nav-item-header').forEach(el => el.classList.remove('active'));

  // 2. Set active on the clicked element + its parent header
  if (btnEl) {
    btnEl.classList.add('active');
    const groupHeader = btnEl.closest('.nav-item-group')?.querySelector('.nav-item-header');
    if (groupHeader) groupHeader.classList.add('active');
  }

  // 3. Set category + clear stale search/date filters
  AppState.currentCategory = category === 'All' ? '' : category;
  AppState.currentTab = 'leads';

  // Clear search & date so previous filter doesn't block new category results
  const searchEl = document.getElementById('filterSearch');
  const dateEl = document.getElementById('filterDate');
  const timeEl = document.getElementById('filterTime');
  if (searchEl) searchEl.value = '';
  if (dateEl) dateEl.value = '';
  if (timeEl) timeEl.value = '';

  // 4. Show leadsTab, hide ALL other tabs (fixes: switching from Analytics/Data to leads)
  const allTabDivs = ['leadsTab', 'inboxTab', 'dataTab', 'analyticsTab', 'creditsTab', 'ignoredTab', 'groupsTab'];
  allTabDivs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const leadsTabEl = document.getElementById('leadsTab');
  const leadsMainView = document.getElementById('leadsMainView');
  if (leadsTabEl) leadsTabEl.style.display = 'block';
  if (leadsMainView) leadsMainView.style.display = 'block';

  // 5. Restore stats bar
  const statsBar = document.getElementById('statsBar');
  if (statsBar) { statsBar.style.opacity = '1'; statsBar.style.pointerEvents = 'auto'; }

  // 6. Render instantly from cache if data exists, then refresh in background
  if (AppState.leads && AppState.leads.length > 0) {
    renderLeads(); // instant UI update from cache
    loadLeads();   // background refresh to get filtered data from API
  } else {
    loadLeads();   // first load — must fetch
  }
}

