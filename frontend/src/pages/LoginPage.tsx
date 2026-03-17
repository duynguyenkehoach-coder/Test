import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { login } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import { getToken } from '../api/client'

export default function LoginPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const navigate = useNavigate()
    const setAuth = useAuthStore((s) => s.setAuth)

    useEffect(() => {
        const token = getToken()
        if (token) {
            fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
                .then((r) => r.json())
                .then((d) => { if (d.ok) navigate('/') })
                .catch(() => { })
        }
    }, [navigate])

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault()
        setError('')
        setLoading(true)
        try {
            const res = await login(password, email)
            if (res.success || res.ok) {
                setAuth(res.user || 'admin')
                navigate('/')
            } else {
                setError(res.error || 'Đăng nhập thất bại')
            }
        } catch {
            setError('Không kết nối được server. Thử lại sau.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="login-page-bg">
            <div className="login-glass-card">
                <div className="login-logo">
                    <span className="login-logo-icon">🏗️</span>
                    <h1 className="login-logo-title">THG Intelligence</h1>
                    <p className="login-logo-sub">AI-Powered Sales Platform</p>
                </div>

                {error && <div className="login-error-box">{error}</div>}

                <form onSubmit={handleSubmit}>
                    <div className="login-field">
                        <label>Email</label>
                        <input type="email" placeholder="your@email.com" value={email}
                            onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
                    </div>
                    <div className="login-field">
                        <label>Mật khẩu</label>
                        <input type="password" placeholder="••••••••" value={password}
                            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                    </div>
                    <div className="login-remember">
                        <label><input type="checkbox" defaultChecked /> Nhớ đăng nhập (30 ngày)</label>
                    </div>
                    <button className="login-submit" type="submit" disabled={loading}>
                        {loading ? '⏳ Đang đăng nhập...' : '🔑 Đăng nhập'}
                    </button>
                </form>

                <div className="login-footer">
                    Chưa có tài khoản? <span>Liên hệ Admin THG để được cấp tài khoản.</span>
                </div>
                <div className="login-badges">
                    <span>🔒 JWT Encrypted</span>
                    <span>✅ 30-day session</span>
                    <span>🛡️ THG Server</span>
                </div>
            </div>
        </div>
    )
}
