/**
 * API Client — fetch wrapper with JWT auth interceptor
 */

const TOKEN_KEY = 'thg_token'

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
    localStorage.removeItem(TOKEN_KEY)
}

export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = getToken()
    const headers = new Headers(options.headers || {})

    if (token) {
        headers.set('Authorization', `Bearer ${token}`)
    }
    if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
        headers.set('Content-Type', 'application/json')
    }

    const res = await fetch(url, { ...options, headers })

    // Auto-redirect to login on 401
    if (res.status === 401) {
        clearToken()
        window.location.href = '/login'
    }

    return res
}

export async function apiGet<T>(url: string): Promise<T> {
    const res = await authFetch(url)
    return res.json()
}

export async function apiPost<T>(url: string, body: unknown): Promise<T> {
    const res = await authFetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
    })
    return res.json()
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
    const res = await authFetch(url, {
        method: 'PATCH',
        body: JSON.stringify(body),
    })
    return res.json()
}

export async function apiDelete<T>(url: string): Promise<T> {
    const res = await authFetch(url, { method: 'DELETE' })
    return res.json()
}
