import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../api/client'

interface Group {
    url: string; name: string; category: string; status: string; members: number;
    last_scraped: string; posts_found: number; notes: string;
}
interface GroupStats { total: number; active: number; paused: number; by_category: Record<string, number> }

const CAT_ICONS: Record<string, string> = { fulfillment: '🏭', express: '✈️', warehouse: '🏢', mixed: '🔀' }

function formatMembers(n: number) {
    if (!n) return '—'
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

export default function GroupsPage() {
    const [groups, setGroups] = useState<Group[]>([])
    const [stats, setStats] = useState<GroupStats | null>(null)
    const [loading, setLoading] = useState(true)
    const [catFilter, setCatFilter] = useState('')
    const [statusFilter, setStatusFilter] = useState('')
    const [showAdd, setShowAdd] = useState(false)
    const [newGroup, setNewGroup] = useState({ name: '', url: '', category: 'fulfillment', notes: '' })

    const load = () => {
        setLoading(true)
        const params = new URLSearchParams()
        if (catFilter) params.set('category', catFilter)
        if (statusFilter) params.set('status', statusFilter)
        apiGet<{ data: Group[] }>(`/api/groups?${params}`).then((r) => setGroups(r.data || [])).catch(() => { }).finally(() => setLoading(false))
        apiGet<{ data: GroupStats }>('/api/groups/stats').then((r) => setStats(r.data || null)).catch(() => { })
    }

    useEffect(load, [catFilter, statusFilter])

    const addGroup = async () => {
        if (!newGroup.name || !newGroup.url) return
        await apiPost('/api/groups', newGroup)
        setShowAdd(false)
        setNewGroup({ name: '', url: '', category: 'fulfillment', notes: '' })
        load()
    }

    const toggleStatus = async (url: string, newStatus: string) => {
        await apiPatch(`/api/groups/${encodeURIComponent(url)}/status`, { status: newStatus })
        load()
    }

    return (
        <div>
            <div className="page-header">
                <h2 className="page-title">👥 Groups <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', fontWeight: 400 }}>({groups.length})</span></h2>
                <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>+ Add Group</button>
            </div>

            {stats && (
                <div className="stat-grid">
                    <div className="stat-card"><div className="stat-card-icon">📦</div><div className="stat-card-value">{stats.total}</div><div className="stat-card-label">Total Groups</div></div>
                    <div className="stat-card"><div className="stat-card-icon">✅</div><div className="stat-card-value" style={{ color: 'var(--success)' }}>{stats.active}</div><div className="stat-card-label">Active</div></div>
                    <div className="stat-card"><div className="stat-card-icon">⏸️</div><div className="stat-card-value" style={{ color: 'var(--warning)' }}>{stats.paused}</div><div className="stat-card-label">Paused</div></div>
                    {Object.entries(stats.by_category || {}).map(([cat, cnt]) => (
                        <div className="stat-card" key={cat}><div className="stat-card-icon">{CAT_ICONS[cat] || '📁'}</div><div className="stat-card-value">{cnt}</div><div className="stat-card-label" style={{ textTransform: 'capitalize' }}>{cat}</div></div>
                    ))}
                </div>
            )}

            {showAdd && (
                <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
                    <div className="card-title">➕ Add New Group</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
                        <input placeholder="Group Name" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
                        <input placeholder="Group URL" value={newGroup.url} onChange={(e) => setNewGroup({ ...newGroup, url: e.target.value })} />
                        <select value={newGroup.category} onChange={(e) => setNewGroup({ ...newGroup, category: e.target.value })}>
                            <option value="fulfillment">🏭 Fulfillment</option>
                            <option value="express">✈️ Express</option>
                            <option value="warehouse">🏢 Warehouse</option>
                            <option value="mixed">🔀 Mixed</option>
                        </select>
                        <input placeholder="Notes" value={newGroup.notes} onChange={(e) => setNewGroup({ ...newGroup, notes: e.target.value })} />
                    </div>
                    <div style={{ marginTop: 'var(--space-md)', display: 'flex', gap: 'var(--space-sm)' }}>
                        <button className="btn btn-primary btn-sm" onClick={addGroup}>💾 Save</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setShowAdd(false)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="filters-bar">
                <select className="filter-select" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                    <option value="">All Categories</option>
                    <option value="fulfillment">🏭 Fulfillment</option>
                    <option value="express">✈️ Express</option>
                    <option value="warehouse">🏢 Warehouse</option>
                    <option value="mixed">🔀 Mixed</option>
                </select>
                <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="">All Status</option>
                    <option value="active">✅ Active</option>
                    <option value="paused">⏸️ Paused</option>
                </select>
            </div>

            {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div> : groups.length === 0 ? (
                <div className="empty-state"><div className="empty-state-icon">👥</div><div className="empty-state-text">No groups found</div></div>
            ) : (
                <div style={{ overflow: 'auto' }}>
                    <table className="group-table">
                        <thead><tr><th>Name</th><th>Category</th><th>Members</th><th>Status</th><th>Last Scraped</th><th>Posts</th><th>Actions</th></tr></thead>
                        <tbody>
                            {groups.map((g) => (
                                <tr key={g.url}>
                                    <td><a href={g.url} target="_blank" rel="noopener noreferrer" className="truncate" style={{ maxWidth: 200, display: 'inline-block' }}>{g.name}</a></td>
                                    <td><span style={{ textTransform: 'capitalize' }}>{CAT_ICONS[g.category] || '📁'} {g.category}</span></td>
                                    <td>{formatMembers(g.members)}</td>
                                    <td>{g.status === 'active' ? <span style={{ color: 'var(--success)' }}>✅ Active</span> : <span style={{ color: 'var(--warning)' }}>⏸️ Paused</span>}</td>
                                    <td style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{g.last_scraped ? new Date(g.last_scraped).toLocaleDateString('vi-VN') : '—'}</td>
                                    <td>{g.posts_found || 0}</td>
                                    <td><button className="btn btn-secondary btn-sm" onClick={() => toggleStatus(g.url, g.status === 'active' ? 'paused' : 'active')}>{g.status === 'active' ? '⏸️' : '▶️'}</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}
