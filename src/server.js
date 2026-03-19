/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  THG Lead Gen — Express Server (Orchestrator)             ║
 * ║  All routes extracted to src/routes/*.routes.js           ║
 * ╚═══════════════════════════════════════════════════════════╝
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./config');
const database = require('./core/data_store/database');
const logger = require('./logger');
const { verifyToken } = require('./core/auth/authMiddleware');
const authRoutes = require('./core/auth/authRoutes');

// ── Route modules ────────────────────────────────────────────────────────────
const leadsRoutes = require('./routes/leads.routes');
const statsRoutes = require('./routes/stats.routes');
const conversationsRoutes = require('./routes/conversations.routes');
const groupsRoutes = require('./routes/groups.routes');
const agentsRoutes = require('./routes/agents.routes');
const accountsRoutes = require('./routes/accounts.routes');
const scanRoutes = require('./routes/scan.routes');
const leaderboardRoutes = require('./routes/leaderboard.routes');
const workerRoutes = require('./routes/worker.routes');
const socialRoutes = require('./routes/social.routes');
const outreachRoutes = require('./routes/outreach.routes');
const strategyRoutes = require('./routes/strategy.routes');
const activityRoutes = require('./routes/activity.routes');
const dataRoutes = require('./routes/data.routes');
const devRoutes = require('./routes/dev.routes');
const webhookRoutes = require('./routes/webhook.routes');

// ╔═══════════════════════════════════════════════════════════╗
// ║  IN-MEMORY LOG CAPTURE (for Dev Dashboard)                ║
// ╚═══════════════════════════════════════════════════════════╝
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function captureLog(level, args) {
    const line = {
        time: new Date().toISOString(),
        level,
        msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
    };
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

console.log = (...args) => { captureLog('info', args); origLog.apply(console, args); };
console.error = (...args) => { captureLog('error', args); origError.apply(console, args); };
console.warn = (...args) => { captureLog('warn', args); origWarn.apply(console, args); };

// Share logBuffer with dev routes
devRoutes.setLogBuffer(logBuffer);

// ╔═══════════════════════════════════════════════════════════╗
// ║  EXPRESS APP                                              ║
// ╚═══════════════════════════════════════════════════════════╝
const app = express();
let server = null;

app.set('trust proxy', 1);

// ── Global Middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// ── Static files — React frontend (production) ──────────────────────────────
const reactDistPath = path.join(__dirname, '..', 'frontend', 'dist');
console.log(`[Server] 📂 React dist path: ${reactDistPath} (exists: ${fs.existsSync(reactDistPath)})`);
app.use(express.static(reactDistPath));
// Fallback: legacy public/ (only dev.html remains)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Public routes (no JWT) ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ── Rate Limiting ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { success: false, error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// ── JWT Auth Guard (protects /api/* except auth, dev, worker collect) ────────
app.use('/api/', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    if (req.path.startsWith('/dev/')) return next();
    if (req.path === '/leads/collect' && req.method === 'POST') return next();
    if (req.path.startsWith('/worker/') && req.headers['x-thg-auth-key']) return next();
    if (req.path.startsWith('/import/') && req.headers['x-thg-auth-key']) return next();
    return verifyToken(req, res, next);
});

// ── Request Timeout Middleware ───────────────────────────────────────────────
const LONG_ROUTES = ['/api/agents/generate-reply', '/api/scan', '/api/leads/classify'];
app.use((req, res, next) => {
    const isLong = LONG_ROUTES.some(r => req.path.startsWith(r));
    const timeoutMs = isLong ? 120_000 : 30_000;

    const timer = setTimeout(() => {
        if (!res.headersSent) {
            logger.warn('Server', `⏱ Request timeout: ${req.method} ${req.path} (${timeoutMs / 1000}s)`);
            res.status(503).json({
                success: false,
                error: 'Request timed out — server is busy. Please retry.',
                retryAfter: 5,
            });
        }
    }, timeoutMs);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  MOUNT ALL ROUTE MODULES                                  ║
// ╚═══════════════════════════════════════════════════════════╝
app.use(statsRoutes);
app.use(leadsRoutes);
app.use(conversationsRoutes);
app.use(groupsRoutes);
app.use(agentsRoutes);
app.use(accountsRoutes);
app.use(scanRoutes);
app.use(leaderboardRoutes);
app.use(workerRoutes);
app.use(dataRoutes);
app.use(devRoutes);
app.use(webhookRoutes);
app.use('/api/social', socialRoutes);
app.use(outreachRoutes);
app.use('/api/strategy', strategyRoutes);
app.use('/api/activity', activityRoutes);

// ── Initialize Group Discovery DB ───────────────────────────────────────────
try {
    const groupDiscovery = require('./ai/agents/groupDiscovery');
    groupDiscovery.getDb();
    logger.info('GroupDB', 'Group database initialized');
} catch (e) {
    logger.warn('GroupDB', e.message);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  REACT SPA CATCH-ALL — serve index.html for all non-API   ║
// ║  routes so React Router handles client-side navigation     ║
// ╚═══════════════════════════════════════════════════════════╝
const reactIndexPath = path.join(reactDistPath, 'index.html');
console.log(`[Server] 📄 React index.html: ${reactIndexPath} (exists: ${fs.existsSync(reactIndexPath)})`);
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(reactIndexPath, (err) => {
        if (err) res.status(500).send('Frontend not built. Run: cd frontend && npm run build');
    });
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  START SERVER + GRACEFUL SHUTDOWN                         ║
// ╚═══════════════════════════════════════════════════════════╝
function startServer() {
    const port = config.PORT;
    const http = require('http');
    const httpServer = http.createServer(app);
    let retryCount = 0;
    const MAX_RETRIES = 10;

    function doListen() {
        httpServer.listen({ port, host: '::', ipv6Only: false }, () => {
            server = httpServer;
            logger.info('Server', `Dashboard: http://localhost:${port}`);
            logger.info('Server', `Webhook:   http://localhost:${port}/webhook`);
            logger.info('Server', `Health:    http://localhost:${port}/health`);
        });
    }

    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            retryCount++;
            if (retryCount > MAX_RETRIES) {
                logger.error('Server', `Port ${port} still busy after ${MAX_RETRIES} retries.`);
                process.exit(1);
            }
            logger.warn('Server', `Port ${port} busy (${retryCount}/${MAX_RETRIES}) — retrying in 3s...`);
            setTimeout(() => { httpServer.close(); doListen(); }, 3000);
        } else {
            throw err;
        }
    });

    doListen();
    server = httpServer;
    return app;
}

function shutdown(signal) {
    logger.warn('Server', `${signal} received. Shutting down gracefully...`);
    if (server) {
        server.close(() => {
            logger.info('Server', 'HTTP server closed');
            try { database.db.close(); } catch { /* ignore */ }
            logger.info('Server', 'Database closed. Goodbye!');
            process.exit(0);
        });
        setTimeout(() => {
            logger.error('Server', 'Forced shutdown after timeout');
            process.exit(1);
        }, 5000);
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
