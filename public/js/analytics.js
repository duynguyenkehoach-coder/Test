/**
 * analytics.js — Analytics charts rendering with Chart.js
 */

let chartsLoaded = false;
let leadsChart = null;
let funnelChart = null;
let platformChart = null;
let scoreChart = null;

async function loadAnalytics() {
    try {
        const res = await fetch('/api/analytics');
        const { data } = await res.json();
        AppState.analytics = data;
        renderAnalytics(data);
    } catch (err) {
        console.error('Failed to load analytics:', err);
    }
}

function renderAnalytics(data) {
    const container = document.getElementById('analyticsGrid');
    if (!data) {
        container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><h3>No data</h3></div>`;
        return;
    }

    container.innerHTML = `
    <div class="chart-grid">
      <div class="chart-card chart-card-wide">
        <h3 class="chart-title">📈 Leads per Day (14 ngày)</h3>
        <canvas id="leadsPerDayChart"></canvas>
      </div>
      <div class="chart-card">
        <h3 class="chart-title">🎯 Conversion Funnel</h3>
        <canvas id="funnelChart"></canvas>
      </div>
      <div class="chart-card">
        <h3 class="chart-title">🌐 Platforms</h3>
        <canvas id="platformChart"></canvas>
      </div>
      <div class="chart-card chart-card-wide">
        <h3 class="chart-title">⭐ Avg Score (14 ngày)</h3>
        <canvas id="scoreChart"></canvas>
      </div>
    </div>
  `;

    drawLeadsPerDayChart(data.leadsPerDay || []);
    drawFunnelChart(data.funnel || []);
    drawPlatformChart(data.platforms || []);
    drawScoreChart(data.avgScorePerDay || []);
}

function chartColors() {
    const isLight = document.body.classList.contains('light-mode');
    return {
        grid: isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)',
        text: isLight ? '#555' : '#a0a0b0',
    };
}

function drawLeadsPerDayChart(leadsPerDay) {
    const ctx = document.getElementById('leadsPerDayChart').getContext('2d');
    const c = chartColors();
    if (leadsChart) leadsChart.destroy();
    leadsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: leadsPerDay.map(d => d.day.slice(5)), // MM-DD
            datasets: [{
                label: 'Leads',
                data: leadsPerDay.map(d => d.count),
                backgroundColor: 'rgba(233, 69, 96, 0.6)',
                borderColor: '#e94560',
                borderWidth: 2,
                borderRadius: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid } },
                x: { ticks: { color: c.text }, grid: { display: false } },
            }
        }
    });
}

function drawFunnelChart(funnel) {
    const ctx = document.getElementById('funnelChart').getContext('2d');
    const c = chartColors();
    const statusColors = {
        new: '#3b82f6', contacted: '#f59e0b', converted: '#10b981', ignored: '#6b7280'
    };
    if (funnelChart) funnelChart.destroy();
    funnelChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: funnel.map(f => f.status),
            datasets: [{
                data: funnel.map(f => f.count),
                backgroundColor: funnel.map(f => statusColors[f.status] || '#888'),
                borderWidth: 0,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: { position: 'bottom', labels: { color: c.text, padding: 16, font: { size: 12 } } },
            }
        }
    });
}

function drawPlatformChart(platforms) {
    const ctx = document.getElementById('platformChart').getContext('2d');
    const c = chartColors();
    const platColors = {
        facebook: '#1877f2', instagram: '#e1306c', reddit: '#ff4500',
        twitter: '#1da1f2', tiktok: '#fe2c55',
    };
    if (platformChart) platformChart.destroy();
    platformChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: platforms.map(p => p.platform),
            datasets: [{
                data: platforms.map(p => p.count),
                backgroundColor: platforms.map(p => platColors[p.platform] || '#888'),
                borderWidth: 0,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: { position: 'bottom', labels: { color: c.text, padding: 16, font: { size: 12 } } },
            }
        }
    });
}

function drawScoreChart(avgScorePerDay) {
    const ctx = document.getElementById('scoreChart').getContext('2d');
    const c = chartColors();
    if (scoreChart) scoreChart.destroy();
    scoreChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: avgScorePerDay.map(d => d.day.slice(5)),
            datasets: [
                {
                    label: 'Avg Score',
                    data: avgScorePerDay.map(d => d.avg_score),
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#f59e0b',
                },
                {
                    label: 'Leads',
                    data: avgScorePerDay.map(d => d.count),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#3b82f6',
                    yAxisID: 'y1',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: c.text } }
            },
            scales: {
                y: { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid }, title: { display: true, text: 'Score', color: c.text } },
                y1: { position: 'right', beginAtZero: true, ticks: { color: c.text }, grid: { display: false }, title: { display: true, text: 'Count', color: c.text } },
                x: { ticks: { color: c.text }, grid: { display: false } },
            }
        }
    });
}
