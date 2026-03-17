const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./authMiddleware');
const database = require('../data_store/database');

const router = express.Router();
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '30d'; // 30 days — persistent session

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToken(user) {
    return jwt.sign(
        { id: user.id, name: user.name, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
    );
}

function setTokenCookie(res, token) {
    res.cookie('thg_token', token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
        // secure: true, // enable in production with HTTPS
    });
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/auth/register — ADMIN ONLY (requires valid admin JWT)
router.post('/register', async (req, res) => {
    try {
        // Must have a valid admin token
        const authHeader = req.headers['authorization'];
        let callerRole = null;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const payload = require('jsonwebtoken').verify(authHeader.slice(7), JWT_SECRET);
                callerRole = payload.role;
            } catch { }
        }
        if (callerRole !== 'admin') {
            return res.status(403).json({ ok: false, error: 'Chỉ Admin mới có thể tạo tài khoản. Liên hệ Admin THG.' });
        }

        const { name, email, password, role = 'sales' } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ ok: false, error: 'Cần điền đầy đủ tên, email và mật khẩu.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ ok: false, error: 'Mật khẩu phải ít nhất 6 ký tự.' });
        }

        const existing = database.db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
        if (existing) {
            return res.status(409).json({ ok: false, error: 'Email này đã được đăng ký.' });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = database.db.prepare(
            'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
        ).run(name, email.toLowerCase(), password_hash, role);

        const user = database.db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
        res.json({ ok: true, user });
    } catch (err) {
        console.error('[Auth] Register error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ ok: false, error: 'Cần nhập email và mật khẩu.' });
        }

        const user = database.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Email hoặc mật khẩu không đúng.' });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ ok: false, error: 'Email hoặc mật khẩu không đúng.' });
        }

        const token = makeToken(user);
        setTokenCookie(res, token);

        res.json({ ok: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (err) {
        console.error('[Auth] Login error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/auth/me — verify current session
router.get('/me', (req, res) => {
    // Token verification is done by verifyToken middleware applied in server.js
    // But /api/auth/me is special: we apply it here manually
    const jwt_lib = require('jsonwebtoken');
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token && req.cookies?.thg_token) token = req.cookies.thg_token;

    if (!token) return res.status(401).json({ ok: false, error: 'Chưa đăng nhập.' });

    try {
        const payload = jwt_lib.verify(token, JWT_SECRET);
        const user = database.db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(payload.id);
        if (!user) return res.status(401).json({ ok: false, error: 'Tài khoản không tồn tại.' });
        res.json({ ok: true, user });
    } catch {
        res.status(401).json({ ok: false, error: 'Token không hợp lệ.' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    res.clearCookie('thg_token');
    res.json({ ok: true, message: 'Đã đăng xuất.' });
});

// POST /api/auth/change-password — any logged-in user can change their own password
router.post('/change-password', async (req, res) => {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token && req.cookies?.thg_token) token = req.cookies.thg_token;
    if (!token) return res.status(401).json({ ok: false, error: 'Chưa đăng nhập.' });

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: 'Cần nhập mật khẩu hiện tại và mật khẩu mới.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ ok: false, error: 'Mật khẩu mới phải ít nhất 6 ký tự.' });
        }

        const user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
        if (!user) return res.status(404).json({ ok: false, error: 'Tài khoản không tồn tại.' });

        const match = await bcrypt.compare(currentPassword, user.password_hash);
        if (!match) return res.status(401).json({ ok: false, error: 'Mật khẩu hiện tại không đúng.' });

        const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        database.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);

        res.json({ ok: true, message: 'Đổi mật khẩu thành công!' });
    } catch {
        res.status(401).json({ ok: false, error: 'Token không hợp lệ.' });
    }
});

// ── Admin User Management ─────────────────────────────────────────────────────

function requireAdmin(req, res) {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ ok: false, error: 'Chưa xác thực.' }); return null; }
    try {
        const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
        if (payload.role !== 'admin') { res.status(403).json({ ok: false, error: 'Chỉ Admin mới có quyền này.' }); return null; }
        return payload;
    } catch { res.status(401).json({ ok: false, error: 'Token không hợp lệ.' }); return null; }
}

// GET /api/auth/users — list all users (admin only)
router.get('/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = database.db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ ok: true, users });
});

// DELETE /api/auth/users/:id — remove a user (admin only)
router.delete('/users/:id', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const { id } = req.params;
    if (Number(id) === admin.id) return res.status(400).json({ ok: false, error: 'Không thể xóa chính mình.' });
    database.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
});

// POST /api/auth/users/:id/reset-password — admin resets anyone's password
router.post('/users/:id/reset-password', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'Mật khẩu phải ít nhất 6 ký tự.' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    database.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    res.json({ ok: true });
});

module.exports = router;
