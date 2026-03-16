/**
 * groups.js — Handles the Group Discovery Database Tab
 */

// Format numbers (e.g., 200000 -> "200.0k", 1500 -> "1.5k")
function formatMemberCount(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toString();
}

function formatCategory(cat) {
    const map = {
        'pod': '🖨️ POD',
        'dropship': '📦 Dropship',
        'fulfillment': '🏭 Fulfillment',
        'fba': '📦 Amazon FBA',
        'shipping': '✈️ Shipping/Logistics',
        'sourcing': '🇨🇳 Sourcing TQ',
        'tiktok_shop': '🎵 TikTok Shop',
        'etsy': '🎨 Etsy',
        'shopify': '🛒 Shopify',
        'ecommerce': '🛍️ E-commerce',
        'ecommerce-uk': '🇬🇧 UK Market',
        'ecommerce-fr': '🇫🇷 France Market',
        'ecommerce-de': '🇩🇪 Germany Market',
        'ecommerce-eu': '🇪🇺 EU Market',
        'cross-border': '🌏 Cross-border',
        'unknown': '❓ Khác'
    };
    return map[cat] || cat;
}

// -----------------------------------------
// REFRESH & LOAD
// -----------------------------------------
function refreshGroupsData() {
    loadGroups();
}

async function loadGroups() {
    const grid = document.getElementById('groupsGrid');
    if (!grid) return;

    grid.innerHTML = '<div class="empty-state"><div class="spinner" style="margin: 0 auto;"></div><h3>Loading...</h3></div>';

    const category = document.getElementById('filterGroupCategory').value;
    const status = document.getElementById('filterGroupStatus').value;

    let url = '/api/groups?limit=500';
    if (category) url += `&category=${category}`;
    if (status) url += `&status=${status}`;

    try {
        const res = await fetch(url);
        const { data } = await res.json();

        loadGroupStats(); // Update stats bar

        if (!data || data.length === 0) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">👥</div>
                    <h3>Không có group nào</h3>
                    <p>Thử điều chỉnh bộ lọc hoặc thêm nhóm mới.</p>
                </div>`;
            return;
        }

        let html = '';
        data.forEach(g => {
            const badgeColor = g.relevance_score >= 80 ? 'background:rgba(16,185,129,0.1);color:#10b981;' :
                (g.relevance_score >= 60 ? 'background:rgba(245,158,11,0.1);color:#f59e0b;' : 'background:rgba(148,163,184,0.1);color:#94a3b8;');

            const statusToggle = g.status === 'active'
                ? `<button class="action-btn" onclick="toggleGroupStatus('${g.url}', 'inactive')" title="Đang bật - Bấm để tắt">🟢 Active</button>`
                : `<button class="action-btn" onclick="toggleGroupStatus('${g.url}', 'active')" title="Đang tắt - Bấm để bật">⚪ Inactive</button>`;

            html += `
            <div class="lead-card" style="opacity: ${g.status === 'active' ? '1' : '0.6'}">
                <div class="lead-header">
                    <div class="lead-meta">
                        <span class="platform-icon" style="color: #1877f2;">📘</span>
                        <a class="lead-author" href="${g.url}" target="_blank" title="${g.name}">
                            ${g.name.length > 50 ? g.name.substring(0, 50) + '...' : g.name}
                        </a>
                    </div>
                    <div class="lead-badges">
                        <span class="badge" style="${badgeColor}">Score ${g.relevance_score}</span>
                        <span class="badge" style="background:rgba(59,130,246,0.1);color:#3b82f6;">${formatCategory(g.category)}</span>
                    </div>
                </div>
                <div class="lead-content" style="font-size: 0.9rem; color: #cbd5e1; margin-top: 12px; margin-bottom: 12px;">
                    <div style="display: flex; gap: 16px;">
                        <div><strong style="color:#94a3b8">Thành viên:</strong> ${formatMemberCount(g.member_count)}</div>
                        <div><strong style="color:#94a3b8">Bản ghi ID:</strong> ${g.group_id || 'Chưa sync'}</div>
                    </div>
                    ${g.notes ? `<div style="margin-top: 8px; font-style: italic; color: #94a3b8;">📝 ${g.notes}</div>` : ''}
                </div>
                <div class="lead-footer" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px;">
                    <div style="font-size: 0.8rem; color: #64748b;">
                        Đã quét: ${g.last_scanned_at ? new Date(g.last_scanned_at).toLocaleString() : 'Chưa quét'}
                    </div>
                    <div>
                        ${statusToggle}
                    </div>
                </div>
            </div>`;
        });

        // Wrap in CSS Grid format identical to Leads
        grid.innerHTML = `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px;">${html}</div>`;

    } catch (err) {
        console.error(err);
        grid.innerHTML = `<div class="empty-state" style="color:#ef4444;">Lỗi tải dữ liệu groups!</div>`;
    }
}

async function loadGroupStats() {
    try {
        const res = await fetch('/api/groups/stats');
        const { data } = await res.json();

        document.getElementById('tabGroupsCount').textContent = data.total;

        const statsHtml = `
            <div class="stat-card" style="flex:1; min-width: 150px; background: rgba(14,165,233,0.05); border-color: rgba(14,165,233,0.1);">
                <div class="stat-label">Total DB Groups</div>
                <div class="stat-value" style="color: #38bdf8;">${data.total}</div>
                <div class="stat-detail">${data.active} đang Active quét tự động</div>
            </div>
            <div class="stat-card" style="flex:1; min-width: 150px; background: rgba(16,185,129,0.05); border-color: rgba(16,185,129,0.1);">
                <div class="stat-label">High Relevance (Tier 1)</div>
                <div class="stat-value" style="color: #34d399;">${data.highScore}</div>
                <div class="stat-detail">Score ≥ 70</div>
            </div>
        `;
        document.getElementById('groupsStatsBar').innerHTML = statsHtml;
    } catch (err) {
        console.error("Load group stats err", err);
    }
}

// -----------------------------------------
// MODALS & ACTIONS
// -----------------------------------------
function showAddGroupModal() {
    document.getElementById('newGroupName').value = '';
    document.getElementById('newGroupUrl').value = '';
    document.getElementById('newGroupNotes').value = '';
    document.getElementById('addGroupModal').style.display = 'flex';
}

function hideAddGroupModal() {
    document.getElementById('addGroupModal').style.display = 'none';
}

async function submitNewGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    const url = document.getElementById('newGroupUrl').value.trim();
    const category = document.getElementById('newGroupCategory').value;
    const notes = document.getElementById('newGroupNotes').value.trim();

    if (!name || !url) {
        showToast('Vui lòng nhập Tên và URL Group', 'error');
        return;
    }

    if (!url.includes('facebook.com/groups/')) {
        showToast('URL không hợp lệ. Phải chứa facebook.com/groups/...', 'error');
        return;
    }

    const btn = document.getElementById('saveGroupBtn');
    btn.disabled = true;
    btn.textContent = 'Đang lưu...';

    try {
        const res = await fetch('/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, url, category, notes })
        });

        const result = await res.json();
        if (result.success) {
            showToast('Thêm group thành công!', 'success');
            hideAddGroupModal();
            loadGroups();
        } else {
            showToast(result.error || 'Lỗi server', 'error');
        }
    } catch (err) {
        showToast('Lỗi mạng', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Lưu Nhóm';
    }
}

async function toggleGroupStatus(url, newStatus) {
    try {
        const res = await fetch('/api/groups/status', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, status: newStatus })
        });
        const result = await res.json();
        if (result.success) {
            showToast(`Đã ${newStatus === 'active' ? 'bật' : 'tắt'} tự động quét cho nhóm này`, 'success');
            loadGroups();
        } else {
            showToast('Lỗi: ' + result.error, 'error');
        }
    } catch (err) {
        showToast('Lỗi mạng', 'error');
    }
}

// -----------------------------------------
// BULK IMPORT
// -----------------------------------------
function toggleBulkImport() {
    const panel = document.getElementById('bulkImportPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function bulkImportGroups() {
    const textarea = document.getElementById('bulkUrls');
    const btn = document.getElementById('btnBulkImport');
    const status = document.getElementById('bulkImportStatus');
    const text = textarea.value.trim();

    if (!text) {
        showToast('Vui lòng dán URL vào ô trước khi nhập!', 'error');
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Đang nhập...';
    status.textContent = '';

    try {
        const res = await fetch('/api/groups/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: text })
        });

        const result = await res.json();
        if (result.success) {
            showToast(`✅ ${result.message}`, 'success');
            status.textContent = `+${result.added} mới, ${result.skipped} trùng/bỏ qua (tổng ${result.total} URL)`;
            status.style.color = '#10b981';
            textarea.value = '';
            loadGroups(); // Reload grid
        } else {
            showToast(result.error || 'Lỗi server', 'error');
            status.textContent = '❌ ' + (result.error || 'Lỗi');
            status.style.color = '#ef4444';
        }
    } catch (err) {
        showToast('Lỗi kết nối server', 'error');
        status.textContent = '❌ Lỗi mạng';
        status.style.color = '#ef4444';
    } finally {
        btn.disabled = false;
        btn.textContent = '🚀 Nhập Hàng Loạt';
    }
}
