import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Connections from './pages/Connections'
import QuickSkill from './pages/QuickSkill'
import SkillCreate from './pages/SkillCreate'
import TestSkill from './pages/TestSkill'
import OntologyPage from './pages/Ontology'
import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import { useAuth } from './services/auth'

export default function App() {
  const { user, ready, has, logout } = useAuth()

  if (!ready) {
    return <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a97a3', fontSize: 14 }}>加载中…</div>
  }
  if (!user) return <Login />
  if (user.mustChangePassword) return <ChangePassword />
  if (!has('fde.access')) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, background: '#F7F9FB', textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a2530' }}>无 FDE 工作台访问权限</div>
        <div style={{ fontSize: 13, color: '#6b7885', maxWidth: 420, lineHeight: 1.6 }}>
          当前账号「{user.displayName || user.username}」未被授予「FDE工作台-进入」权限。请联系管理员分配「FDE工程师」等含该权限的角色。
        </div>
        <button onClick={logout} style={{ padding: '8px 18px', border: '1px solid #dde3e8', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>退出登录</button>
      </div>
    )
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/quick" element={<QuickSkill />} />
        <Route path="/create" element={<SkillCreate />} />
        <Route path="/test" element={<TestSkill />} />
        <Route path="/ontology" element={<OntologyPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
