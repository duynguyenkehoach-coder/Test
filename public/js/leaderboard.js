// ═══════════════════════════════════════════════════════════════
//  leaderboard.js — Gamification Leaderboard Frontend Controller
// ═══════════════════════════════════════════════════════════════

const RANK_CONFIG = {
  HUNTER: { label: 'HUNTER', color: '#ff4d6d', glow: 'rgba(255,77,109,0.3)', emoji: '🏹', min: 3000 },
  LEGEND: { label: 'LEGEND', color: '#f59e0b', glow: 'rgba(245,158,11,0.3)', emoji: '🌟', min: 1500 },
  ELITE: { label: 'ELITE', color: '#818cf8', glow: 'rgba(129,140,248,0.3)', emoji: '💎', min: 500 },
  ROOKIE: { label: 'ROOKIE', color: '#64748b', glow: 'rgba(100,116,139,0.2)', emoji: '🌱', min: 0 },
};

const ACTION_CONFIG = {
  CLOSE_DEAL: { icon: '🔥', label: 'CHỐT ĐƠN', color: '#f59e0b' },
  QUALIFY: { icon: '✅', label: 'QUALIFY LEAD', color: '#52c41a' },
  FAST_RESPONSE: { icon: '⚡', label: 'PHẢN HỒI NHANH', color: '#818cf8' },
  BONUS: { icon: '🏹', label: 'BONUS', color: '#ff4d6d' },
  DAILY_QUEST: { icon: '📋', label: 'DAILY QUEST', color: '#0ea5e9' },
};

// last known leaderboard snapshot for live ticker comparison
let _lastLogId = 0;

// ─── Load & render leaderboard ────────────────────────────────────────────────
async function loadLeaderboard() {
  const wrap = document.getElementById('leaderboardWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:60px;text-align:center;opacity:0.4">⏳ Loading...</div>';

  try {
    const res = await fetch('/api/leaderboard');

    // If server hasn't restarted yet, it may return HTML 404 instead of JSON
    if (!res.ok) {
      const text = await res.text();
      const isHtml = text.trim().startsWith('<');
      wrap.innerHTML = `
        <div style="padding:60px 40px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px">
          <div style="font-size:3rem">🔄</div>
          <h3 style="margin:0;color:#f59e0b">Cần restart server</h3>
          <p style="font-size:0.85rem;opacity:0.6;max-width:360px;line-height:1.7;margin:0">
            Server chưa được restart sau khi code được cập nhật.<br>
            ${isHtml ? `<code style="font-size:0.75rem;color:#ff7875">HTTP ${res.status} — route /api/leaderboard chưa load</code><br><br>` : ''}
            Hãy restart server bằng <code>npm run dev</code> hoặc tắt và bật lại process.
          </p>
          <button onclick="loadLeaderboard()" style="margin-top:8px;padding:8px 20px;border-radius:8px;border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.1);color:#f59e0b;cursor:pointer">
            🔄 Thử lại
          </button>
        </div>`;
      return;
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const { rankings, recentLog } = data.data;
    if (_lastLogId === 0 && recentLog.length) _lastLogId = recentLog[0].id;

    wrap.innerHTML = `
      ${renderPodium(rankings)}
      <div class="lb-body">
        ${renderRankingTable(rankings)}
        ${renderActivityFeed(recentLog)}
      </div>
    `;
  } catch (err) {
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:#ff4d4f">⚠️ ${err.message}</div>`;
  }
}

// ─── Top 3 Podium ─────────────────────────────────────────────────────────────
function renderPodium(rankings) {
  const top3 = rankings.slice(0, 3);
  while (top3.length < 3) top3.push(null);
  const [first, second, third] = top3;

  const card = (person, medal, height) => {
    if (!person) return `<div class="lb-podium-slot lb-podium-empty" style="height:${height}px"></div>`;
    const rc = RANK_CONFIG[person.rank_level] || RANK_CONFIG.ROOKIE;
    return `
      <div class="lb-podium-slot" style="height:${height}px;--glow:${rc.glow}">
        <div class="lb-podium-medal">${medal}</div>
        <div class="lb-podium-avatar" style="background:${rc.color}20;border-color:${rc.color}">
          ${rc.emoji}
        </div>
        <div class="lb-podium-name">${person.name}</div>
        <div class="lb-podium-pts" style="color:${rc.color}">${person.total_points.toLocaleString()} PT</div>
        <div class="lb-podium-deals">${person.deals_closed} deals · $${Math.round(person.total_revenue).toLocaleString()}</div>
        <div class="lb-rank-badge" style="background:${rc.color}20;color:${rc.color}">${rc.emoji} ${rc.label}</div>
      </div>`;
  };

  return `
    <div class="lb-header">
      <div class="lb-title-live"><span class="lb-pulse">●</span> HALL OF FAME — TOP HUNTERS</div>
      <button class="lb-refresh-btn" onclick="loadLeaderboard()">🔄 Refresh</button>
    </div>
    <div class="lb-podium">
      ${card(second, '🥈', 160)}
      ${card(first, '🥇', 200)}
      ${card(third, '🥉', 130)}
    </div>`;
}

// ─── Full Ranking Table ────────────────────────────────────────────────────────
function renderRankingTable(rankings) {
  const rows = rankings.map((p, i) => {
    const rc = RANK_CONFIG[p.rank_level] || RANK_CONFIG.ROOKIE;
    const maxPts = rankings[0]?.total_points || 1;
    const pct = Math.round((p.total_points / maxPts) * 100);
    const nextRank = getNextRankThreshold(p.total_points);

    return `
      <tr class="lb-row ${i === 0 ? 'lb-row--first' : ''}">
        <td class="lb-rank-num" style="color:${i < 3 ? ['#ffd700', '#c0c0c0', '#cd7f32'][i] : '#64748b'}">#${i + 1}</td>
        <td>
          <div class="lb-player-cell">
            <div class="lb-player-avatar" style="background:${rc.color}20;color:${rc.color}">${rc.emoji}</div>
            <div>
              <div class="lb-player-name">${p.name}</div>
              <div class="lb-rank-badge-sm" style="background:${rc.color}15;color:${rc.color}">${rc.label}</div>
            </div>
          </div>
        </td>
        <td>
          <div class="lb-pts-cell">
            <span class="lb-pts-num" style="color:${rc.color}">${p.total_points.toLocaleString()}</span>
            <div class="lb-pts-bar-wrap"><div class="lb-pts-bar" style="width:${pct}%;background:${rc.color}"></div></div>
            ${nextRank ? `<span class="lb-next-rank">${nextRank.pts - p.total_points} pts → ${nextRank.level}</span>` : '<span class="lb-next-rank" style="color:#52c41a">✨ MAX RANK</span>'}
          </div>
        </td>
        <td class="lb-deals-cell">${p.deals_closed}</td>
        <td class="lb-revenue-cell">$${Math.round(p.total_revenue).toLocaleString()}</td>
      </tr>`;
  });

  return `
    <div class="lb-section">
      <div class="lb-section-title">📊 Full Rankings</div>
      <table class="lb-table">
        <thead>
          <tr>
            <th>RANK</th><th>SALES</th><th>ĐIỂM</th><th>DEALS</th><th>REVENUE</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

function getNextRankThreshold(pts) {
  const thresholds = [
    { level: 'ELITE', pts: 500 },
    { level: 'LEGEND', pts: 1500 },
    { level: 'HUNTER', pts: 3000 },
  ];
  return thresholds.find(t => pts < t.pts) || null;
}

// ─── Activity Feed ────────────────────────────────────────────────────────────
function renderActivityFeed(log) {
  if (!log.length) return `<div class="lb-section"><div class="lb-section-title">📋 Activity Feed</div><div style="padding:24px;text-align:center;opacity:0.4">Chưa có hoạt động</div></div>`;

  const items = log.slice(0, 15).map(entry => {
    const ac = ACTION_CONFIG[entry.action_type] || { icon: '⭐', label: entry.action_type, color: '#64748b' };
    const ts = formatRelativeTime(entry.created_at);
    const dealStr = entry.deal_value > 0 ? ` · <span style="color:#52c41a">+$${entry.deal_value.toLocaleString()}</span>` : '';
    return `
      <div class="lb-feed-item">
        <div class="lb-feed-icon" style="background:${ac.color}15;color:${ac.color}">${ac.icon}</div>
        <div class="lb-feed-body">
          <div class="lb-feed-text">
            <strong>${entry.sales_name}</strong>
            <span class="lb-feed-action" style="color:${ac.color}">${ac.label}</span>
            <span class="lb-feed-pts">+${entry.points} PT${dealStr}</span>
          </div>
          ${entry.note ? `<div class="lb-feed-note">${entry.note}</div>` : ''}
        </div>
        <div class="lb-feed-time">${ts}</div>
      </div>`;
  });

  return `
    <div class="lb-section">
      <div class="lb-section-title">📋 Activity Feed <span style="font-weight:400;opacity:.5;font-size:0.75rem">Live · cập nhật mỗi 30s</span></div>
      <div class="lb-feed">${items.join('')}</div>
    </div>`;
}

function formatRelativeTime(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

// ─── Live Ticker: poll every 30s, toast on new entries ──────────────────────
let _tickerInterval = null;

function startLiveTicker() {
  if (_tickerInterval) return;
  _tickerInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/leaderboard/log?limit=5`);
      const data = await res.json();
      if (!data.success) return;
      const newEntries = (data.data || []).filter(e => e.id > _lastLogId);
      if (newEntries.length) {
        _lastLogId = newEntries[0].id;
        newEntries.reverse().forEach(showTickerToast);
        // Refresh leaderboard if it's visible
        const lb = document.getElementById('leaderboardTab');
        if (lb && lb.style.display !== 'none') loadLeaderboard();
      }
    } catch (_) { }
  }, 30000);
}

function showTickerToast(entry) {
  const ac = ACTION_CONFIG[entry.action_type] || { icon: '⭐', label: entry.action_type, color: '#f59e0b' };
  const toast = document.createElement('div');
  toast.className = 'lb-ticker-toast';
  toast.style.cssText = `border-left-color:${ac.color}`;
  const dealStr = entry.deal_value > 0 ? ` · $${entry.deal_value.toLocaleString()}` : '';
  toast.innerHTML = `
    <span class="lb-ticker-icon">${ac.icon}</span>
    <div>
      <div class="lb-ticker-title">${entry.sales_name} — ${ac.label}${dealStr}</div>
      <div class="lb-ticker-sub">+${entry.points} điểm · ${entry.note || ''}</div>
    </div>`;
  const container = document.getElementById('tickerContainer');
  if (container) {
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('lb-ticker-show'), 50);
    setTimeout(() => {
      toast.classList.remove('lb-ticker-show');
      setTimeout(() => toast.remove(), 400);
    }, 5000);
  }

  // Flash the page border glow
  document.body.classList.add('lb-flash');
  setTimeout(() => document.body.classList.remove('lb-flash'), 800);
}

// ─── Award points (called from Closing Room / lead actions) ──────────────────
async function awardLeadPoints(salesName, actionType, { points, dealValue = 0, leadId = 0, note = '' } = {}) {
  try {
    await fetch('/api/points/award', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sales_name: salesName, action_type: actionType, points, deal_value: dealValue, lead_id: leadId, note }),
    });
  } catch (_) { }
}
