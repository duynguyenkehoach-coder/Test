/**
 * app.js — Main application controller (init, state, tab switching, theme)
 */

// --- Global App State ---
const AppState = {
    leads: [],
    conversations: [],
    dataFiles: [],
    analytics: null,
    currentTab: 'leads',
    searchTimeout: null,
};

// --- Tab Switching ---
function switchTab(tab) {
    AppState.currentTab = tab;
    document.getElementById('leadsTab').style.display = tab === 'leads' ? '' : 'none';
    document.getElementById('ignoredTab').style.display = tab === 'ignored' ? '' : 'none';
    document.getElementById('inboxTab').style.display = tab === 'inbox' ? '' : 'none';
    document.getElementById('dataTab').style.display = tab === 'data' ? '' : 'none';
    document.getElementById('analyticsTab').style.display = tab === 'analytics' ? '' : 'none';
    document.getElementById('creditsTab').style.display = tab === 'credits' ? '' : 'none';

    document.getElementById('tabLeads').classList.toggle('active', tab === 'leads');
    document.getElementById('tabIgnored').classList.toggle('active', tab === 'ignored');
    document.getElementById('tabInbox').classList.toggle('active', tab === 'inbox');
    document.getElementById('tabData').classList.toggle('active', tab === 'data');
    document.getElementById('tabAnalytics').classList.toggle('active', tab === 'analytics');
    document.getElementById('tabCredits').classList.toggle('active', tab === 'credits');

    // Update page title
    const titles = { leads: 'Leads Database', ignored: 'Agent Training (Ignored Leads)', inbox: 'AI Copilot Inbox', data: 'Data Archives', analytics: 'Analytics Dashboard', credits: 'Credit Usage' };
    document.getElementById('pageTitleText').textContent = titles[tab] || 'Dashboard';

    if (tab === 'inbox') loadConversations();
    if (tab === 'data') loadDataFiles();
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'credits') loadCredits();
    if (tab === 'ignored') loadIgnoredLeads();
}

// --- Dark/Light Mode ---
function toggleTheme() {
    document.body.classList.toggle('light-mode');
    const isLight = document.body.classList.contains('light-mode');
    document.getElementById('themeIcon').textContent = isLight ? '☀️' : '🌙';
    document.getElementById('themeText').textContent = isLight ? 'Light Mode' : 'Dark Mode';
    localStorage.setItem('thg-theme', isLight ? 'light' : 'dark');
}

function loadTheme() {
    const saved = localStorage.getItem('thg-theme');
    if (saved === 'light') {
        document.body.classList.add('light-mode');
        document.getElementById('themeIcon').textContent = '☀️';
        document.getElementById('themeText').textContent = 'Light Mode';
    }
}

// --- Init ---
let nextScanTime = null;

function initCountdown() {
    const container = document.getElementById('scanCountdownContainer');
    const timeText = document.getElementById('scanCountdownTime');

    // Fetch next scan time from backend
    fetch('/api/scan/next')
        .then(res => res.json())
        .then(data => {
            if (data.success && data.nextRun) {
                nextScanTime = data.nextRun;
                container.style.display = 'flex';
            }
        })
        .catch(console.error);

    // Update timer every second
    setInterval(() => {
        if (!nextScanTime) return;
        const now = Date.now();
        const diff = nextScanTime - now;

        if (diff <= 0) {
            timeText.textContent = "Scanning...";
            // Optional: re-fetch next time after a short delay since cron just triggered
            setTimeout(initCountdown, 30000);
            nextScanTime = null;
            return;
        }

        const mins = Math.floor((diff / 1000 / 60) % 60);
        const secs = Math.floor((diff / 1000) % 60);
        timeText.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    initCountdown();

    // Populate Time Filter options (00:00 to 23:30)
    const timeSelect = document.getElementById('filterTime');
    if (timeSelect) {
        for (let h = 0; h < 24; h++) {
            const hh = String(h).padStart(2, '0');
            timeSelect.insertAdjacentHTML('beforeend', `<option value="${hh}:00">${hh}:00</option>`);
            timeSelect.insertAdjacentHTML('beforeend', `<option value="${hh}:30">${hh}:30</option>`);
        }
    }

    loadStats();
    loadLeads();
    loadConversations();

    // Auto-refresh intervals
    setInterval(() => {
        loadStats();
        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'TEXTAREA' || activeTag === 'INPUT') return; // Pause refresh if typing
        if (AppState.currentTab === 'inbox') loadConversations();
    }, 15000);

    setInterval(() => {
        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'TEXTAREA' || activeTag === 'INPUT') return; // Pause refresh if typing
        if (AppState.currentTab === 'leads') loadLeads();
    }, 60000);
});
