import { create } from 'zustand'
import { getToken, clearToken } from '../api/client'

interface AuthState {
    isAuthenticated: boolean
    user: string | null
    checkAuth: () => void
    setAuth: (user: string) => void
    logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
    isAuthenticated: !!getToken(),
    user: null,
    checkAuth: () => {
        set({ isAuthenticated: !!getToken() })
    },
    setAuth: (user: string) => {
        set({ isAuthenticated: true, user })
    },
    logout: () => {
        clearToken()
        set({ isAuthenticated: false, user: null })
    },
}))
