interface PlatformIconProps {
    platform: string
    isComment?: boolean
}

const PLATFORM_MAP: Record<string, { icon: string; label: string; color: string }> = {
    facebook: { icon: '📘', label: 'Facebook', color: '#1877f2' },
    instagram: { icon: '📷', label: 'Instagram', color: '#e1306c' },
    tiktok: { icon: '🎵', label: 'TikTok', color: '#ff0050' },
}

export default function PlatformIcon({ platform, isComment }: PlatformIconProps) {
    const info = PLATFORM_MAP[platform] || { icon: '🌐', label: platform || 'Web', color: '#8c8c8c' }
    const icon = isComment ? '💬' : info.icon
    const label = isComment ? 'Comment' : info.label
    const color = isComment ? '#f59e0b' : info.color

    return (
        <div className="platform-icon">
            <span className="platform-icon-emoji">{icon}</span>
            <span className="platform-icon-label" style={{ color }}>{label}</span>
        </div>
    )
}
