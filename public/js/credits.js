/**
 * credits.js — Credits tab: SociaVault API credit usage tracking
 * Shows: summary cards + detailed log table for accounting/data engineering
 */

async function loadCredits() {
    try {
        const resp = await fetch('/api/credits');
        const json = await resp.json();
        if (!json.success) throw new Error(json.error);

        const { stats, log } = json.data;
        renderCreditsSummary(stats);
        renderCreditsLog(log);

        // Update badge
        const badge = document.getElementById('tabCreditsCount');
        if (badge) badge.textContent = stats.today || 0;
    } catch (err) {
        console.error('[Credits] Error:', err);
        document.getElementById('creditsLog').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <h3>Error loading credits</h3>
        <p>${err.message}</p>
      </div>`;
    }
}

function renderCreditsSummary(stats) {
    const container = document.getElementById('creditsSummary');
    if (!container) return;

    const cards = [
        { icon: '💳', label: 'Used Today', value: stats.today || 0, color: '#3b82f6' },
        { icon: '📊', label: 'Total Logged', value: stats.total_logged || 0, color: '#8b5cf6' },
        { icon: '🕐', label: 'First Call', value: stats.first_call ? new Date(stats.first_call).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '--:--', color: '#10b981' },
        { icon: '🕐', label: 'Last Call', value: stats.last_call ? new Date(stats.last_call).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '--:--', color: '#f59e0b' },
    ];

    // Platform breakdown cards
    if (stats.by_platform && Object.keys(stats.by_platform).length > 0) {
        const platformIcons = { facebook: '📘', tiktok: '🎵', instagram: '📷', unknown: '❓' };
        for (const [plat, count] of Object.entries(stats.by_platform)) {
            cards.push({ icon: platformIcons[plat] || '🌐', label: plat.charAt(0).toUpperCase() + plat.slice(1), value: count, color: '#64748b' });
        }
    }

    container.innerHTML = cards.map(c => `
    <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:12px;padding:20px;text-align:center;">
      <div style="font-size:2rem;margin-bottom:8px;">${c.icon}</div>
      <div style="font-size:2rem;font-weight:700;color:${c.color};">${c.value}</div>
      <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:4px;">${c.label}</div>
    </div>
  `).join('');
}

function renderCreditsLog(log) {
    const container = document.getElementById('creditsLog');
    if (!container) return;

    if (!log || log.length === 0) {
        container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💳</div>
        <h3>No credit usage yet</h3>
        <p>Credits will be logged here when scans run</p>
      </div>`;
        return;
    }

    // Reverse to show newest first
    const sorted = [...log].reverse();

    const platformIcons = { facebook: '📘', tiktok: '🎵', instagram: '📷', unknown: '❓' };

    container.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <thead>
          <tr style="border-bottom:2px solid var(--border);text-align:left;">
            <th style="padding:12px 8px;color:var(--text-secondary);font-weight:600;">#</th>
            <th style="padding:12px 8px;color:var(--text-secondary);font-weight:600;">Time</th>
            <th style="padding:12px 8px;color:var(--text-secondary);font-weight:600;">Platform</th>
            <th style="padding:12px 8px;color:var(--text-secondary);font-weight:600;">Endpoint</th>
            <th style="padding:12px 8px;color:var(--text-secondary);font-weight:600;">Source</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(entry => `
            <tr style="border-bottom:1px solid var(--border);">
              <td style="padding:10px 8px;color:var(--text-secondary);">${entry.id}</td>
              <td style="padding:10px 8px;">${new Date(entry.timestamp).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
              <td style="padding:10px 8px;">
                <span class="platform-badge platform-${entry.platform}">${platformIcons[entry.platform] || '🌐'} ${entry.platform}</span>
              </td>
              <td style="padding:10px 8px;font-family:monospace;font-size:0.85rem;color:var(--accent);">${escapeHtml(entry.endpoint)}</td>
              <td style="padding:10px 8px;font-size:0.85rem;color:var(--text-secondary);">${escapeHtml(entry.source || '-')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}
