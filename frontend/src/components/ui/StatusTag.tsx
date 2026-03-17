interface StatusTagProps {
    status: string
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
    new: { label: '● New', cls: 'status-tag--new' },
    contacted: { label: '● Contacted', cls: 'status-tag--contacted' },
    converted: { label: '● Converted', cls: 'status-tag--converted' },
    ignored: { label: '● Ignored', cls: 'status-tag--ignored' },
    claimed: { label: '● Claimed', cls: 'status-tag--contacted' },
}

export default function StatusTag({ status }: StatusTagProps) {
    const info = STATUS_MAP[status] || STATUS_MAP['new']
    return <span className={`status-tag ${info.cls}`}>{info.label}</span>
}
