import { NavLink, useLocation } from 'react-router-dom'

const TABS = [
    { to: '/', icon: '🎯', label: 'Leads' },
    { to: '/analytics', icon: '📊', label: 'Analytics' },
    { to: '/inbox', icon: '💬', label: 'Inbox' },
    { to: '/groups', icon: '👥', label: 'Groups' },
    { to: '/agents', icon: '🧠', label: 'Agents' },
]

export default function MobileNav() {
    const location = useLocation()

    return (
        <nav className="mobile-nav">
            <div className="mobile-nav-items">
                {TABS.map((tab) => {
                    const isActive = tab.to === '/'
                        ? location.pathname === '/'
                        : location.pathname.startsWith(tab.to)

                    return (
                        <NavLink key={tab.to} to={tab.to} className={() => ''}>
                            <div className={`mobile-nav-item ${isActive ? 'mobile-nav-item--active' : ''}`}>
                                <span className="mobile-nav-item-icon">{tab.icon}</span>
                                <span>{tab.label}</span>
                            </div>
                        </NavLink>
                    )
                })}
            </div>
        </nav>
    )
}
