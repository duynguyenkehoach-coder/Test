/**
 * 🎖️ Squad Runner — Entry Point for the Multi-Agent Squad
 * 
 * SINGLE PROCESS, SEQUENTIAL FLOW.
 * Runs the 5-phase cycle: Warm-up → Broadcast → Scrape → Snipe → Cool-down
 * 
 * Usage:
 *   node src/squad/squadRunner.js          # Run one cycle
 *   node src/squad/squadRunner.js --cron   # Run on 4-hour schedule
 * 
 * @module squad/squadRunner
 */
require('dotenv').config();

const { runCycle } = require('./dispatcher');

const CYCLE_HOURS = parseInt(process.env.SQUAD_CYCLE_HOURS || '4', 10);
const CYCLE_MS = CYCLE_HOURS * 60 * 60 * 1000;

// Track running state
let isRunning = false;
let cycleCount = 0;

async function executeCycle() {
    if (isRunning) {
        console.log('[SquadRunner] ⚠️ Previous cycle still running → skip');
        return;
    }

    isRunning = true;
    cycleCount++;

    console.log(`\n${'▓'.repeat(55)}`);
    console.log(`  🎖️ SQUAD RUNNER — Cycle #${cycleCount}`);
    console.log(`  🕐 ${new Date().toLocaleString('vi-VN')}`);
    console.log(`${'▓'.repeat(55)}\n`);

    try {
        await runCycle();
    } catch (e) {
        console.error(`[SquadRunner] ❌ Cycle #${cycleCount} crashed: ${e.message}`);
        console.error(e.stack);
    } finally {
        isRunning = false;
    }

    console.log(`[SquadRunner] ⏰ Next cycle in ${CYCLE_HOURS}h`);
}

// ═══ Main ═══
async function main() {
    const args = process.argv.slice(2);
    const cronMode = args.includes('--cron');

    console.log('█'.repeat(55));
    console.log('  🎖️ THG SQUAD RUNNER');
    console.log(`  Mode: ${cronMode ? `CRON (every ${CYCLE_HOURS}h)` : 'SINGLE CYCLE'}`);
    console.log('█'.repeat(55));

    // Run first cycle immediately
    await executeCycle();

    if (cronMode) {
        // Schedule recurring cycles
        console.log(`[SquadRunner] 📅 Scheduling cycles every ${CYCLE_HOURS} hours`);

        setInterval(async () => {
            await executeCycle();
        }, CYCLE_MS);

        // Keep process alive
        process.on('SIGINT', () => {
            console.log('\n[SquadRunner] 🛑 Shutting down gracefully...');
            process.exit(0);
        });
    }
}

main().catch(e => {
    console.error('[SquadRunner] 💥 Fatal:', e.message);
    process.exit(1);
});
