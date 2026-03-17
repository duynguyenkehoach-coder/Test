import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import LoginPage from './pages/LoginPage'
import LeadsPage from './pages/LeadsPage'
import AnalyticsPage from './pages/AnalyticsPage'
import InboxPage from './pages/InboxPage'
import GroupsPage from './pages/GroupsPage'
import AgentsPage from './pages/AgentsPage'
import LeaderboardPage from './pages/LeaderboardPage'
import SystemPage from './pages/SystemPage'
import PlaceholderPage from './pages/PlaceholderPage'
import { useAuthStore } from './store/authStore'
import { useEffect } from 'react'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

function App() {
  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'dark'
    document.documentElement.setAttribute('data-theme', saved)
  }, [])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<LeadsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/settings" element={<PlaceholderPage title="Settings" icon="⚙️" />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
