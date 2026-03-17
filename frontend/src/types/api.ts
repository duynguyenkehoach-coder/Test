export interface ApiResponse<T = unknown> {
    success?: boolean
    ok?: boolean
    data?: T
    error?: string
    message?: string
    count?: number
}

export interface AuthResponse {
    success: boolean
    ok?: boolean
    token?: string
    user?: string
    error?: string
}

export interface Agent {
    name: string
    tone: string
    personal_note: string
    deals_note: string
    takeover: number
    auto_reply: number
    mode: string
    avatar: string
}

export interface ScanStatus {
    status: string
    count: number
}
