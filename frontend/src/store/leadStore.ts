import { create } from 'zustand'
import type { Lead, LeadFilters, LeadStats } from '../types/lead'
import { fetchLeads, fetchLeadStats, updateLead as apiUpdateLead, deleteLead as apiDeleteLead } from '../api/leads'

interface LeadState {
    leads: Lead[]
    stats: LeadStats | null
    filters: LeadFilters
    loading: boolean
    selectedLeadId: number | null

    loadLeads: () => Promise<void>
    loadStats: () => Promise<void>
    setFilters: (f: Partial<LeadFilters>) => void
    selectLead: (id: number | null) => void
    updateLead: (id: number, data: Partial<Lead>) => Promise<void>
    removeLead: (id: number) => Promise<void>
    toggleLanguage: (id: number) => Promise<void>
}

export const useLeadStore = create<LeadState>((set, get) => ({
    leads: [],
    stats: null,
    filters: { exclude_ignored: true },
    loading: false,
    selectedLeadId: null,

    loadLeads: async () => {
        set({ loading: true })
        try {
            const res = await fetchLeads(get().filters)
            set({ leads: res.data || [], loading: false })
        } catch {
            set({ loading: false })
        }
    },

    loadStats: async () => {
        try {
            const res = await fetchLeadStats()
            set({ stats: res.data || null })
        } catch { /* ignore */ }
    },

    setFilters: (f) => {
        set((s) => ({ filters: { ...s.filters, ...f } }))
        // Auto-reload on filter change
        get().loadLeads()
    },

    selectLead: (id) => set({ selectedLeadId: id }),

    updateLead: async (id, data) => {
        await apiUpdateLead(id, data)
        set((s) => ({
            leads: s.leads.map((l) => (l.id === id ? { ...l, ...data } : l)),
        }))
    },

    removeLead: async (id) => {
        await apiDeleteLead(id)
        set((s) => ({
            leads: s.leads.filter((l) => l.id !== id),
            selectedLeadId: s.selectedLeadId === id ? null : s.selectedLeadId,
        }))
    },

    toggleLanguage: async (id) => {
        const lead = get().leads.find((l) => l.id === id)
        if (!lead) return
        const newLang = lead.language === 'vietnamese' ? 'foreign' : 'vietnamese'
        await apiUpdateLead(id, { language: newLang } as Partial<Lead>)
        set((s) => ({
            leads: s.leads.map((l) => (l.id === id ? { ...l, language: newLang } : l)),
        }))
    },
}))
