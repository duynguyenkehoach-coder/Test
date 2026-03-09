/**
 * backfill-leaderboard.js
 * One-time script: import all past CLOSED deals → sales_performance + points_log
 * Safe to re-run (skips already-logged entries).
 * Usage: node scripts/backfill-leaderboard.js
 */

// Prevent triggering the full startup pipeline
process.env.SKIP_PIPELINE = '1';

const db = require('../src/data_store/database');

console.log('═══════════════════════════════════════');
console.log('  🏆 Leaderboard Backfill Script');
console.log('═══════════════════════════════════════');

// 1. Lấy tất cả CLOSED deals từ sales_activities
const closedDeals = db.db.prepare(`
    SELECT sa.*, l.deal_value as lead_deal_value, l.category
    FROM sales_activities sa
    LEFT JOIN leads l ON sa.lead_id = l.id
    WHERE sa.action_type = 'CLOSED'
    ORDER BY sa.created_at ASC
`).all();

console.log(`\nFound ${closedDeals.length} CLOSED deal(s) in sales_activities\n`);

let awarded = 0;
let skipped = 0;

for (const deal of closedDeals) {
    const staffName = deal.staff_name;
    const leadId = deal.lead_id || 0;
    // Prefer deal_value from sales_activities, fallback to leads table
    const dealVal = deal.deal_value || deal.lead_deal_value || 0;
    const note = deal.note || `Chốt đơn (backfill) $${dealVal} lead#${leadId}`;

    // Check if already logged to avoid double-counting
    const exists = db.db.prepare(`
        SELECT id FROM points_log
        WHERE sales_name = ? AND lead_id = ? AND action_type = 'CLOSE_DEAL'
    `).get(staffName, leadId);

    if (exists) {
        console.log(`  ⏭  SKIP: ${staffName} lead#${leadId} (already logged)`);
        skipped++;
        continue;
    }

    try {
        db.awardPoints(staffName, 'CLOSE_DEAL', 100, {
            dealValue: dealVal,
            leadId: leadId,
            note: note,
        });
        console.log(`  ✅ +100pts  ${staffName}  $${dealVal}  lead#${leadId}`);
        awarded++;
    } catch (err) {
        console.error(`  ❌ ERROR: ${staffName} lead#${leadId} — ${err.message}`);
    }
}

// 2. Show final leaderboard
console.log('\n═══════════════════════════════════════');
console.log(`  Done: ${awarded} awarded, ${skipped} skipped`);
console.log('═══════════════════════════════════════');
console.log('\n🏆 CURRENT LEADERBOARD:\n');

const { rankings } = db.getLeaderboard();
rankings.forEach((r, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `#${i + 1}`;
    console.log(`  ${medal}  ${r.name.padEnd(12)} ${String(r.total_points).padStart(6)} pts  ${r.deals_closed} deals  $${Math.round(r.total_revenue)}  [${r.rank_level}]`);
});

console.log('\n✅ Backfill complete! Refresh the Leaderboard tab in the browser.\n');
process.exit(0);
