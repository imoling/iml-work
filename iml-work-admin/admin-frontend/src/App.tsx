import { useState } from 'react'
import { Award, ShieldCheck, Database, Server, LayoutDashboard, Workflow, Plug, Boxes, Building2, Globe, Fingerprint } from 'lucide-react'
import logoMark from './assets/brand/logo-mark.svg'
import Dashboard from './components/Dashboard'
import ExpertManager from './components/ExpertManager'
import SkillsHub from './components/SkillsHub'
import SandboxManager from './components/SandboxManager'
import KnowledgeManager from './components/KnowledgeManager'
import SystemManager from './components/SystemManager'
import ModelGatewayManager from './components/ModelGatewayManager'
import EnterpriseManager from './components/EnterpriseManager'
import SearchConfigManager from './components/SearchConfigManager'
import AgentTraceManager from './components/AgentTraceManager'

type Tab = 'dashboard' | 'experts' | 'skills' | 'sandbox' | 'knowledge' | 'integrations' | 'gateway' | 'enterprise' | 'search' | 'trace'

const TITLES: Record<Tab, string> = {
  dashboard: '运行总览',
  experts: '岗位专家与自动化技能',
  skills: '企业技能中心',
  sandbox: '客户端沙箱容器与同步审计监控',
  knowledge: '企业云端知识库控制中心',
  integrations: '外部业务系统连接',
  gateway: '企业模型中转站',
  enterprise: '企业信息维护',
  search: '联网检索服务',
  trace: '审计追溯 · Agent Trace'
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
          <img src={logoMark} alt="iML" className="sidebar-logo-mark" />
          <div>
            <h1>iML <span className="accent">管理台</span></h1>
            <p>企业岗位分身管理控制台</p>
          </div>
        </div>

        <div className="sidebar-nav">
          {navItem('dashboard', <LayoutDashboard size={16} />, '运行总览')}
          {navItem('experts', <Award size={16} />, '岗位专家')}
          {navItem('skills', <Workflow size={16} />, '技能中心')}
          {navItem('gateway', <Boxes size={16} />, '模型网关')}
          {navItem('search', <Globe size={16} />, '联网检索')}
          {navItem('trace', <Fingerprint size={16} />, '审计追溯')}
          {navItem('sandbox', <ShieldCheck size={16} />, '沙箱监控')}
          {navItem('knowledge', <Database size={16} />, '知识中心')}
          {navItem('integrations', <Plug size={16} />, '业务系统')}
          {navItem('enterprise', <Building2 size={16} />, '企业信息')}
        </div>

        <div className="sidebar-footer">
          <p>iML 核心引擎 v1.0</p>
          <p style={{ fontSize: '9px', marginTop: '4px' }}>服务地址 localhost:8080</p>
        </div>
      </div>

      {/* Main Panel View */}
      <div className="dashboard-content">
        <div className="top-navbar">
          <div className="top-navbar-title">{TITLES[activeTab]}</div>

          <div className="top-navbar-actions">
            <div className="system-status-indicator">
              <span className="status-dot" />
              <span>内网通信就绪</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <Server size={14} />
              <span>管理中心</span>
            </div>
          </div>
        </div>

        <div className="panel-view">
          {activeTab === 'dashboard' && <Dashboard onNavigate={(t) => setActiveTab(t as Tab)} />}
          {activeTab === 'experts' && <ExpertManager />}
          {activeTab === 'skills' && <SkillsHub />}
          {activeTab === 'gateway' && <ModelGatewayManager />}
          {activeTab === 'search' && <SearchConfigManager />}
          {activeTab === 'trace' && <AgentTraceManager />}
          {activeTab === 'sandbox' && <SandboxManager />}
          {activeTab === 'knowledge' && <KnowledgeManager />}
          {activeTab === 'integrations' && <SystemManager />}
          {activeTab === 'enterprise' && <EnterpriseManager />}
        </div>
      </div>
    </div>
  )
}
