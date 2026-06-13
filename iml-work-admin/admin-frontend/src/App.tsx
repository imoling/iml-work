import { useState } from 'react'
import { Award, ShieldCheck, Database, Server } from 'lucide-react'
import ExpertManager from './components/ExpertManager'
import SandboxManager from './components/SandboxManager'
import KnowledgeManager from './components/KnowledgeManager'

export default function App() {
  const [activeTab, setActiveTab] = useState<'experts' | 'sandbox' | 'knowledge'>('experts')

  return (
    <div className="dashboard-container">
      {/* Sidebar */}
      <div className="admin-sidebar">
        <div className="sidebar-header">
          <h1>iML Work Admin</h1>
          <p>Enterprise Admin Console</p>
        </div>

        <div className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === 'experts' ? 'active' : ''}`}
            onClick={() => setActiveTab('experts')}
          >
            <Award size={16} />
            <span>岗位专家管理</span>
          </button>

          <button 
            className={`nav-item ${activeTab === 'sandbox' ? 'active' : ''}`}
            onClick={() => setActiveTab('sandbox')}
          >
            <ShieldCheck size={16} />
            <span>沙箱监控审计</span>
          </button>

          <button 
            className={`nav-item ${activeTab === 'knowledge' ? 'active' : ''}`}
            onClick={() => setActiveTab('knowledge')}
          >
            <Database size={16} />
            <span>企业云知识库</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <p>iML Core Engine v1.0</p>
          <p style={{ fontSize: '9px', marginTop: '4px' }}>Server: localhost:8080</p>
        </div>
      </div>

      {/* Main Panel View */}
      <div className="dashboard-content">
        <div className="top-navbar">
          <div className="top-navbar-title">
            {activeTab === 'experts' && '岗位专家与自动化技能包定义'}
            {activeTab === 'sandbox' && '客户端沙箱容器与同步审计监控'}
            {activeTab === 'knowledge' && '企业云端分布式知识库控制中心'}
          </div>

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
          {activeTab === 'experts' && <ExpertManager />}
          {activeTab === 'sandbox' && <SandboxManager />}
          {activeTab === 'knowledge' && <KnowledgeManager />}
        </div>
      </div>
    </div>
  )
}
