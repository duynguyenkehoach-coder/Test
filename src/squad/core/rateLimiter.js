/**
 * Rate Limiter — Enforce quotas and cooldowns per account
 * Prevents account bans by limiting action frequency.
 * 
 * @module squad/core/rateLimiter
 */
const config = require('../squadConfig');

/**
 * Check if an account can perform a specific action
 * @param {object} squadDB - squadDB instance
 * @param {string} account - Account email/name
 * @param {string} actionType - 'comment' or 'post'
 * @returns {{ allowed: boolean, reason: string, nextAllowedAt: Date|null }}
 */
function canAct(squadDB, account, actionType) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Rule 1: Check daily quota
    const todayCount = squadDB.getActionCountToday(account, actionType);
    const maxPerDay = actionType === 'comment'
        ? config.SNIPER_MAX_PER_DAY
        : config.BROADCASTER_MAX_PER_DAY;

    if (todayCount >= maxPerDay) {
        return {
            allowed: false,
            reason: `Đã đạt quota ${actionType}: ${todayCount}/${maxPerDay}/ngày`,
            nextAllowedAt: _nextMidnight(),
        };
    }

    // Rule 2: Check cooldown since last action of same type
    const lastAction = squadDB.getLastAction(account, actionType);
    if (lastAction) {
        const cooldownMs = actionType === 'comment'
            ? config.SNIPER_COOLDOWN_MINUTES * 60 * 1000
            : config.BROADCASTER_COOLDOWN_MINUTES * 60 * 1000;

        const elapsed = Date.now() - new Date(lastAction.created_at).getTime();
        if (elapsed < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
            return {
                allowed: false,
                reason: `Cooldown: còn ${remaining} phút trước khi ${actionType} tiếp`,
                nextAllowedAt: new Date(Date.now() + (cooldownMs - elapsed)),
            };
        }
    }

    // Rule 3: Separation rule — comment day ≠ post day
    if (config.SEPARATION_RULE) {
        const otherType = actionType === 'comment' ? 'post' : 'comment';
        const otherCount = squadDB.getActionCountToday(account, otherType);
        if (otherCount > 0) {
            return {
                allowed: false,
                reason: `Luật tách biệt: ${account} đã ${otherType} hôm nay → cấm ${actionType}`,
                nextAllowedAt: _nextMidnight(),
            };
        }
    }

    return { allowed: true, reason: 'OK', nextAllowedAt: null };
}

function _nextMidnight() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
}

module.exports = { canAct };
