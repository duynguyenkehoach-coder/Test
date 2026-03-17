import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'

interface AnalyticsData {
    leadsPerDay: { day: string; count: number }[]
    funnel: { status: string; count: number }[]
    platforms: { platform: string; count: number }[]
    avgScorePerDay: { day: string; avg_score: number; count: number }[]
}

export default function AnalyticsPage() {
    const [data, setData] = useState<AnalyticsData | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        apiGet<{ data: AnalyticsData }>('/api/analytics')
            .then((res) => setData(res.data || null))
            .catch(() => { })
            .finally(() => setLoading(false))
    }, [])

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>

    if (!data) return (
        <div className="empty-state" style={{ height: '60vh' }}>
            <div className="empty-state-icon">📊</div>
            <div className="empty-state-text">No analytics data</div>
        </div>
    )

    const statusColors: Record<string, string> = { new: '#3b82f6', contacted: '#f59e0b', converted: '#10b981', ignored: '#6b7280' }
    const platColors: Record<string, string> = { facebook: '#1877f2', instagram: '#e1306c', tiktok: '#fe2c55' }

    // Compute totals for funnel
    const funnelTotal = data.funnel.reduce((s, f) => s + f.count, 0)
    const maxLeads = Math.max(...data.leadsPerDay.map((d) => d.count), 1)

    return (
        <div>
            <div className="page-header">
                <h2 className="page-title">📊 Analytics</h2>
            </div>

            {/* Leads per Day — CSS bar chart */}
            <div className="chart-card chart-card-wide" style={{ marginBottom: 'var(--space-lg)' }}>
                <div className="chart-title">📈 Leads per Day (14 ngày)</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 160 }}>
                    {data.leadsPerDay.map((d) => (
                        <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{d.count}</span>
                            <div style={{
                                width: '100%', maxWidth: 40, height: `${(d.count / maxLeads) * 120}px`, minHeight: 4,
                                background: 'linear-gradient(to top, rgba(233,69,96,0.4), #e94560)',
                                borderRadius: 'var(--radius-sm)', transition: 'height 0.3s',
                            }} />
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{d.day.slice(5)}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="chart-grid">
                {/* Funnel */}
                <div className="chart-card">
                    <div className="chart-title">🎯 Conversion Funnel</div>
                    {data.funnel.map((f) => {
                        const pct = funnelTotal > 0 ? Math.round((f.count / funnelTotal) * 100) : 0
                        return (
                            <div key={f.status} style={{ marginBottom: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', marginBottom: 4 }}>
                                    <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{f.status}</span>
                                    <span style={{ color: 'var(--text-muted)' }}>{f.count} ({pct}%)</span>
                                </div>
                                <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${pct}%`, background: statusColors[f.status] || '#888', borderRadius: 4, transition: 'width 0.5s' }} />
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Platforms */}
                <div className="chart-card">
                    <div className="chart-title">🌐 Platforms</div>
                    {data.platforms.map((p) => {
                        const platTotal = data.platforms.reduce((s, pp) => s + pp.count, 0)
                        const pct = platTotal > 0 ? Math.round((p.count / platTotal) * 100) : 0
                        return (
                            <div key={p.platform} style={{ marginBottom: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', marginBottom: 4 }}>
                                    <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{p.platform}</span>
                                    <span style={{ color: 'var(--text-muted)' }}>{p.count} ({pct}%)</span>
                                </div>
                                <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${pct}%`, background: platColors[p.platform] || '#888', borderRadius: 4, transition: 'width 0.5s' }} />
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Avg Score per Day */}
                <div className="chart-card chart-card-wide">
                    <div className="chart-title">⭐ Avg Score per Day</div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
                        {data.avgScorePerDay.map((d) => (
                            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)' }}>{Math.round(d.avg_score)}</span>
                                <div style={{
                                    width: '100%', maxWidth: 40, height: `${d.avg_score}px`, minHeight: 4,
                                    background: 'linear-gradient(to top, rgba(245,158,11,0.3), #f59e0b)',
                                    borderRadius: 'var(--radius-sm)',
                                }} />
                                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{d.day.slice(5)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
