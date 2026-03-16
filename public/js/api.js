/**
 * api.js — All API calls (fetch wrappers)
 */

// ─── JWT Auth Helper ──────────────────────────────────────────────────────────
function getToken() {
    return localStorage.getItem('thg_token') || '';
}

async function authFetch(url, options = {}) {
    const token = getToken();
    const headers = {
        ...(options.headers || {}),
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
    };
    // Use window.fetch (native) to avoid infinite recursion
    const res = await window.fetch(url, { ...options, headers, credentials: 'include' });
    if (res.status === 401) {
        localStorage.removeItem('thg_token');
        localStorage.removeItem('thg_user');
        window.location.href = '/login';
        return res;
    }
    return res;
}

// --- Stats ---
async function loadStats() {
    try {
        const res = await authFetch('/api/stats');
        const { data } = await res.json();
        const statTotalForeign = document.getElementById('statTotalForeign');
        const statTotalViet = document.getElementById('statTotalViet');
        document.getElementById('statHighValue').textContent = data.highValue || 0;
        document.getElementById('statAvgScore').textContent = data.avgScore || 0;
        document.getElementById('tabLeadsCount').textContent = data.total || 0;

        const bp = data.byPlatform || {};
        document.getElementById('statPlatforms').textContent = Object.keys(bp).length;
        const parts = [];
        if (bp.facebook) parts.push(`FB: ${bp.facebook}`);
        if (bp.instagram) parts.push(`IG: ${bp.instagram}`);
        if (bp.reddit) parts.push(`RD: ${bp.reddit}`);
        if (bp.twitter) parts.push(`X: ${bp.twitter}`);
        if (bp.tiktok) parts.push(`TT: ${bp.tiktok}`);
        document.getElementById('statPlatformDetail').textContent = parts.join(' | ') || 'No data';

        // Conversation stats
        const conv = data.conversations || {};
        document.getElementById('statPending').textContent = conv.pending || 0;
        document.getElementById('statConvDetail').textContent = `${conv.replied || 0} đã reply`;
        document.getElementById('tabInboxCount').textContent = conv.pending || 0;
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

// --- Leads ---
async function loadLeads() {
    try {
        const params = new URLSearchParams();
        const platform = document.getElementById('filterPlatform')?.value || '';
        const category = AppState.currentCategory || '';
        const status = document.getElementById('filterStatus')?.value || '';
        const minScore = document.getElementById('filterScore')?.value || '';
        const search = document.getElementById('filterSearch')?.value || '';

        if (platform) params.set('platform', platform);
        if (category && category !== 'All') params.set('category', category);
        if (status) params.set('status', status);
        if (minScore) params.set('minScore', minScore);
        if (search) params.set('search', search);

        // Tell backend to hide ignored leads from main dashboard
        params.set('exclude_ignored', 'true');

        const res = await authFetch(`/api/leads?${params}`);
        const { data, count } = await res.json();
        AppState.leads = data || [];
        console.log('[THG] loadLeads:', AppState.leads.length, 'leads, category:', AppState.currentCategory);

        // ── Client-side count segmentation (because the backend only knows Services, not Languages)
        let displayCount = count || 0;
        const currentCat = AppState.currentCategory || '';

        const isVietnamese = (text) => {
            if (!text) return false;
            return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
        };

        const totalVietCount = AppState.leads.filter(l => isVietnamese(l.content || '')).length;
        const totalForeignCount = AppState.leads.length - totalVietCount;

        const statForeign = document.getElementById('statTotalForeign');
        const statViet = document.getElementById('statTotalViet');
        if (statForeign) statForeign.textContent = totalForeignCount;
        if (statViet) statViet.textContent = totalVietCount;

        if (currentCat.startsWith('Foreign-')) {
            displayCount = totalForeignCount;
        } else if (currentCat.startsWith('Viet-')) {
            displayCount = totalVietCount;
        }

        const leadsCountEl = document.getElementById('leadsCount');
        const tabLeadsCountEl = document.getElementById('tabLeadsCount');
        if (leadsCountEl) leadsCountEl.textContent = `${displayCount} leads`;
        if (tabLeadsCountEl) tabLeadsCountEl.textContent = displayCount;
        renderLeads();
    } catch (err) {
        console.error('Failed to load leads:', err);
    }
}

async function loadLeadById(id) {
    try {
        const res = await authFetch(`/api/leads/${id}`);
        const { data } = await res.json();
        return data; // returns full lead object including content and original_post
    } catch (err) {
        console.error('Failed to load full lead:', err);
        return null;
    }
}

async function loadIgnoredLeads() {
    try {
        const res = await authFetch(`/api/leads?status=ignored`);
        const { data, count } = await res.json();
        AppState.ignoredLeads = data || [];
        document.getElementById('ignoredCount').textContent = `${count || 0} leads`;
        document.getElementById('tabIgnoredCount').textContent = count || 0;
        renderIgnoredLeads();
    } catch (err) {
        console.error('Failed to load ignored leads:', err);
    }
}

async function updateStatus(id, status) {
    try {
        const res = await authFetch(`/api/leads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
        });
        if (res.ok) {
            showToast(`Lead #${id} → ${status}`, 'success');
            loadLeads();
            loadStats();
        }
    } catch (err) {
        showToast('Error updating status', 'error');
    }
}

async function updateCategory(id, category) {
    try {
        const res = await authFetch(`/api/leads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category }),
        });
        if (res.ok) {
            // Update in-memory lead data
            const lead = AppState.leads.find(l => l.id === id) || AppState.ignoredLeads.find(l => l.id === id);
            if (lead) lead.category = category;
            showToast(`Lead #${id} → ${category}`, 'success');
            renderLeads();
        }
    } catch (err) {
        showToast('Error updating category', 'error');
    }
}

// Contacted → auto-copy response to clipboard + change status
async function contactLead(id) {
    const textarea = document.getElementById(`response-${id}`);
    const responseText = textarea?.value || '';
    const notesEl = document.getElementById(`notes-${id}`);
    const notes = notesEl?.value || '';

    try {
        // Copy response to clipboard
        if (responseText) {
            await navigator.clipboard.writeText(responseText);
            showToast('📋 Response đã copy vào clipboard — sẵn sàng paste!', 'success');
        }

        // Save status + response + notes
        await authFetch(`/api/leads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'contacted', suggested_response: responseText, notes }),
        });

        loadLeads();
        loadStats();
    } catch (err) {
        showToast('Error updating lead', 'error');
    }
}

// Converted → save with notes + timestamp for analytics
async function convertLead(id) {
    const notesEl = document.getElementById(`notes-${id}`);
    const notes = notesEl?.value || '';

    if (!notes && !confirm('Chưa có ghi chú. Vẫn muốn đánh dấu Converted?')) return;

    try {
        await authFetch(`/api/leads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'converted', notes }),
        });
        showToast('✅ Lead đã Converted! Đã log vào Analytics.', 'success');
        loadLeads();
        loadStats();
    } catch (err) {
        showToast('Error converting lead', 'error');
    }
}

// Save edited response text
async function saveResponse(id) {
    const textarea = document.getElementById(`response-${id}`);
    if (!textarea) return;
    try {
        await authFetch(`/api/leads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggested_response: textarea.value }),
        });
        showToast('💾 Response saved!', 'success');
    } catch (err) {
        showToast('Error saving response', 'error');
    }
}

// Save notes
async function saveNotes(id) {
    const textarea = document.getElementById(`notes-${id}`);
    if (!textarea) return;
    try {
        await authFetch(`/api/leads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: textarea.value }),
        });
        showToast('💾 Notes saved!', 'success');
    } catch (err) {
        showToast('Error saving notes', 'error');
    }
}

// Copy response from editable textarea
function copyResponse(id) {
    const textarea = document.getElementById(`response-${id}`);
    if (!textarea?.value) return showToast('No response to copy', 'error');
    navigator.clipboard.writeText(textarea.value).then(() => {
        showToast('📋 Copied!', 'success');
    });
}

async function deleteLead(id) {
    if (!confirm(`Xóa lead #${id}? Không thể hoàn tác.`)) return;
    try {
        const res = await authFetch(`/api/leads/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast(`🗑️ Lead #${id} đã xóa`, 'success');
            loadLeads();
            loadStats();
        }
    } catch (err) {
        showToast('Error deleting lead', 'error');
    }
}

async function clearAllLeads() {
    const count = AppState.leads.length;
    if (!confirm(`⚠️ XÓA TẤT CẢ ${count} leads?\n\nHành động này KHÔNG thể hoàn tác!`)) return;
    if (!confirm('Bạn chắc chắn muốn xóa hết? Bấm OK để xác nhận lần cuối.')) return;
    try {
        const res = await authFetch('/api/leads?confirm=true', { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            showToast(`🗑️ Đã xóa ${data.deleted} leads`, 'success');
            loadLeads();
            loadStats();
        }
    } catch (err) {
        showToast('Error clearing leads', 'error');
    }
}

async function triggerScan() {
    const btn = document.getElementById('scanBtn');
    const statusEl = document.getElementById('scanStatus');
    btn.disabled = true;
    btn.innerHTML = '⏳ Scanning...';
    statusEl.textContent = 'Keyword scanning...';

    try {
        await authFetch('/api/scan', { method: 'POST' });
        showToast('Keyword scan started! Results will appear shortly.', 'info');
        let pollCount = 0;
        const poll = setInterval(async () => {
            pollCount++;
            await loadStats();
            await loadLeads();
            if (pollCount >= 60) {
                clearInterval(poll);
                btn.disabled = false; btn.innerHTML = '🔍 Keyword Scan'; statusEl.textContent = 'Ready';
            }
        }, 5000);
        setTimeout(() => { btn.disabled = false; btn.innerHTML = '🔍 Keyword Scan'; statusEl.textContent = 'Ready'; }, 30000);
    } catch (err) {
        showToast('Failed to start scan', 'error');
        btn.disabled = false; btn.innerHTML = '🔍 Keyword Scan'; statusEl.textContent = 'Ready';
    }
}

// Group scan disabled — button removed from UI
async function triggerGroupScan() {
    showToast('Group scan disabled — using keyword search instead', 'info');
}

// --- Conversations ---
async function loadConversations() {
    try {
        const status = document.getElementById('inboxFilter').value;
        const params = status ? `?status=${status}` : '';
        const res = await authFetch(`/api/conversations${params}`);
        const { data, count } = await res.json();
        AppState.conversations = data || [];
        document.getElementById('inboxCount').textContent = `${count || 0} messages`;
        renderConversations();
    } catch (err) {
        console.error('Failed to load conversations:', err);
    }
}

async function updateConversation(id, saleReply, status) {
    try {
        const res = await authFetch(`/api/conversations/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sale_reply: saleReply, status }),
        });
        if (res.ok) {
            showToast(`Message #${id} → ${status}`, 'success');
            loadConversations();
            loadStats();
        }
    } catch (err) {
        showToast('Error updating conversation', 'error');
    }
}

async function regenerateReply(id) {
    const btn = document.getElementById(`regen-${id}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
    try {
        const res = await authFetch(`/api/conversations/${id}/regenerate`, { method: 'POST' });
        const { data } = await res.json();
        if (data) {
            const textarea = document.getElementById(`reply-${id}`);
            if (textarea) textarea.value = data.ai_suggestion || '';
            showToast('AI đã soạn lại reply!', 'success');
        }
    } catch (err) {
        showToast('Error regenerating', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Regen'; }
    }
}

async function sendTestMessage() {
    const message = document.getElementById('testMessage').value.trim();
    if (!message) return showToast('Nhập tin nhắn!', 'error');

    const btn = document.getElementById('sendTestBtn');
    btn.disabled = true; btn.textContent = '⏳ AI đang soạn...';

    try {
        const res = await authFetch('/api/test-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                sender_name: document.getElementById('testSenderName').value || 'Test Customer',
            }),
        });
        const { data } = await res.json();
        hideTestModal();
        switchTab('inbox');
        loadConversations();
        loadStats();
        showToast(`AI Copilot đã soạn reply! (${data.intent})`, 'success');
        document.getElementById('testMessage').value = '';
        document.getElementById('testSenderName').value = '';
    } catch (err) {
        showToast('Error sending test message', 'error');
    } finally {
        btn.disabled = false; btn.textContent = '🚀 Send to AI Copilot';
    }
}

// --- Data Files ---
async function loadDataFiles() {
    try {
        const res = await authFetch('/api/data-files');
        const { data } = await res.json();
        AppState.dataFiles = data || [];
        document.getElementById('dataCount').textContent = `${AppState.dataFiles.length} files`;
        document.getElementById('tabDataCount').textContent = AppState.dataFiles.length;
        renderDataFiles();
    } catch (err) {
        console.error('Failed to load data files:', err);
    }
}

async function viewFileContent(fileName) {
    const panel = document.getElementById('fileViewerPanel');
    const title = document.getElementById('fileViewerTitle');
    const content = document.getElementById('fileViewerContent');

    title.textContent = `📄 ${fileName}`;
    content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    panel.style.display = '';

    try {
        const res = await authFetch(`/api/data-files/${fileName}`);
        const { data } = await res.json();

        if (!data || data.length === 0) {
            content.innerHTML = '<div class="empty-state"><p>File is empty.</p></div>';
            return;
        }

        const isLeads = fileName.startsWith('leads_');
        content.innerHTML = data.map(item => isLeads ? renderFileLeadCard(item) : renderFileInboxCard(item)).join('');
    } catch (err) {
        content.innerHTML = `<div class="empty-state"><p>Error loading file: ${err.message}</p></div>`;
    }

    panel.scrollIntoView({ behavior: 'smooth' });
}

async function triggerCleanup() {
    try {
        const res = await authFetch('/api/data-files/cleanup', { method: 'POST' });
        const { deleted } = await res.json();
        showToast(`🧹 Cleaned ${deleted} old files`, 'success');
        loadDataFiles();
    } catch (err) {
        showToast('Error cleaning files', 'error');
    }
}
