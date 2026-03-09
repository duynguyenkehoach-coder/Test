/**
 * app.js — Main application controller (init, state, tab switching, theme)
 */

// --- Global App State ---
const AppState = {
    leads: [],
    ignoredLeads: [],
    conversations: [],
    dataFiles: [],
    analytics: null,
    currentTab: 'leads',
    searchTimeout: null,
    currentCategory: '',  // '' = All leads, set by sidebar clicks
};

// --- Tab Switching ---
const DATA_SUB_TABS = ['data', 'analytics', 'credits', 'groups'];
const INBOX_SUB_TABS = ['inbox', 'agent', 'salesInbox'];

function switchTab(tabId, person) {
    // 1. Clear ALL active states
    document.querySelectorAll('.nav-item, .nav-sub-item, .nav-sub-item--deep, .nav-item-header').forEach(el => el.classList.remove('active'));

    // 2. Determine which nav element to highlight
    let navElId = null;
    if (tabId === 'agent' && person) {
        const safe = person.replace('Lê Huyền', 'LeHuyen').replace('Ngọc Huyền', 'NgocHuyen').replace(/\s/g, '_');
        navElId = 'tabAgent-' + safe;
    } else if (tabId === 'salesInbox' && person) {
        const safe = person.replace('Lê Huyền', 'LeHuyen').replace('Ngọc Huyền', 'NgocHuyen').replace(/\s/g, '_');
        navElId = 'tabSales-' + safe;
    } else {
        const elMap = { leads: 'tabLeads', inbox: 'tabInbox', ignored: 'tabIgnored', data: 'tabData', analytics: 'tabAnalytics', credits: 'tabCredits', groups: 'tabGroups' };
        navElId = elMap[tabId] || null;
    }
    if (navElId) {
        const el = document.getElementById(navElId);
        if (el) {
            el.classList.add('active');
            if (DATA_SUB_TABS.includes(tabId)) {
                const h = document.querySelector('#navGroupData .nav-item-header');
                if (h) h.classList.add('active');
            }
            if (INBOX_SUB_TABS.includes(tabId)) {
                const h = document.querySelector('#navGroupInbox .nav-item-header');
                if (h) h.classList.add('active');
            }
        }
    }

    // 2. Hide all main content areas
    document.getElementById('leadsTab').style.display = 'none';
    document.getElementById('inboxTab').style.display = 'none';
    const salesInboxEl = document.getElementById('salesInboxTab');
    if (salesInboxEl) salesInboxEl.style.display = 'none';
    const lbTab = document.getElementById('leaderboardTab');
    if (lbTab) lbTab.style.display = 'none';
    document.getElementById('dataTab').style.display = 'none';
    document.getElementById('analyticsTab').style.display = 'none';
    document.getElementById('creditsTab').style.display = 'none';
    document.getElementById('ignoredTab').style.display = 'none';

    const groupsTab = document.getElementById('groupsTab');
    if (groupsTab) groupsTab.style.display = 'none';

    // Stats bar only active on leads
    document.getElementById('statsBar').style.pointerEvents = (tabId === 'leads') ? 'auto' : 'none';
    document.getElementById('statsBar').style.opacity = (tabId === 'leads') ? '1' : '0.5';

    // 3. Show requested tab & update title
    if (tabId === 'leads') {
        document.getElementById('leadsTab').style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'Overview Dashboard';
        loadLeads();
    } else if (tabId === 'inbox') {
        document.getElementById('inboxTab').style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'AI Copilot Inbox';
        loadConversations();
    } else if (tabId === 'agent') {
        const el = document.getElementById('salesInboxTab');
        if (el) el.style.display = 'block';
        document.getElementById('pageTitleText').textContent = person ? `Agent — ${person}` : 'Agents';
        if (typeof loadAgents === 'function') loadAgents(person, null);
    } else if (tabId === 'salesInbox') {
        const el = document.getElementById('salesInboxTab');
        if (el) el.style.display = 'block';
        document.getElementById('pageTitleText').textContent = person ? `Sales Inbox — ${person}` : 'Sales Inbox';
        if (typeof loadAgents === 'function') loadAgents(null, person);
    } else if (tabId === 'data') {
        document.getElementById('dataTab').style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'Data & Archives';
        loadDataFiles();
    } else if (tabId === 'analytics') {
        document.getElementById('analyticsTab').style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'Analytics Center';
        loadAnalytics();
    } else if (tabId === 'credits') {
        document.getElementById('creditsTab').style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'SociaVault Credits';
        loadCredits();
    } else if (tabId === 'ignored') {
        document.getElementById('ignoredTab').style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'Agent Training Data';
        loadIgnoredLeads();
    } else if (tabId === 'groups') {
        if (groupsTab) groupsTab.style.display = 'block';
        document.getElementById('pageTitleText').textContent = 'Group Discovery Database';
        setTimeout(() => {
            if (typeof loadGroups === 'function') loadGroups();
        }, 50);
    } else if (tabId === 'leaderboard') {
        if (lbTab) lbTab.style.display = 'block';
        document.getElementById('pageTitleText').textContent = '🏆 Leaderboard — Hall of Fame';
        if (typeof loadLeaderboard === 'function') loadLeaderboard();
        if (typeof startLiveTicker === 'function') startLiveTicker();
    }
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
