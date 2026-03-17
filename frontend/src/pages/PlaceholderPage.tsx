export default function PlaceholderPage({ title, icon }: { title: string; icon: string }) {
    return (
        <div className="empty-state" style={{ height: '60vh' }}>
            <div className="empty-state-icon">{icon}</div>
            <div className="empty-state-text">{title}</div>
            <div className="empty-state-sub">Sẽ được phát triển trong Phase 2</div>
        </div>
    )
}
