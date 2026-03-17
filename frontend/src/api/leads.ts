import { apiGet, apiPatch, apiDelete, apiPost } from './client'
import type { Lead, LeadFilters, LeadStats } from '../types/lead'
import type { ApiResponse } from '../types/api'

export async function fetchLeads(filters: LeadFilters = {}) {
    const params = new URLSearchParams()
    if (filters.platform) params.set('platform', filters.platform)
    if (filters.category) params.set('category', filters.category)
    if (filters.status) params.set('status', filters.status)
    if (filters.language) params.set('language', filters.language)
    if (filters.search) params.set('search', filters.search)
    if (filters.minScore) params.set('minScore', String(filters.minScore))
    if (filters.limit) params.set('limit', String(filters.limit))
    if (filters.offset) params.set('offset', String(filters.offset))
    if (filters.exclude_ignored) params.set('exclude_ignored', 'true')

    const qs = params.toString()
    return apiGet<ApiResponse<Lead[]>>(`/api/leads${qs ? '?' + qs : ''}`)
}

export async function fetchLeadById(id: number) {
    return apiGet<ApiResponse<Lead>>(`/api/leads/${id}`)
}

export async function fetchLeadStats() {
    return apiGet<ApiResponse<LeadStats>>('/api/stats')
}

export async function updateLead(id: number, data: Partial<Lead>) {
    return apiPatch<ApiResponse<Lead>>(`/api/leads/${id}`, data)
}

export async function deleteLead(id: number) {
    return apiDelete<ApiResponse>(`/api/leads/${id}`)
}

export async function sendFeedback(
    id: number,
    feedback: { type: string; correct_role?: string; note?: string }
) {
    return apiPost<ApiResponse>(`/api/leads/${id}/feedback`, feedback)
}

export async function closeDeal(
    id: number,
    data: { winner_staff: string; deal_value: number; note?: string }
) {
    return apiPost<ApiResponse>(`/api/leads/${id}/close`, data)
}
