/**
 * THG Lead Gen — AI Worker (Standalone Process)
 * 
 * This process runs INDEPENDENTLY from the API server.
 * It processes raw_leads (from CrawBot imports) with AI classification.
 * 
 * Flow:
 *   1. Poll raw_leads table for PENDING rows every 3s
 *   2. Pre-filter with regex (free, instant)
 *   3. AI classify each post (Groq/Gemini) → 2-5s per post
 *   4. Route qualified leads to Sales team
 *   5. Insert into leads table (dashboard)
 * 
 * Usage:
 *   node src/workers/aiWorker.js
 *   PM2: thg-ai-worker (see ecosystem.config.js)
 */
const config = require('../config');
const database = require('../data_store/database');

const POLL_INTERVAL = 3000; // 3 seconds
const BATCH_SIZE = 20;
let isProcessing = false;

// ── Routing rules ──────────────────────────────────────────────────────
const ROUTING_RULES = [
    { pattern: /pod|print.on.demand|in.áo|in.theo|xưởng.in/i, assignTo: 'Trang' },
    { pattern: /trung.quốc|china|tq|taobao|1688|quảng.châu|cn.→|cn\s/i, assignTo: 'Moon' },
    { pattern: /kho.mỹ|warehouse|3pl|texas|pennsylvania|pa.kho|kho.us/i, assignTo: 'Khoa' },
    { pattern: /fulfillment|fulfill|dropship|drop.ship/i, assignTo: 'Trang' },
    { pattern: /epacket|chile|colombia|mexico|saudi|uae|úc|australia/i, assignTo: 'Linh' },
];
const ROUND_ROBIN_SALES = ['Trang', 'Moon', 'Khoa', 'Linh'];
let rrIdx = 0;

function routeLead(content) {
    const text = content || '';
    for (const rule of ROUTING_RULES) {
        if (rule.pattern.test(text)) return rule.assignTo;
    }
    const sales = ROUND_ROBIN_SALES[rrIdx % ROUND_ROBIN_SALES.length];
    rrIdx++;
    return sales;
}

// ── Regex pre-filters (mirrors leadQualifier.js) ─────────────────────
const PROVIDER_RE = /(chúng tôi nhận|bên em nhận|bên em chuyên|bên mình chuyên|bên mình nhận|dịch vụ vận chuyển|nhận gửi hàng|nhận ship|offering fulfillment|we ship|we offer|lh em|ib em|inbox em|liên hệ em|zalo:|chỉ từ \d+k|giải pháp gửi hàng|giải pháp ship|giải pháp vận chuyển|xin phép admin|cam kết giao|cước phí cạnh tranh|liên hệ ngay|tham khảo ngay|đăng ký ngay|nhận từ 1 đơn|dạ em nhận|em chuyên nhận|chúng tôi chuyên|seller nên biết.*:|seller cần biết.*:|ready to scale|just launched|free quote|get started today|contact us.*whatsapp|nhắn em để|nhắn em ngay|inbox ngay|mở rộng sản xuất|sẵn sàng cùng seller|xưởng.*sản xuất|fulfill trực tiếp|fulfill ngay tại|giá xưởng|giá gốc|báo giá|cần thêm thông tin.*nhắn|hỗ trợ.*nhanh nhất|đánh chiếm|siêu lợi nhuận|ưu đãi.*seller|chương trình.*ưu đãi|dm\s+for|dm\s+me|message\s+us|book\s+a\s+call|schedule\s+a\s+call|sign\s+up\s+now|sẵn sàng phục vụ|phục vụ.*seller|cung cấp dịch vụ|chúng tôi cung cấp|we\s+provide|we\s+specialize|our\s+service)/i;
const WRONG_ROUTE_RE = /(giao hàng nhanh nội|ship cod toàn|vận chuyển nội địa|gửi.*về việt nam|order.*về vn|nhập hàng.*về vn|ship.*từ mỹ.*về)/i;
const VAT_RE = /(thuế nhập khẩu|thuế vat|vat refund|ioss|eori|tariff|biểu thuế|customs duty|duty rate|khai báo hải quan|luật nhập khẩu|tax compliance|anti.?dumping)/i;
const KNOWLEDGE_RE = /(chia sẻ kinh nghiệm|chia sẻ kiến thức|bài viết tổng hợp|tutorial|step.by.step|how to.*guide|tip.*seller|tips.*cho|mẹo.*bán hàng)/i;
const MUST_HAVE_RE = /(ship|vận chuyển|fulfillment|fulfill|pod|dropship|gửi hàng|kho|warehouse|giá|tìm|cần|logistics|3pl|fba|ecommerce|seller|tracking|forwarder|express|freight|order|tìm đơn vị)/i;

function preFilter(content) {
    if (PROVIDER_RE.test(content)) return { pass: false, reason: 'Provider/quảng cáo' };
    if (WRONG_ROUTE_RE.test(content)) return { pass: false, reason: 'Sai tuyến (nội địa/nhập về VN)' };
    if (VAT_RE.test(content)) return { pass: false, reason: 'VAT/Tax/Compliance (không phải lead)' };
    if (KNOWLEDGE_RE.test(content)) return { pass: false, reason: 'Bài chia sẻ kiến thức (không phải lead)' };
    if (!MUST_HAVE_RE.test(content)) return { pass: false, reason: 'Không có từ khóa kinh doanh' };
    return { pass: true };
}

/**
 * Process a batch of PENDING raw_leads
 */
async function processBatch() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const batch = database.db.prepare(
            `SELECT * FROM raw_leads WHERE status = 'PENDING' LIMIT ?`
        ).all(BATCH_SIZE);

        if (batch.length === 0) return;

        console.log(`[AIWorker] 📋 Processing batch: ${batch.length} pending raw_leads...`);

        // Lazy-load classifyPost (avoids loading AI SDK until needed)
        const { classifyPost } = require('../prompts/leadQualifier');

        for (const row of batch) {
            // Mark as PROCESSING
            database.db.prepare(`UPDATE raw_leads SET status='PROCESSING' WHERE id=?`).run(row.id);

            // Pre-filter (free, instant)
            const pf = preFilter(row.content);
            if (!pf.pass) {
                database.db.prepare(
                    `UPDATE raw_leads SET status='REJECTED', reject_reason=? WHERE id=?`
                ).run(pf.reason, row.id);
                continue;
            }

            // AI Classify
            try {
                const post = {
                    platform: row.platform,
                    author_name: row.author,
                    author_url: row.author_url,
                    content: row.content,
                    post_url: row.url,
                    post_created_at: row.scraped_at,
                    item_type: 'post',
                    group_name: row.group_name,
                };
                const result = await classifyPost(post);
                const score = result?.score || 0;
                const threshold = config.LEAD_SCORE_THRESHOLD || 60;

                if (score >= threshold) {
                    const assignedTo = routeLead(row.content);

                    // Save to leads table (INSERT OR IGNORE dedup by post_url)
                    database.db.prepare(`
                        INSERT OR IGNORE INTO leads
                          (platform, author_name, author_url, content, post_url, post_created_at,
                           item_type, group_name, score, summary, status, tags, response_draft, assigned_sales)
                        VALUES (?, ?, ?, ?, ?, ?, 'post', ?, ?, ?, 'new', ?, ?, ?)
                    `).run(
                        row.platform, row.author, row.author_url, row.content,
                        row.url, row.scraped_at, row.group_name,
                        score, result?.summary || '',
                        JSON.stringify(result?.tags || []),
                        result?.response_draft || '',
                        assignedTo,
                    );

                    database.db.prepare(
                        `UPDATE raw_leads SET status='QUALIFIED', score=?, assigned_to=? WHERE id=?`
                    ).run(score, assignedTo, row.id);

                    // Invalidate stats cache
                    database.invalidateStatsCache();

                    console.log(`[AIWorker] 🔥 LEAD ${score}đ → ${assignedTo}: ${row.author}`);
                } else {
                    database.db.prepare(
                        `UPDATE raw_leads SET status='REJECTED', score=?, reject_reason=? WHERE id=?`
                    ).run(score, `AI score ${score} < ${threshold}`, row.id);
                }
            } catch (aiErr) {
                // Put back to PENDING for retry
                database.db.prepare(
                    `UPDATE raw_leads SET status='PENDING', reject_reason=? WHERE id=?`
                ).run('AI error: ' + aiErr.message, row.id);
                console.warn(`[AIWorker] ⚠️ AI error for row ${row.id}: ${aiErr.message}`);
            }
        }

        console.log(`[AIWorker] ✅ Batch done.`);
    } catch (err) {
        console.error(`[AIWorker] ❌ Batch error:`, err.message);
    } finally {
        isProcessing = false;
    }
}

// ═══ Main ═══
function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  🧠 THG AI Worker — Standalone Process              ║');
    console.log('║  Polls raw_leads → Pre-filter → AI Classify → Save ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`[AIWorker] 🔄 Polling raw_leads every ${POLL_INTERVAL / 1000}s (batch=${BATCH_SIZE})...`);

    // Start polling
    setInterval(processBatch, POLL_INTERVAL);

    // Initial poll
    processBatch();
}

main();
