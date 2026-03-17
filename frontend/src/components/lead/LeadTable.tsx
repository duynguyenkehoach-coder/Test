import type { Lead } from '../../types/lead'
import LeadRow from './LeadRow'

interface LeadTableProps {
    leads: Lead[]
    loading: boolean
    onSelectLead: (id: number) => void
}

export default function LeadTable({ leads, loading, onSelectLead }: LeadTableProps) {
    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
                <div className="spinner" />
            </div>
        )
    }

    if (leads.length === 0) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <div className="empty-state-text">Chưa có leads</div>
                <div className="empty-state-sub">Hãy chạy scan hoặc thay đổi bộ lọc</div>
            </div>
        )
    }

    return (
        <div style={{ overflow: 'auto' }}>
            <table className="lead-table">
                <thead>
                    <tr>
                        <th style={{ width: 80 }}>Score</th>
                        <th style={{ width: 90 }}>Platform</th>
                        <th style={{ width: 140 }}>Seller</th>
                        <th>Summary / Opportunity</th>
                        <th style={{ width: 100 }}>Service</th>
                        <th style={{ width: 90 }}>Status</th>
                        <th style={{ width: 70 }}>Time</th>
                        <th style={{ width: 70 }}>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {leads.map((lead) => (
                        <LeadRow key={lead.id} lead={lead} onSelect={onSelectLead} />
                    ))}
                </tbody>
            </table>
        </div>
    )
}
