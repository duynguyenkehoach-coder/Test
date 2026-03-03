/**
 * dataFiles.js — Data Files tab rendering (file browser + viewer)
 */

function renderDataFiles() {
    const grid = document.getElementById('dataGrid');
    if (!AppState.dataFiles || AppState.dataFiles.length === 0) {
        grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📁</div>
        <h3>No data files yet</h3>
        <p>Run a scan — leads will be saved to daily JSON files automatically.</p>
      </div>`;
        return;
    }

    // Group by date
    const byDate = {};
    AppState.dataFiles.forEach(f => {
        if (!byDate[f.date]) byDate[f.date] = [];
        byDate[f.date].push(f);
    });

    let html = '';
    for (const [date, files] of Object.entries(byDate)) {
        const isToday = date === new Date().toISOString().split('T')[0];
        const dayLabel = isToday ? `📅 ${date} (Hôm nay)` : `📅 ${date}`;

        html += `<div class="data-date-group">
      <div class="data-date-header">${dayLabel}</div>
      <div class="data-files-row">`;

        for (const file of files) {
            const icon = file.type === 'leads' ? '🎯' : '📬';
            const typeLabel = file.type === 'leads' ? 'Leads' : 'Inbox';
            const sizeStr = formatFileSize(file.size);

            html += `
        <div class="data-file-card" onclick="viewFileContent('${file.name}')">
          <div class="data-file-icon">${icon}</div>
          <div class="data-file-info">
            <div class="data-file-name">${typeLabel}</div>
            <div class="data-file-meta">${file.items} items • ${sizeStr}</div>
          </div>
          <div class="data-file-arrow">→</div>
        </div>`;
        }

        html += `</div></div>`;
    }

    grid.innerHTML = html;
}

function renderFileLeadCard(item) {
    const scoreClass = (item.score || 0) >= 80 ? 'score-high' : (item.score || 0) >= 60 ? 'score-med' : 'score-low';
    return `
    <div class="lead-card" style="grid-template-columns:auto 1fr;">
      <div class="score-badge ${scoreClass}" style="width:50px;height:50px;font-size:16px;">${item.score || 0}</div>
      <div class="lead-body">
        <div class="lead-meta">
          <span class="platform-badge platform-${item.platform}">${item.platform}</span>
          <span class="category-tag">${item.category || 'N/A'}</span>
          <span class="urgency-tag urgency-${item.urgency || 'low'}">${item.urgency || 'low'}</span>
        </div>
        <div class="lead-author">${escapeHtml(item.author || 'Unknown')}</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin-top:6px;">
          ${escapeHtml((item.content || item.summary || '').substring(0, 300))}
        </div>
        ${item.url ? `<a href="${item.url}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);margin-top:6px;display:inline-block;">🔗 View Post</a>` : ''}
      </div>
    </div>`;
}

function renderFileInboxCard(item) {
    return `
    <div class="lead-card conv-card" style="grid-template-columns:1fr;">
      <div class="lead-body">
        <div class="lead-meta">
          <span class="platform-badge platform-${item.platform || 'facebook'}">${item.platform || 'messenger'}</span>
          <span class="category-tag">${item.intent || 'general'}</span>
          <span class="category-tag" style="opacity:0.6;">${item.status || 'pending'}</span>
        </div>
        <div class="lead-author">👤 ${escapeHtml(item.sender_name || 'Unknown')}</div>
        <div class="conv-message-box">
          <div class="conv-message-label">🗣️ Message:</div>
          <div class="conv-message-text">"${escapeHtml(item.message || '')}"</div>
        </div>
        ${item.ai_suggestion ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:6px;">🤖 ${escapeHtml(item.ai_suggestion.substring(0, 200))}...</div>` : ''}
      </div>
    </div>`;
}

function closeFileViewer() {
    document.getElementById('fileViewerPanel').style.display = 'none';
}
