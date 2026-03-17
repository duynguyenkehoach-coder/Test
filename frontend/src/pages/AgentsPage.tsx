import { useEffect, useState } from 'react'
import { apiGet, apiPatch } from '../api/client'

interface AgentProfile {
    name: string; tone: string; personal_note: string; deals_note: string;
    takeover: number; auto_reply: number; mode: string; avatar: string;
}

const STAFF_THEME: Record<string, { hue: string; emoji: string }> = {
    Trang: { hue: '#ec4899', emoji: '💗' },
    Min: { hue: '#8b5cf6', emoji: '💜' },
    Moon: { hue: '#0891b2', emoji: '🩵' },
    'Lê Huyền': { hue: '#d97706', emoji: '🧡' },
    'Ngọc Huyền': { hue: '#059669', emoji: '💚' },
}

const TONES = ['friendly', 'professional', 'concise']

export default function AgentsPage() {
    const [agents, setAgents] = useState<AgentProfile[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        apiGet<{ data: AgentProfile[] }>('/api/agents')
            .then((res) => setAgents(res.data || []))
            .catch(() => { })
            .finally(() => setLoading(false))
    }, [])

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>

    return (
        <div>
            <div className="page-header">
                <h2 className="page-title">🧠 AI Agents</h2>
            </div>
            {agents.length === 0 ? (
                <div className="empty-state" style={{ height: '50vh' }}><div className="empty-state-icon">🧠</div><div className="empty-state-text">No agents configured</div></div>
            ) : (
                <div className="agent-grid">
                    {agents.map((a) => <AgentCard key={a.name} agent={a} />)}
                </div>
            )}
        </div>
    )
}

function AgentCard({ agent }: { agent: AgentProfile }) {
    const [tone, setTone] = useState(agent.tone || 'friendly')
    const [note, setNote] = useState(agent.personal_note || '')
    const [deals, setDeals] = useState(agent.deals_note || '')
    const [takeover, setTakeover] = useState(!!agent.takeover)
    const theme = STAFF_THEME[agent.name] || { hue: '#6366f1', emoji: '🤖' }

    const save = async () => {
        await apiPatch(`/api/agents/${encodeURIComponent(agent.name)}`, { tone, personal_note: note, deals_note: deals })
    }

    const toggleTakeover = async () => {
        const newVal = !takeover
        setTakeover(newVal)
        await apiPatch(`/api/agents/${encodeURIComponent(agent.name)}`, { takeover: newVal ? 1 : 0 })
    }

    return (
        <div className="agent-card" style={{ borderTop: `3px solid ${theme.hue}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
                <div style={{ fontSize: '2rem' }}>{theme.emoji}</div>
                <div>
                    <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{agent.name}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Personal AI Agent</div>
                </div>
                <button
                    className={`btn btn-sm ${takeover ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ marginLeft: 'auto' }}
                    onClick={toggleTakeover}
                >
                    {takeover ? '🟢 Active' : '⚪ Standby'}
                </button>
            </div>

            <div style={{ marginBottom: 'var(--space-md)' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Tone</div>
                <div style={{ display: 'flex', gap: 4 }}>
                    {TONES.map((t) => (
                        <button key={t} className={`btn btn-sm ${tone === t ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTone(t)} style={{ textTransform: 'capitalize' }}>
                            {t === 'friendly' ? '🤝' : t === 'professional' ? '👔' : '⚡'} {t}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ marginBottom: 'var(--space-md)' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Personal Note</div>
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} placeholder="Agent personality notes..." />
            </div>

            <div style={{ marginBottom: 'var(--space-md)' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Deals Context</div>
                <textarea rows={2} value={deals} onChange={(e) => setDeals(e.target.value)} style={{ width: '100%' }} placeholder="Current deals & client info..." />
            </div>

            <button className="btn btn-primary btn-sm" onClick={save}>💾 Save</button>
        </div>
    )
}
