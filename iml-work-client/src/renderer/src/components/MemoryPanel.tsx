import React, { useState } from 'react'
import { Brain, User, ShieldCheck, Database, Plus, Trash2 } from 'lucide-react'
import { useMemoryStore } from '../stores/memoryStore'

export default function MemoryPanel() {
  const { memories, isLoading, addPersonalFact, deletePersonalFact } = useMemoryStore()
  const [newFact, setNewFact] = useState('')

  const handleAddFact = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newFact.trim()) return
    addPersonalFact(newFact.trim())
    setNewFact('')
  }

  // Filter memories by level
  const assistantFacts = memories.filter(m => m.level === 'assistant')
  const personalFacts = memories.filter(m => m.level === 'personal')
  const corporateFacts = memories.filter(m => m.level === 'corporate')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="space-toolbar">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 'bold' }}>记忆分级管理面板 (Hierarchical Memory Manager)</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            通过分级关联控制隐私合规与专业技能。所有本地与企业数据将注入 ReAct 执行流作为 Context 支撑。
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
        
        {/* Left side: Add Personal Fact Form */}
        <div className="glass-card" style={{ padding: '20px', height: 'fit-content', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--brand-primary)', fontWeight: '600', fontSize: '14px' }}>
            <Brain size={18} />
            <span>个人记忆体增补 (Add Personal Fact)</span>
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            在此增添您的特定背景知识或业务偏好，AI 会自动将其加载至对话的系统提示词（System Prompt）中，省去每次输入背景信息的繁琐。
          </p>

          <form onSubmit={handleAddFact} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-field">
              <textarea
                className="form-input"
                style={{ minHeight: '100px', resize: 'vertical' }}
                placeholder="例如: 财务报销发票抬头均需使用子公司全称；周五通常在远程办公。"
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
              />
            </div>
            <button type="submit" className="settings-btn" style={{ width: '100%' }}>
              <Plus size={14} style={{ marginRight: '6px', verticalAlign: 'middle', display: 'inline-block' }} />
              写入个人长期记忆
            </button>
          </form>
        </div>

        {/* Right side: Hierarchical List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {isLoading ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px' }}>
              正在检索级联记忆 facts...
            </div>
          ) : (
            <>
              {/* Personal Level */}
              <div className="glass-card" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '10px' }}>
                  <User size={16} color="var(--brand-secondary)" />
                  <span style={{ fontSize: '13px', fontWeight: 'bold' }}>员工个人记忆级 (Personal Level Facts)</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    本地设备硬件级加密存储 (safeStorage)
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {personalFacts.map(fact => (
                    <div key={fact.id} style={{ display: 'flex', justifyContent: 'between', alignItems: 'flex-start', background: 'rgba(139, 92, 246, 0.03)', border: '1px solid rgba(139, 92, 246, 0.1)', padding: '10px', borderRadius: '6px' }}>
                      <div style={{ flex: 1, fontSize: '12px', lineHeight: '1.5' }}>
                        <div>{fact.content}</div>
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          来源: {fact.source} | 时间: {fact.timestamp}
                        </div>
                      </div>
                      <button 
                        onClick={() => deletePersonalFact(fact.id)}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
                        title="删除记忆"
                      >
                        <Trash2 size={12} style={{ color: 'var(--accent-red)' }} />
                      </button>
                    </div>
                  ))}
                  {personalFacts.length === 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '10px' }}>
                      无个人长期记忆沉淀，请在左侧添加。
                    </div>
                  )}
                </div>
              </div>

              {/* Assistant Level */}
              <div className="glass-card" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '10px' }}>
                  <ShieldCheck size={16} color="var(--accent-green)" />
                  <span style={{ fontSize: '13px', fontWeight: 'bold' }}>专家助手内置记忆级 (Assistant SOP Level)</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    随专家技能同步包拉取，防篡改只读
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {assistantFacts.map(fact => (
                    <div key={fact.id} style={{ fontSize: '12px', lineHeight: '1.5', background: 'rgba(16, 185, 129, 0.02)', border: '1px solid rgba(16, 185, 129, 0.08)', padding: '10px', borderRadius: '6px' }}>
                      <div>{fact.content}</div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        SOP源: {fact.source} | 载入时间: {fact.timestamp}
                      </div>
                    </div>
                  ))}
                  {assistantFacts.length === 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '10px' }}>
                      未载入当前专家的 SOP 技能包，请前往专家列表领用。
                    </div>
                  )}
                </div>
              </div>

              {/* Corporate Level */}
              <div className="glass-card" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '10px' }}>
                  <Database size={16} color="var(--brand-primary)" />
                  <span style={{ fontSize: '13px', fontWeight: 'bold' }}>企业全局云端知识级 (Corporate Cloud RAG)</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    云端知识库同步映射，按需只读拉取
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {corporateFacts.map(fact => (
                    <div key={fact.id} style={{ fontSize: '12px', lineHeight: '1.5', background: 'rgba(59, 130, 246, 0.02)', border: '1px solid rgba(59, 130, 246, 0.08)', padding: '10px', borderRadius: '6px' }}>
                      <div>{fact.content}</div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        云文档: {fact.source} | 同步时间: {fact.timestamp}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
