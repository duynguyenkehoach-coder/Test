// ═══════════════════════════════════════════════════════
//  agents.js — Personal Agent System Frontend Controller
// ═══════════════════════════════════════════════════════

const AGENT_COLORS = {
  'Trang': { hue: '#7c3aed', bg: 'rgba(124,58,237,0.12)', emoji: '💜' },
  'Min': { hue: '#2563eb', bg: 'rgba(37,99,235,0.12)', emoji: '💙' },
  'Moon': { hue: '#0891b2', bg: 'rgba(8,145,178,0.12)', emoji: '🩵' },
  'Lê Huyền': { hue: '#d97706', bg: 'rgba(217,119,6,0.12)', emoji: '🧡' },
  'Ngọc Huyền': { hue: '#059669', bg: 'rgba(5,150,105,0.12)', emoji: '💚' },
};

// ─── Load & render all agent cards ───────────────────────────────────────────
async function loadAgents(agentPerson, salesPerson) {
  const container = document.getElementById('agentCardsContainer');
  const masterStatus = document.getElementById('masterBrainStatus');
  const filterLabel = document.querySelector('#salesInboxTab .filter-bar label');
  if (!container) return;

  // Update heading
  if (filterLabel) {
    if (agentPerson) filterLabel.textContent = `🤖 Agent — ${agentPerson}`;
    else if (salesPerson) filterLabel.textContent = `💼 Sales Inbox — ${salesPerson}`;
    else filterLabel.textContent = '💼 Sales Inbox — Personal Agent System';
  }

  // Sales Inbox per-person view (future: FB Messenger threads)
  if (salesPerson) {
    const color = AGENT_COLORS[salesPerson] || { emoji: '💼' };
    container.innerHTML = `
            <div style="grid-column:1/-1;padding:60px 40px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;opacity:0.5">
                <div style="font-size:3.5rem">${color.emoji || '💼'}</div>
                <h3 style="margin:0;font-size:1.1rem">${salesPerson}</h3>
                <p style="font-size:0.85rem;margin:0;max-width:380px;line-height:1.7">
                    Khu vực Sales Inbox riêng của <strong>${salesPerson}</strong>.<br>
                    Khi kết nối Facebook Messenger API, tin nhắn từ leads được assign cho ${salesPerson} sẽ hiện ở đây.
                </p>
                <div style="margin-top:8px;font-size:0.78rem;padding:8px 16px;border-radius:6px;background:rgba(255,77,79,0.08);border:1px solid rgba(255,77,79,0.2);color:#ff7875">
                    Chờ kết nối <code>AUTO_REPLY_ENABLED=true</code> trong .env
                </div>
            </div>`;
    if (masterStatus) masterStatus.innerHTML = '';
    return;
  }

  container.innerHTML = '<div style="padding:40px;text-align:center;opacity:0.5">⏳ Đang tải...</div>';

  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    // Master Brain status
    if (masterStatus) {
      const ms = data.messenger_status;
      masterStatus.innerHTML = `
        <div class="mb-info-item">
          <span class="mb-info-label">Messenger API</span>
          <span class="mb-info-val ${ms.enabled ? 'mb-val-green' : 'mb-val-gray'}">${ms.enabled ? '🟢 Active' : '⚫ Disabled'}</span>
        </div>
        <div class="mb-info-item">
          <span class="mb-info-label">Page Token</span>
          <span class="mb-info-val ${ms.has_token ? 'mb-val-green' : 'mb-val-red'}">${ms.has_token ? '✅ Set' : '❌ Missing'}</span>
        </div>
        <div class="mb-info-item">
          <span class="mb-info-label">App Secret</span>
          <span class="mb-info-val ${ms.has_app_secret ? 'mb-val-green' : 'mb-val-red'}">${ms.has_app_secret ? '✅ Set' : '❌ Missing'}</span>
        </div>
      `;
    }

    // Render agent cards (all or single filtered)
    let profiles = data.data || [];
    if (agentPerson) profiles = profiles.filter(p => p.name === agentPerson);
    container.innerHTML = profiles.map(p => renderAgentCard(p)).join('');

    // If showing single agent, make card fill more space
    if (agentPerson) {
      container.style.gridTemplateColumns = '1fr';
      container.style.maxWidth = '540px';
      container.style.margin = '0 auto';
    } else {
      container.style.gridTemplateColumns = '';
      container.style.maxWidth = '';
      container.style.margin = '';
    }

  } catch (err) {
    container.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">⚠️ Lỗi: ${err.message}</div>`;
  }
}

// ─── Render single agent card HTML ───────────────────────────────────────────
function renderAgentCard(profile) {
  const color = AGENT_COLORS[profile.name] || { hue: '#64748b', bg: 'rgba(100,116,139,0.12)', emoji: '🤖' };
  const isTakeover = !!profile.takeover;
  const initials = profile.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const tones = [
    { id: 'friendly', label: '🤝 Nhiệt tình' },
    { id: 'professional', label: '👔 Chuyên nghiệp' },
    { id: 'concise', label: '⚡ Ngắn gọn' },
  ];

  return `
  <div class="agent-card ${isTakeover ? 'agent-card--takeover' : ''}" id="agentCard-${escapeId(profile.name)}" style="--agent-hue:${color.hue};--agent-bg:${color.bg}">
    <!-- Card header -->
    <div class="agent-card-header">
      <div class="agent-avatar" style="background:var(--agent-hue)">
        ${color.emoji}
      </div>
      <div class="agent-info">
        <div class="agent-name">${profile.name}</div>
        <div class="agent-status-badge ${isTakeover ? 'agent-status--takeover' : 'agent-status--ai'}">
          ${isTakeover ? '🔴 Take Over — AI im lặng' : '🟢 AI đang hoạt động'}
        </div>
      </div>
    </div>

    <!-- Tone selector -->
    <div class="agent-section-label">Phong cách trả lời</div>
    <div class="agent-tone-row" id="toneRow-${escapeId(profile.name)}">
      ${tones.map(t => `
        <button class="agent-tone-btn ${profile.tone === t.id ? 'agent-tone-btn--active' : ''}"
          onclick="setAgentTone('${profile.name}', '${t.id}', this)">
          ${t.label}
        </button>
      `).join('')}
    </div>

    <!-- Personal note -->
    <div class="agent-section-label">📝 Ghi chú riêng cho AI</div>
    <textarea class="agent-textarea" id="note-${escapeId(profile.name)}" rows="3"
      placeholder="VD: Nếu khách hỏi về ship US, nhấn mạnh kho Texas vì đang có deal tốt...">${profile.personal_note || ''}</textarea>

    <!-- Deals note -->
    <div class="agent-section-label">🎁 Ưu đãi riêng</div>
    <textarea class="agent-textarea" id="deals-${escapeId(profile.name)}" rows="2"
      placeholder="VD: Giảm 5% cho đơn đầu, free tư vấn setup kho...">${profile.deals_note || ''}</textarea>

    <!-- Action buttons -->
    <div class="agent-btn-row">
      <button class="agent-btn agent-btn-save" onclick="saveAgent('${profile.name}')">💾 Lưu</button>
      <div style="flex:1"></div>
      <button class="agent-takeover-btn ${isTakeover ? 'agent-takeover-btn--active' : ''}"
        onclick="toggleTakeover('${profile.name}', this)">
        ${isTakeover ? '🤚 Đang Take Over' : '🤖 AI Mode'}
      </button>
    </div>

    <!-- Save status -->
    <div class="agent-save-status" id="saveStatus-${escapeId(profile.name)}"></div>
  </div>`;
}

function escapeId(name) {
  return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

// ─── Set tone (UI-only, saved on click Save) ─────────────────────────────────
function setAgentTone(agentName, tone, btn) {
  const row = document.getElementById('toneRow-' + escapeId(agentName));
  if (!row) return;
  row.querySelectorAll('.agent-tone-btn').forEach(b => b.classList.remove('agent-tone-btn--active'));
  btn.classList.add('agent-tone-btn--active');
  btn.dataset.selected = tone;
}

// ─── Save agent profile ───────────────────────────────────────────────────────
async function saveAgent(agentName) {
  const id = escapeId(agentName);
  const toneBtn = document.querySelector(`#toneRow-${id} .agent-tone-btn--active`);
  const tone = toneBtn?.id?.replace('tone-', '') || toneBtn?.textContent?.trim() || null;
  // Get tone from data-id on button
  const toneEl = document.querySelector(`#toneRow-${id} .agent-tone-btn--active`);
  const toneValue = (() => {
    if (!toneEl) return 'friendly';
    const t = toneEl.getAttribute('onclick') || '';
    const m = t.match(/'(friendly|professional|concise)'/);
    return m ? m[1] : 'friendly';
  })();

  const personal_note = document.getElementById('note-' + id)?.value || '';
  const deals_note = document.getElementById('deals-' + id)?.value || '';
  const statusEl = document.getElementById('saveStatus-' + id);

  if (statusEl) statusEl.textContent = '⏳ Đang lưu...';

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tone: toneValue, personal_note, deals_note }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    if (statusEl) {
      statusEl.textContent = '✅ Đã lưu!';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ Lỗi: ' + err.message;
  }
}

// ─── Toggle Take Over ─────────────────────────────────────────────────────────
async function toggleTakeover(agentName, btn) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/takeover`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const isTakeover = !!data.takeover;
    const card = document.getElementById('agentCard-' + escapeId(agentName));
    const statusBadge = card?.querySelector('.agent-status-badge');

    if (card) card.classList.toggle('agent-card--takeover', isTakeover);
    if (statusBadge) {
      statusBadge.className = `agent-status-badge ${isTakeover ? 'agent-status--takeover' : 'agent-status--ai'}`;
      statusBadge.textContent = isTakeover ? '🔴 Take Over — AI im lặng' : '🟢 AI đang hoạt động';
    }
    if (btn) {
      btn.className = `agent-takeover-btn ${isTakeover ? 'agent-takeover-btn--active' : ''}`;
      btn.textContent = isTakeover ? '🤚 Đang Take Over' : '🤖 AI Mode';
    }
  } catch (err) {
    alert('Lỗi toggle Take Over: ' + err.message);
  }
}

// ─── Generate AI reply in agent's voice (from Closing Room) ──────────────────
async function generateAgentReply(agentName, leadId, targetTextareaId) {
  const textarea = document.getElementById(targetTextareaId);
  if (textarea) textarea.value = '⏳ AI đang viết...';

  try {
    const res = await fetch('/api/agents/generate-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: agentName, lead_id: leadId }),
    });
    const data = await res.json();
    if (!data.success) {
      if (data.takeover) {
        if (textarea) textarea.value = '🤚 Agent này đang ở chế độ Take Over — AI im lặng.';
        return;
      }
      throw new Error(data.error);
    }
    if (textarea) textarea.value = data.reply;
  } catch (err) {
    if (textarea) textarea.value = '❌ Lỗi: ' + err.message;
  }
}
