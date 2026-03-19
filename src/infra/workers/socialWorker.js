/**
 * THG Lead Gen — Social Worker (Standalone Process)
 * 
 * This process runs the Social Agent in the background 24/7.
 * It is managed by PM2 just like scraperWorker and aiWorker.
 * 
 * Usage:
 *   node src/infra/workers/socialWorker.js
 *   PM2: thg-social-worker (see ecosystem.config.js)
 */
'use strict';

const socialAgent = require('../../ai/agents/social/socialAgent');

console.log('=============================================');
console.log('🤖 Starting THG Social Agent Worker 24/7 🚀');
console.log('=============================================');

// Keep process alive
process.on('SIGINT', async () => {
    console.log('\n[SocialWorker] Gracefully shutting down...');
    await socialAgent.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n[SocialWorker] Gracefully shutting down...');
    await socialAgent.stop();
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    const msg = String(reason?.message || reason || '');
    if (msg.includes('Target page, context or browser has been closed') ||
        msg.includes('cdpSession.send') ||
        msg.includes('page.addInitScript')) {
        return; // Suppress Playwright stealth noise
    }
    console.error('[SocialWorker] ❌ Unhandled rejection:', reason);
});

// Start the continuous loop
socialAgent.start();
