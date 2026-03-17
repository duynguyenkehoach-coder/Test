import type { Lead } from '../../types/lead'
import { useLeadStore } from '../../store/leadStore'
import { updateLead } from '../../api/leads'
import ScoreBadge from '../ui/ScoreBadge'
import StatusTag from '../ui/StatusTag'
import PlatformIcon from '../ui/PlatformIcon'

interface LeadRowProps {
    lead: Lead
    onSelect: (id: number) => void
}

const TRIVIAL_RE = /^(có|co|yes|ok|oke|không|khong|no|na|\.+|-+)$/i

const CAT_COLORS: Record<string, string> = {
    'THG Fulfillment': '#722ed1',
    Fulfillment: '#722ed1',
    POD: '#722ed1',
    Dropship: '#722ed1',
    'THG Express': '#1890ff',
    Express: '#1890ff',
    'THG Warehouse': '#fa8c16',
    Warehouse: '#fa8c16',
}

function getCatLabel(cat: string): string {
    if (['THG Fulfillment', 'Fulfillment', 'POD', 'Dropship'].includes(cat)) return 'Fulfill'
    if (['THG Express', 'Express'].includes(cat)) return 'Express'
    if (['THG Warehouse', 'Warehouse'].includes(cat)) return 'WH'
    return cat || 'General'
}

function getSmartSummary(lead: Lead): string {
    const candidates = [lead.gap_opportunity, lead.summary, lead.content]
    for (const s of candidates) {
        const trimmed = (s || '').trim()
        if (trimmed.length > 8 && !TRIVIAL_RE.test(trimmed)) {
            return trimmed.substring(0, 140)
        }
    }
    return ''
}




export default function LeadRow({ lead, onSelect }: LeadRowProps) {
    const toggleLanguage = useLeadStore((s) => s.toggleLanguage)
    const isClaimed = !!(lead.claimed_by || lead.assigned_to)
    const summary = getSmartSummary(lead)
    const rawDate = lead.post_created_at || lead.scraped_at || lead.created_at
    const dt = new Date(rawDate.endsWith('Z') ? rawDate : rawDate + 'Z')
    const dateLabel = dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
    const timeLabel = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
    const lang = lead.language || 'foreign'
    const langIcon = lang === 'vietnamese' ? '🇻🇳' : '🌍'
    const langTitle = lang === 'vietnamese' ? 'Khách VN → Bấm đổi thành Foreign' : 'Khách Foreign → Bấm đổi thành VN'

    const handleCatClick = async (e: React.MouseEvent, newCat: string) => {
        e.stopPropagation()
        await updateLead(lead.id, { category: newCat } as Partial<Lead>)
    }

    const catLabel = getCatLabel(lead.category || '')

    return (
        <tr
            className={`${lead.score >= 80 ? 'hot-row' : ''} ${isClaimed ? 'claimed-row' : ''}`}
            onClick={() => onSelect(lead.id)}
        >
            <td style={{ textAlign: 'center' }}>
                <ScoreBadge score={lead.score || 0} />
            </td>

            <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                {lead.post_url ? (
                    <a href={lead.post_url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                        <PlatformIcon platform={lead.platform} isComment={lead.item_type === 'comment'} />
                    </a>
                ) : (
                    <PlatformIcon platform={lead.platform} isComment={lead.item_type === 'comment'} />
                )}
            </td>

            <td onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                        className="lang-toggle"
                        title={langTitle}
                        onClick={(e) => {
                            e.stopPropagation()
                            toggleLanguage(lead.id)
                        }}
                    >
                        {langIcon}
                    </button>
                    {lead.author_url ? (
                        <a
                            href={lead.author_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate"
                            style={{ maxWidth: 120, fontWeight: 500 }}
                        >
                            {lead.author_name || 'Unknown'}
                        </a>
                    ) : (
                        <span className="truncate" style={{ maxWidth: 120, fontWeight: 500 }}>
                            {lead.author_name || 'Unknown'}
                        </span>
                    )}
                    {isClaimed && <span title="Being handled" style={{ marginLeft: 4 }}>⚡</span>}
                </div>
            </td>

            <td>
                <div className="truncate" style={{ maxWidth: 300, color: summary ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {summary || <em style={{ opacity: 0.4, fontSize: 'var(--text-xs)' }}>Chưa có tóm tắt</em>}
                </div>
            </td>

            <td onClick={(e) => e.stopPropagation()}>
                <div className="cat-toggle-group">
                    {(['THG Fulfillment', 'THG Express', 'THG Warehouse'] as const).map((cat) => {
                        const label = getCatLabel(cat)
                        const isActive = catLabel === label
                        const color = CAT_COLORS[cat] || '#8c8c8c'
                        return (
                            <button
                                key={cat}
                                className={`cat-toggle-btn ${isActive ? 'cat-toggle-btn--active' : ''}`}
                                style={isActive ? { background: color, borderColor: color } : {}}
                                onClick={(e) => handleCatClick(e, cat)}
                            >
                                {label}
                            </button>
                        )
                    })}
                </div>
            </td>

            <td>
                <StatusTag status={lead.status || 'new'} />
            </td>

            <td style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                <div>{dateLabel}</div>
                <div>{timeLabel}</div>
            </td>

            <td onClick={(e) => e.stopPropagation()}>
                <button className="btn btn-secondary btn-sm" onClick={() => onSelect(lead.id)}>
                    View →
                </button>
            </td>
        </tr>
    )
}
