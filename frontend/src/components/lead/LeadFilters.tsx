import { useLeadStore } from '../../store/leadStore'

export default function LeadFilters() {
    const { filters, setFilters } = useLeadStore()

    return (
        <div className="filters-bar">
            <select
                className="filter-select"
                value={filters.platform || ''}
                onChange={(e) => setFilters({ platform: e.target.value || undefined })}
            >
                <option value="">All Platforms</option>
                <option value="facebook">📘 Facebook</option>
                <option value="instagram">📷 Instagram</option>
                <option value="tiktok">🎵 TikTok</option>
            </select>

            <select
                className="filter-select"
                value={filters.category || ''}
                onChange={(e) => setFilters({ category: e.target.value || undefined })}
            >
                <option value="">All Services</option>
                <option value="THG Fulfillment">🏭 Fulfillment</option>
                <option value="THG Express">✈️ Express</option>
                <option value="THG Warehouse">🏢 Warehouse</option>
            </select>

            <select
                className="filter-select"
                value={filters.status || ''}
                onChange={(e) => setFilters({ status: e.target.value || undefined })}
            >
                <option value="">All Status</option>
                <option value="new">● New</option>
                <option value="contacted">● Contacted</option>
                <option value="converted">● Converted</option>
                <option value="ignored">● Ignored</option>
            </select>

            <select
                className="filter-select"
                value={filters.language || ''}
                onChange={(e) => setFilters({ language: e.target.value || undefined })}
            >
                <option value="">🌐 All Languages</option>
                <option value="vietnamese">🇻🇳 Vietnamese</option>
                <option value="foreign">🌍 Foreign</option>
            </select>
        </div>
    )
}
