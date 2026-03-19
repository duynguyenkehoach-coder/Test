/**
 * ProviderGuard Orchestrator v1.0
 *
 * Runs BEFORE the AI classifier (zero AI cost, pure regex + DB lookup).
 * Detects provider accounts masquerading as buyers, especially:
 *   - Providers self-commenting on their own posts (seeding)
 *   - Known provider authors (from DB history)
 *   - Comments under provider ads without real buyer signals
 *   - Account names that are clearly businesses
 *
 * BUYER-FRIENDLINESS RULES:
 *   - Real buyers RARELY share phone numbers → phone = strong provider signal
 *   - Real buyers may comment under provider ads if genuinely asking
 *   - Short, informal, non-CTA comments = more likely buyer than provider
 *   - Over-filtering is worse than under-filtering (miss = lose lead)
 */

'use strict';

// ─── Provider name patterns (business accounts, not individuals) ───────────
const PROVIDER_NAME_REGEX = /\b(logistics|express|shipping|freight|forwarder|fulfillment|vận chuyển|giao hàng|chuyển phát|nhận ship|nhận gửi|dịch vụ ship|box me|saigon bay|ecoli|ak47|burgerprints|bestexpress|northpointe|ems|vnpost|viettel post|j&t|giao hàng nhanh|giao tiết kiệm|ship4u|epack|cargo|hàng không|sea freight|bưu kiện)\b/i;

// ─── Provider post regex (same logic as leadQualifier but extracted here) ─
// A subset of the strongest provider-post signals (not exhaustive)
const PROVIDER_POST_REGEX = /(chúng tôi nhận gửi|quy trình gửi hàng|nhận gửi hàng đi|chuyên tuyến việt|cước phí cạnh tranh|cam kết giao tận tay|chỉ từ \d+k|giá ship từ|bảng giá ship|đặt ship ngay|nhận vận chuyển|dịch vụ gửi|giao hàng nhanh nội|ship cod|lh em ngay|liên hệ em|ib em ngay|inbox em|Biển:\s*\d|Bay:\s*\d|Zalo\s*\/\s*Hotline|dạ em nhận|em chuyên nhận|bên em chuyên|bên em nhận|bên mình chuyên|bên mình nhận|chúng tôi chuyên|chuyên vận chuyển|chuyên nhận gửi|nhận ship hàng|nhận đơn từ|tiếp nhận đơn|epacket|our warehouse|we ship|we offer|contact us.*whatsapp|just launched.*(fulfillment|warehouse)|free quote|get started today|customs clearance included)/i;

// ─── Strong buyer signals (questions, pain, comparison-seeking) ────────────
const STRONG_BUYER_REGEX = /(cho hỏi|nhờ ai|ai biết|chỗ nào|ở đâu|nên chọn|nên dùng|so sánh|xin giá|báo giá giúp|review giúp|recommend|tìm đơn vị|tìm kho|tìm bên|tìm supplier|muốn bắt đầu|mới bắt đầu|lần đầu|chưa biết|không biết|đang tìm|có ai|ai có|cần gấp|giúp em|giúp mình|suggest|tư vấn giúp|hỏi bên nào|rate\?|check giá|giá như thế nào|ship bao lâu|mất bao lâu|ai dùng rồi|ai có kinh nghiệm|mình cần|em cần|mình đang|em đang|ai xài qua|xài bao giờ chưa|có review|có ai dùng|bên nào uy tín|đơn vị nào|có rẻ hơn không|chi phí khoảng bao|hết bao nhiêu|tốn khoảng|khoảng bao nhiêu tiền)/i;

/**
 * Build the author-provider set from database for this scan batch.
 * Returns a Set of author_url strings known to be providers.
 * @param {object} database - The database module
 * @returns {Set<string>}
 */
function buildKnownProviderSet(database) {
    try {
        const rows = database.db.prepare(`
      SELECT author_url, COUNT(*) as cnt
      FROM leads
      WHERE role = 'provider'
        AND author_url IS NOT NULL
        AND author_url != ''
      GROUP BY author_url
      HAVING cnt >= 2
    `).all();
        return new Set(rows.map(r => r.author_url.toLowerCase().trim()));
    } catch (e) {
        return new Set();
    }
}

/**
 * Build a set of author_names known to be providers (for name-based matching).
 * @param {object} database
 * @returns {Set<string>}
 */
function buildKnownProviderNameSet(database) {
    try {
        const rows = database.db.prepare(`
      SELECT DISTINCT author_name
      FROM leads
      WHERE role = 'provider'
        AND author_name IS NOT NULL
        AND author_name != ''
    `).all();
        return new Set(rows.map(r => r.author_name.toLowerCase().trim()));
    } catch (e) {
        return new Set();
    }
}

/**
 * Main guard function. Called per-post BEFORE sending to AI.
 *
 * @param {object} post - Lead/post object with fields:
 *   item_type, author_url, author_name, parent_excerpt,
 *   content, post_url
 * @param {Set<string>} knownProviderUrls   - Built once per batch via buildKnownProviderSet()
 * @param {Set<string>} knownProviderNames  - Built once per batch via buildKnownProviderNameSet()
 * @param {number}      painScore           - Already computed pain score
 * @param {number}      spamScore           - Already computed spam score
 *
 * @returns {{ blocked: boolean, reason: string, layer: string } | null}
 *   null if not blocked, object with reason if blocked
 */
function runProviderGuard(post, knownProviderUrls, knownProviderNames, painScore = 0, spamScore = 0) {
    const content = (post.content || '').trim();
    const parentExcerpt = (post.parent_excerpt || '').trim();
    const authorName = (post.author_name || '').trim();
    const authorUrl = (post.author_url || '').toLowerCase().trim();
    const isComment = post.item_type === 'comment';

    // ════════════════════════════════════════════════════════════
    // LAYER G1 — Self-comment detection
    // Provider posts their own promo post, then comments on it
    // Maps to the "Mỹ Phúc" case exactly
    // ════════════════════════════════════════════════════════════
    if (isComment && parentExcerpt && PROVIDER_POST_REGEX.test(parentExcerpt)) {
        // Check if author of the comment is the same as the post author
        // We detect this via: comment author_url appears in parent post's author context
        // Since we store parent_excerpt (not parent author_url), we use another heuristic:
        // If author_name appears in parent_excerpt AND parent is a provider post → likely self-promo seeding
        if (authorName && parentExcerpt.toLowerCase().includes(authorName.toLowerCase())) {
            return {
                blocked: true,
                layer: 'G1',
                reason: `G1: Tác giả "${authorName}" tự comment seeding trên bài quảng cáo của mình`,
            };
        }
    }

    // ════════════════════════════════════════════════════════════
    // LAYER G2 — Known provider author (DB memory)
    // Author URL has been classified as provider ≥ 2 times before
    // ════════════════════════════════════════════════════════════
    if (authorUrl && knownProviderUrls.has(authorUrl)) {
        // Even a known provider might genuinely ask a question
        // Only block if they DON'T show strong buyer pain signals
        if (painScore < 3) {
            return {
                blocked: true,
                layer: 'G2',
                reason: `G2: Author URL "${authorUrl}" đã được xác định là provider trong lịch sử (painScore=${painScore})`,
            };
        }
        // If painScore ≥ 3 with known provider: still let through — might be a competitor
        // shopping for services (valid conversion opportunity)
        console.log(`[ProviderGuard] ⚠️ G2: Known provider "${authorName}" but high painScore=${painScore} — letting through`);
    }

    // ════════════════════════════════════════════════════════════
    // LAYER G2b — Known provider name (DB memory)
    // Exact author_name match to previously flagged providers
    // ════════════════════════════════════════════════════════════
    if (authorName && knownProviderNames.has(authorName.toLowerCase()) && painScore < 2) {
        return {
            blocked: true,
            layer: 'G2b',
            reason: `G2b: Tên tác giả "${authorName}" đã từng bị mark là provider`,
        };
    }

    // ════════════════════════════════════════════════════════════
    // LAYER G3 — Parent post context (comment-only)
    // The parent post is a provider advertisement → scrutinize comment
    //
    // BUYER-FRIENDLY: A REAL BUYER can still comment under a provider ad!
    // e.g., "Bên bạn ship đi PA không?" is a valid lead.
    // We only block if the comment ITSELF is also provider-like OR has no buyer signals.
    // ════════════════════════════════════════════════════════════
    if (isComment && parentExcerpt && PROVIDER_POST_REGEX.test(parentExcerpt)) {
        const commentIsAlsoProvider = PROVIDER_POST_REGEX.test(content);
        const hasStrongBuyerSignal = painScore >= 3 || STRONG_BUYER_REGEX.test(content);

        if (commentIsAlsoProvider) {
            // Comment itself is advertising → definitely provider seeding
            return {
                blocked: true,
                layer: 'G3',
                reason: `G3: Comment dưới bài provider VÀ comment cũng có nội dung quảng cáo dịch vụ`,
            };
        }

        if (!hasStrongBuyerSignal) {
            // Ambiguous: comment under provider post, no buyer signal
            // Examples: short reaction, "ok", "bên bạn có không", etc.
            // Block because low buyer signal under provider post = likely noise
            return {
                blocked: true,
                layer: 'G3',
                reason: `G3: Comment dưới bài provider, không có tín hiệu buyer rõ ràng (painScore=${painScore})`,
            };
        }

        // Buyer signal present under provider post → let through (could be genuine inquiry)
        console.log(`[ProviderGuard] ✅ G3: Comment dưới bài provider nhưng có buyer signal mạnh (painScore=${painScore}) — letting through`);
    }

    // ════════════════════════════════════════════════════════════
    // LAYER G4 — Author name is a business account
    // Names with logistics/shipping keywords = company page, not individual
    //
    // BUYER-FRIENDLY: Only block if the content ALSO has spam signals.
    // A company employee might post a genuine question on behalf of their business.
    // ════════════════════════════════════════════════════════════
    if (PROVIDER_NAME_REGEX.test(authorName)) {
        // If they have no buyer pain signals AND content itself is provider-like → block
        if (painScore === 0 && spamScore >= 2) {
            return {
                blocked: true,
                layer: 'G4',
                reason: `G4: Tên tài khoản "${authorName}" là account công ty/dịch vụ (spamScore=${spamScore})`,
            };
        }
        // Has pain signals → might be a seller shopping for a new provider → valid lead
        if (painScore > 0) {
            console.log(`[ProviderGuard] ⚠️ G4: Business name "${authorName}" but has painScore=${painScore} — passing through for AI decision`);
        }
    }

    // Not blocked
    return null;
}

module.exports = {
    runProviderGuard,
    buildKnownProviderSet,
    buildKnownProviderNameSet,
    // Exposed for testing
    PROVIDER_POST_REGEX,
    STRONG_BUYER_REGEX,
    PROVIDER_NAME_REGEX,
};
