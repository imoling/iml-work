import { useState } from 'react'
import { Award, ShieldCheck, Database, Server, LayoutDashboard, Workflow, Plug } from 'lucide-react'
import Dashboard from './components/Dashboard'
import ExpertManager from './components/ExpertManager'
import SkillsHub from './components/SkillsHub'
import SandboxManager from './components/SandboxManager'
import KnowledgeManager from './components/KnowledgeManager'
import SystemManager from './components/SystemManager'

type Tab = 'dashboard' | 'experts' | 'skills' | 'sandbox' | 'knowledge' | 'integrations'

const TITLES: Record<Tab, string> = {
  dashboard: '运营监控仪表盘 (Operations Dashboard)',
  experts: '岗位专家与自动化技能包定义',
  skills: '企业级技能中心 (SkillsHub)',
  sandbox: '客户端沙箱容器与同步审计监控',
  knowledge: '企业云端分布式知识库控制中心',
  integrations: '外部业务系统集成配置 (OA / CRM / GitHub)'
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')

  const navItem = (tab: Tab, icon: React.ReactNode, label: string) => (
    <button
      className={`nav-item ${activeTab === tab ? 'active' : ''}`}
      onClick={() => setActiveTab(tab)}
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  return (
    <div className="dashboard-container">
      {/* Sidebar */}
      <div className="admin-sidebar">
        <div className="sidebar-header">
          <h1>iML Work Admin</h1>
          <p>Enterprise Admin Console</p>
        </div>

        <div className="sidebar-nav">
          {navItem('dashboard', <LayoutDashboard size={16} />, '运营监控仪表盘')}
          {navItem('experts', <Award size={16} />, '岗位专家管理')}
          {navItem('skills', <Workflow size={16} />, '技能中心 SkillsHub')}
          {navItem('sandbox', <ShieldCheck size={16} />, '沙箱监控审计')}
          {navItem('knowledge', <Database size={16} />, '企业云知识库')}
          {navItem('integrations', <Plug size={16} />, '系统集成配置')}
        </div>

        <div className="sidebar-footer">
          <p>iML Core Engine v1.0</p>
          <p style={{ fontSize: '9px', marginTop: '4px' }}>Server: localhost:8080</p>
        </div>
      </div>

      {/* Main Panel View */}
      <div className="dashboard-content">
        <div className="top-navbar">
          <div className="top-navbar-title">{TITLES[activeTab]}</div>

          <div className="top-navbar-actions">
            <div className="system-status-indicator">
              <span className="status-dot" />
              <span>内网通信就绪 (Engine Online)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <Server size={14} />
              <span>Admin Center</span>
            </div>
          </div>
        </div>

        <div className="panel-view">
          {activeTab === 'dashboard' && <Dashboard />}
          {activeTab === 'experts' && <ExpertManager />}
          {activeTab === 'skills' && <SkillsHub />}
          {activeTab === 'sandbox' && <SandboxManager />}
          {activeTab === 'knowledge' && <KnowledgeManager />}
          {activeTab === 'integrations' && <SystemManager />}
        </div>
      </div>
    </div>
  )
}
