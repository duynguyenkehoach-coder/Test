import { useLeadStore } from '../../store/leadStore'
import { useAuthStore } from '../../store/authStore'

interface TopBarProps {
    title?: string
}

export default function TopBar({ title }: TopBarProps) {
    const { filters, setFilters } = useLeadStore()
    const logout = useAuthStore((s) => s.logout)

    return (
        <header className="app-topbar">
            {title && (
                <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {title}
                </h1>
            )}

            <div className="topbar-search">
                <span className="topbar-search-icon">🔍</span>
                <input
                    type="text"
                    placeholder="Tìm kiếm leads..."
                    defaultValue={filters.search || ''}
                    onChange={(e) => {
                        const value = e.target.value
                        clearTimeout((window as unknown as Record<string, ReturnType<typeof setTimeout>>).__searchTimer)
                            ; (window as unknown as Record<string, ReturnType<typeof setTimeout>>).__searchTimer = setTimeout(() => {
                                setFilters({ search: value || undefined })
                            }, 400)
                    }}
                />
            </div>

            <div className="topbar-actions">
                <button className="topbar-btn" title="Logout" onClick={logout}>
                    🚪 Logout
                </button>
            </div>
        </header>
    )
}
