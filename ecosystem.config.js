/**
 * PM2 Ecosystem Config — Production Deployment
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 stop thg-lead-gen
 *   pm2 restart thg-lead-gen
 *   pm2 logs thg-lead-gen
 *   pm2 monit
 */

module.exports = {
    apps: [{
        name: 'thg-lead-gen',
        script: 'src/index.js',
        cwd: __dirname,

        // Environment
        env: {
            NODE_ENV: 'production',
        },

        // Auto-restart
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 5000,

        // Watch (disable in prod for performance)
        watch: false,

        // Logging
        log_file: 'logs/pm2_combined.log',
        out_file: 'logs/pm2_out.log',
        error_file: 'logs/pm2_error.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true,
        max_size: '10M',

        // Memory limit — restart if exceeds
        max_memory_restart: '500M',

        // Graceful shutdown
        kill_timeout: 5000,
        listen_timeout: 10000,

        // Cron restart daily at 3am to clear memory
        cron_restart: '0 3 * * *',
    }],
};
