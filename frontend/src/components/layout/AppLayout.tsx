import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import MobileNav from './MobileNav'

export default function AppLayout() {
    return (
        <div className="app-layout">
            <Sidebar />
            <main className="app-main">
                <TopBar />
                <div className="app-content">
                    <Outlet />
                </div>
            </main>
            <MobileNav />
        </div>
    )
}
