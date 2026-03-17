import { useEffect, useState } from 'react'
import { apiGet, apiPatch, apiPost } from '../api/client'

interface Conversation {
    id: number; sender_name: string; message: string; ai_suggestion: string;
    sale_reply: string; intent: string; status: string; platform: string; created_at: string;
}

const INTENT_EMOJI: Record<string, string> = { price_inquiry: '💰', service_inquiry: '📋', urgent_need: '🔥', general: '💬', spam: '🚫' }
const STATUS_COLORS: Record<string, string> = { pending: '#f59e0b', replied: '#10b981', ignored: '#6b7280' }

export default function InboxPage() {
    const [convos, setConvos] = useState<Conversation[]>([])
    const [filter, setFilter] = useState('')
    const [loading, setLoading] = useState(true)

    const load = () => {
        setLoading(true)
        const qs = filter ? `?status=${filter}` : ''
        apiGet<{ data: Conversation[]; count: number }>(`/api/conversations${qs}`)
            .then((res) => setConvos(res.data || []))
            .catch(() => { })
            .finally(() => setLoading(false))
    }

    useEffect(load, [filter])

    const markReplied = async (id: number, reply: string) => {
        await apiPatch(`/api/conversations/${id}`, { sale_reply: reply, status: 'replied' })
        load()
    }

    const ignore = async (id: number) => {
        await apiPatch(`/api/conversations/${id}`, { status: 'ignored' })
        load()
    }

    const regen = async (id: number, setter: (v: string) => void) => {
        const res = await apiPost<{ data: { ai_suggestion: string } }>(`/api/conversations/${id}/regenerate`, {})
        if (res.data?.ai_suggestion) setter(res.data.ai_suggestion)
    }

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>

    return (
        <div>
            <div className="page-header">
                <h2 className="page-title">💬 Inbox <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', fontWeight: 400 }}>({convos.length})</span></h2>
                <select className="filter-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="">All</option>
                    <option value="pending">⏳ Pending</option>
                    <option value="replied">✅ Replied</option>
                    <option value="ignored">⛔ Ignored</option>
                </select>
            </div>

            {convos.length === 0 ? (
                <div className="empty-state" style={{ height: '50vh' }}>
                    <div className="empty-state-icon">📬</div>
                    <div className="empty-state-text">No messages yet</div>
                    <div className="empty-state-sub">Messages from Facebook Messenger will appear here with AI-drafted replies.</div>
                </div>
            ) : convos.map((conv) => <ConvCard key={conv.id} conv={conv} onReplied={markReplied} onIgnore={ignore} onRegen={regen} />)}
        </div>
    )
}

function ConvCard({ conv, onReplied, onIgnore, onRegen }: {
    conv: Conversation; onReplied: (id: number, reply: string) => void;
    onIgnore: (id: number) => void; onRegen: (id: number, setter: (v: string) => void) => void;
}) {
    const [reply, setReply] = useState(conv.sale_reply || conv.ai_suggestion || '')

    return (
        <div className={`conv-card ${conv.status === 'pending' ? 'conv-pending' : ''}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)', flexWrap: 'wrap' }}>
                <span style={{ background: `${STATUS_COLORS[conv.status] || '#6b7280'}20`, color: STATUS_COLORS[conv.status], padding: '2px 10px', borderRadius: 'var(--radius-full)', fontWeight: 600, fontSize: 'var(--text-xs)' }}>
                    {conv.status === 'pending' ? '⏳' : conv.status === 'replied' ? '✅' : '⛔'} {conv.status}
                </span>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>📘 {conv.platform || 'Messenger'}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{INTENT_EMOJI[conv.intent] || '💬'} {conv.intent || 'general'}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>{new Date(conv.created_at).toLocaleString('vi-VN')}</span>
            </div>

            <div style={{ fontWeight: 600, marginBottom: 'var(--space-sm)' }}>👤 {conv.sender_name || 'Unknown'}</div>

            <div style={{ background: 'var(--bg-elevated)', padding: 'var(--space-md)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-md)' }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>🗣️ Khách nói:</div>
                <div style={{ fontSize: 'var(--text-sm)' }}>"{conv.message}"</div>
            </div>

            <div style={{ marginBottom: 'var(--space-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>🤖 AI Copilot Draft</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => onRegen(conv.id, setReply)}>🔄 Regen</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(reply)}>📋 Copy</button>
                    </div>
                </div>
                <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} style={{ width: '100%' }} />
            </div>

            {conv.status === 'pending' && (
                <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                    <button className="btn btn-primary btn-sm" onClick={() => onReplied(conv.id, reply)}>✅ Mark as Replied</button>
                    <button className="btn btn-danger btn-sm" onClick={() => onIgnore(conv.id)}>⛔ Ignore</button>
                </div>
            )}
        </div>
    )
}
