/**
 * logger.js — Structured logging with file output
 * 
 * Levels: INFO, WARN, ERROR
 * Output: console + logs/app_YYYY-MM-DD.log
 * Auto-cleanup: logs older than 7 days
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const RETENTION_DAYS = 7;

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFile() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `app_${today}.log`);
}

function timestamp() {
    return new Date().toISOString();
}

function formatMsg(level, module, message, meta) {
    const ts = timestamp();
    const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
    return `[${ts}] [${level}] [${module}]${metaStr} ${message}`;
}

function writeLog(formatted) {
    try {
        fs.appendFileSync(getLogFile(), formatted + '\n', 'utf8');
    } catch { /* ignore write errors */ }
}

const logger = {
    info(module, message, meta) {
        const line = formatMsg('INFO', module, message, meta);
        console.log(line);
        writeLog(line);
    },

    warn(module, message, meta) {
        const line = formatMsg('WARN', module, message, meta);
        console.warn(line);
        writeLog(line);
    },

    error(module, message, meta) {
        const line = formatMsg('ERROR', module, message, meta);
        console.error(line);
        writeLog(line);
    },

    /**
     * Clean log files older than RETENTION_DAYS
     */
    cleanup() {
        try {
            const files = fs.readdirSync(LOG_DIR);
            const today = new Date();
            let deleted = 0;

            for (const file of files) {
                const match = file.match(/^app_(\d{4}-\d{2}-\d{2})\.log$/);
                if (!match) continue;

                const fileDate = new Date(match[1]);
                const diffDays = Math.ceil((today - fileDate) / (1000 * 60 * 60 * 24));

                if (diffDays > RETENTION_DAYS) {
                    fs.unlinkSync(path.join(LOG_DIR, file));
                    deleted++;
                }
            }

            if (deleted > 0) {
                logger.info('Logger', `Cleaned ${deleted} old log files`);
            }
        } catch { /* ignore */ }
    },
};

module.exports = logger;
