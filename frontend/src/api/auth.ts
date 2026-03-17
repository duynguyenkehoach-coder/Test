import { setToken, clearToken } from './client'
import type { AuthResponse } from '../types/api'

export async function login(password: string, email?: string): Promise<AuthResponse> {
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
    })
    const data: AuthResponse = await res.json()
    if ((data.success || data.ok) && data.token) {
        setToken(data.token)
        if (data.user) localStorage.setItem('thg_user', JSON.stringify(data.user))
    }
    return data
}

export function logout() {
    clearToken()
    localStorage.removeItem('thg_user')
    window.location.href = '/login'
}
