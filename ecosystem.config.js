/**
 * PM2 Ecosystem Config — Production Deployment (3-Tier Architecture)
 *
 * Usage:
 *   pm2 start ecosystem.config.js     — start all 3 processes
 *   pm2 reload ecosystem.config.js    — rolling reload
 *   pm2 stop all
 *   pm2 logs --lines 50
 *   pm2 monit
 *
 * Architecture:
 *   thg-api        → Lightweight Express API (dashboard + webhooks)
 *   thg-scraper    → Playwright scraper (polls scan_queue, heavy CPU/RAM)
 *   thg-ai-worker  → AI classifier (polls raw_leads, I/O-bound)
 */

module.exports = {
    apps: [
        // ── API Server (Lightweight) ─────────────────────────────────────
        {
            name: 'thg-api',
            script: 'src/index.js',
            cwd: __dirname,

            exec_mode: 'fork',
            instances: 1,

            env: {
                NODE_ENV: 'production',
                ENABLED_PLATFORMS: 'facebook',
                MAX_POSTS_PER_SCAN: '200',
            },

            // Stability
            autorestart: true,
            max_restarts: 20,
            min_uptime: '15s',
            restart_delay: 3000,
            exp_backoff_restart_delay: 100,

            // Memory — lightweight process, should stay under 200MB
            max_memory_restart: '300M',

            // Timeouts
            kill_timeout: 8000,
            listen_timeout: 15000,
            shutdown_with_message: true,

            watch: false,

            // Logging
            log_file: 'logs/api_combined.log',
            out_file: 'logs/api_out.log',
            error_file: 'logs/api_error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
            max_size: '20M',
        },

        // ── Scraper Worker (Playwright — Heavy) ──────────────────────────
        {
            name: 'thg-scraper',
            script: 'src/infra/workers/scraperWorker.js',
            cwd: __dirname,

            exec_mode: 'fork',
            instances: 1,

            env: {
                NODE_ENV: 'production',
            },

            // Stability
            autorestart: true,
            max_restarts: 15,
            min_uptime: '10s',
            restart_delay: 5000,
            exp_backoff_restart_delay: 200,

            // Memory — Playwright can use 400-600MB during scans
            max_memory_restart: '800M',

            kill_timeout: 15000,  // Give Playwright time to close browsers
            shutdown_with_message: true,

            watch: false,

            // Logging
            log_file: 'logs/scraper_combined.log',
            out_file: 'logs/scraper_out.log',
            error_file: 'logs/scraper_error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
            max_size: '30M',

            // Scheduled restart: clear Playwright memory leaks
            cron_restart: '0 3 * * *',  // 3 AM daily
        },

        // ── AI Worker (Classification — I/O-bound) ───────────────────────
        {
            name: 'thg-ai-worker',
            script: 'src/infra/workers/aiWorker.js',
            cwd: __dirname,

            exec_mode: 'fork',
            instances: 1,

            env: {
                NODE_ENV: 'production',
            },

            // Stability
            autorestart: true,
            max_restarts: 20,
            min_uptime: '10s',
            restart_delay: 3000,

            // Memory — AI SDKs + responses, should stay light
            max_memory_restart: '300M',

            kill_timeout: 8000,
            shutdown_with_message: true,

            watch: false,

            // Logging
            log_file: 'logs/ai_worker_combined.log',
            out_file: 'logs/ai_worker_out.log',
            error_file: 'logs/ai_worker_error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
            max_size: '20M',
        },

        // ── Social Worker 24/7 (Browser Automation) ─────────────────────────
        {
            name: 'thg-social-worker',
            script: 'src/infra/workers/socialWorker.js',
            cwd: __dirname,

            exec_mode: 'fork',
            instances: 1,

            env: {
                NODE_ENV: 'production',
            },

            // Stability
            autorestart: true,
            max_restarts: 15,
            min_uptime: '10s',
            restart_delay: 10000, // 10 seconds between restarts

            // Memory constraints — uses Chromium
            max_memory_restart: '600M',

            kill_timeout: 10000,
            shutdown_with_message: true,

            watch: false,

            // Logging
            log_file: 'logs/social_worker_combined.log',
            out_file: 'logs/social_worker_out.log',
            error_file: 'logs/social_worker_error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
            max_size: '30M',
        },
    ],
};
