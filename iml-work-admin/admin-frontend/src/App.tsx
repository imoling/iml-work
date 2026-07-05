import { useState, useEffect } from 'react'
import { Award, ShieldCheck, Database, LayoutDashboard, Workflow, Plug, Boxes, Building2, Globe, Fingerprint, UsersRound, LogOut, Network } from 'lucide-react'
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
import UserManager from './components/UserManager'
import OntologyManager from './components/OntologyManager'
import LoginPage from './components/LoginPage'
import ChangePasswordGate from './components/ChangePasswordGate'
import { useAuth } from './auth'
import { Permissions as P } from './permissions'

type Tab = 'dashboard' | 'experts' | 'skills' | 'sandbox' | 'knowledge' | 'integrations' | 'gateway' | 'enterprise' | 'search' | 'trace' | 'users' | 'ontology'

const TITLES: Record<Tab, string> = {
  dashboard: '运行总览',
  experts: '岗位专家与自动化技能',
  skills: '企业技能中心',
  sandbox: '企业安全沙箱 · 配置与运行监控',
  knowledge: '企业云端知识库控制中心',
  integrations: '外部业务系统连接',
  gateway: '企业模型中转站',
  enterprise: '企业信息维护',
  search: '联网检索服务',
  trace: '审计追溯 · Agent Trace',
  users: '用户与权限管理',
  ontology: '本体建模 · Ontology'
}

// 导航项 → 所需权限点。按管理逻辑分组、组内按依赖/使用顺序排列：
//  总览 → 分身能力（配分身能提供什么）→ 系统接入与基础设施（分身跑起来靠什么）→ 治理审计 → 平台设置
const NAV: { tab: Tab; icon: React.ReactNode; label: string; perm: string; group: string }[] = [
  { tab: 'dashboard', icon: <LayoutDashboard size={16} />, label: '运行总览', perm: P.DASHBOARD_VIEW, group: '总览' },

  { tab: 'experts', icon: <Award size={16} />, label: '岗位专家', perm: P.EXPERT_MANAGE, group: '分身能力' },
  { tab: 'skills', icon: <Workflow size={16} />, label: '技能中心', perm: P.SKILL_MANAGE, group: '分身能力' },
  { tab: 'knowledge', icon: <Database size={16} />, label: '知识中心', perm: P.KNOWLEDGE_MANAGE, group: '分身能力' },

  { tab: 'integrations', icon: <Plug size={16} />, label: '业务系统', perm: P.INTEGRATION_MANAGE, group: '系统与基础设施' },
  { tab: 'ontology', icon: <Network size={16} />, label: '本体建模', perm: P.ONTOLOGY_MANAGE, group: '系统与基础设施' },
  { tab: 'gateway', icon: <Boxes size={16} />, label: '模型网关', perm: P.GATEWAY_MANAGE, group: '系统与基础设施' },
  { tab: 'search', icon: <Globe size={16} />, label: '联网检索', perm: P.SEARCH_MANAGE, group: '系统与基础设施' },
  { tab: 'sandbox', icon: <ShieldCheck size={16} />, label: '安全沙箱', perm: P.SANDBOX_MANAGE, group: '系统与基础设施' },

  { tab: 'trace', icon: <Fingerprint size={16} />, label: '审计追溯', perm: P.TRACE_VIEW, group: '治理与审计' },

  { tab: 'enterprise', icon: <Building2 size={16} />, label: '企业信息', perm: P.ENTERPRISE_MANAGE, group: '平台设置' },
  { tab: 'users', icon: <UsersRound size={16} />, label: '用户权限', perm: P.USER_MANAGE, group: '平台设置' }
]

export default function App() {
  const { user, ready, has, logout } = useAuth()
  const visible = NAV.filter(n => has(n.perm))
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')

  // 登录后把默认页切到第一个有权限的页面
  useEffect(() => {
    if (user && visible.length && !visible.find(n => n.tab === activeTab)) {
      setActiveTab(visible[0].tab)
    }
  }, [user])

  if (!ready) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>加载中…</div>
  }
  if (!user) return <LoginPage />
  if (user.mustChangePassword) return <ChangePasswordGate />

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
          {visible.map((n, i) => (
            <div key={n.tab}>
              {/* 组标题：仅在有权限项时按分组首次出现处插入（「总览」组不加标题，直接置顶） */}
              {n.group !== '总览' && visible[i - 1]?.group !== n.group && (
                <div className="nav-group">{n.group}</div>
              )}
              <button className={`nav-item ${activeTab === n.tab ? 'active' : ''}`} onClick={() => setActiveTab(n.tab)}>
                {n.icon}<span>{n.label}</span>
              </button>
            </div>
          ))}
          {visible.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12 }}>当前账号无任何管理端权限，请联系管理员。</div>}
        </div>

        <div className="sidebar-footer">
          <p>iML 核心引擎 v1.0</p>
          <p style={{ fontSize: '9px', marginTop: '4px' }}>服务地址 {(import.meta.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080').replace(/^https?:\/\//, '')}</p>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <span>{user.displayName || user.username}</span>
              <button className="btn-secondary" onClick={logout} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px' }} title="退出登录">
                <LogOut size={13} />退出
              </button>
            </div>
          </div>
        </div>

        <div className="panel-view">
          {activeTab === 'dashboard' && has(P.DASHBOARD_VIEW) && <Dashboard onNavigate={(t) => setActiveTab(t as Tab)} />}
          {activeTab === 'experts' && has(P.EXPERT_MANAGE) && <ExpertManager />}
          {activeTab === 'skills' && has(P.SKILL_MANAGE) && <SkillsHub />}
          {activeTab === 'gateway' && has(P.GATEWAY_MANAGE) && <ModelGatewayManager />}
          {activeTab === 'search' && has(P.SEARCH_MANAGE) && <SearchConfigManager />}
          {activeTab === 'trace' && has(P.TRACE_VIEW) && <AgentTraceManager />}
          {activeTab === 'sandbox' && has(P.SANDBOX_MANAGE) && <SandboxManager />}
          {activeTab === 'knowledge' && has(P.KNOWLEDGE_MANAGE) && <KnowledgeManager />}
          {activeTab === 'integrations' && has(P.INTEGRATION_MANAGE) && <SystemManager />}
          {activeTab === 'ontology' && has(P.ONTOLOGY_MANAGE) && <OntologyManager />}
          {activeTab === 'enterprise' && has(P.ENTERPRISE_MANAGE) && <EnterpriseManager />}
          {activeTab === 'users' && has(P.USER_MANAGE) && <UserManager />}
        </div>
      </div>
    </div>
  )
}
