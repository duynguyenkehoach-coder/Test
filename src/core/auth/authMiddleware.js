const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'thg-secret-change-in-production';

/**
 * Express middleware — verifies JWT from Authorization header or thg_token cookie.
 * Skips /api/auth/* routes automatically (handled in server.js routing order).
 */
function verifyToken(req, res, next) {
    // 1. Try Authorization: Bearer <token>
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
    }
    // 2. Fallback: httpOnly cookie
    if (!token && req.cookies && req.cookies.thg_token) {
        token = req.cookies.thg_token;
    }

    if (!token) {
        return res.status(401).json({ ok: false, error: 'Chưa đăng nhập. Vui lòng login.' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload; // { id, name, email, role }
        next();
    } catch (err) {
        return res.status(401).json({ ok: false, error: 'Token hết hạn hoặc không hợp lệ. Vui lòng login lại.' });
    }
}

module.exports = { verifyToken, JWT_SECRET };
