interface ScoreBadgeProps {
    score: number
}

export default function ScoreBadge({ score }: ScoreBadgeProps) {
    const tier = score >= 80 ? 'hot' : score >= 60 ? 'warm' : 'cold'
    const label = score >= 80 ? '🔥 HOT' : score >= 60 ? '⚡ WARM' : '💤 LOW'

    return (
        <div className={`score-badge score-badge--${tier}`}>
            <span className="score-badge-num">{score}</span>
            <span className="score-badge-label">{label}</span>
        </div>
    )
}
