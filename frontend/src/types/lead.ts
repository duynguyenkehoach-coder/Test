export interface Lead {
    id: number
    platform: 'facebook' | 'instagram' | 'tiktok' | string
    author_name: string
    author_url: string
    author_avatar: string
    post_url: string
    content: string
    score: number
    category: string
    summary: string
    urgency: 'low' | 'medium' | 'high' | 'critical'
    status: 'new' | 'contacted' | 'converted' | 'ignored' | 'claimed'
    role: 'buyer' | 'provider' | 'irrelevant'
    buyer_signals: string
    language: 'vietnamese' | 'foreign'
    source_group: string
    assigned_to: string
    claimed_by: string
    claimed_at: string
    deal_value: number
    winner_staff: string
    pain_score: number
    spam_score: number
    pain_point: string
    item_type: 'post' | 'comment'
    notes: string
    suggested_response: string
    profit_estimate: string
    gap_opportunity: string
    original_post: string
    created_at: string
    post_created_at: string
    scraped_at: string
}

export interface LeadFilters {
    platform?: string
    category?: string
    status?: string
    language?: string
    search?: string
    minScore?: number
    limit?: number
    offset?: number
    exclude_ignored?: boolean
}

export interface LeadStats {
    total: number
    totalViet: number
    totalForeign: number
    today: number
    highValue: number
    avgScore: number
    pending: number
    platformCount: number
    platformDetail: string
    byStatus: Record<string, number>
    byPlatform: Record<string, number>
    byCategory: Record<string, number>
}
