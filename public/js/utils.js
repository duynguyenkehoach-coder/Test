/**
 * utils.js — Shared helper functions
 */

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100px)';
        toast.style.transition = '0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showLoading(show) {
    document.getElementById('loadingOverlay').classList.toggle('active', show);
}

function toggleContent(id) {
    const el = document.getElementById(`content-${id}`);
    const fade = document.getElementById(`fade-${id}`);
    const btn = el?.parentElement?.querySelector('.expand-btn');
    if (el?.classList.contains('expanded')) {
        el.classList.remove('expanded');
        if (fade) fade.style.display = '';
        if (btn) btn.textContent = 'Show more ▼';
    } else {
        el?.classList.add('expanded');
        if (fade) fade.style.display = 'none';
        if (btn) btn.textContent = 'Show less ▲';
    }
}

function copyText(text) {
    const decoded = new DOMParser().parseFromString(text, 'text/html').body.textContent;
    navigator.clipboard.writeText(decoded).then(() => showToast('Copied!', 'success'))
        .catch(() => showToast('Failed to copy', 'error'));
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
