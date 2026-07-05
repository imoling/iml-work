import React, { useState, useEffect } from 'react'
import { Brain, User, ShieldCheck, Database, Plus, Trash2, Boxes, Info, RefreshCw, FileText } from 'lucide-react'
import { useMemoryStore } from '../stores/memoryStore'
import { useUserStore } from '../stores/userStore'
import { SKILL_TYPE_META } from './skillTypeMeta'

export default function MemoryPanel() {
  const { personalFacts, roleSkills, entCategories, entDocs, entTotal, isLoading, addPersonalFact, deletePersonalFact, loadMemories } = useMemoryStore()
  const claimedExpertId = useUserStore(s => s.claimedExpertId)
  const [newFact, setNewFact] = useState('')

  // 每次打开「资料与记忆」都刷新——聊天中"记住X"会在后台写入个人记忆，进面板需拉最新
  useEffect(() => { loadMemories(claimedExpertId) }, [claimedExpertId, loadMemories])

  const handleAddFact = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newFact.trim()) return
    addPersonalFact(newFact.trim())
    setNewFact('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="space-toolbar" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 'bold' }}>资料与记忆</h2>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            分身的三层记忆：你手动沉淀的<b>个人长期记忆</b>、领用岗位内置的<b>技能能力</b>、以及可按需检索的<b>企业知识库</b>。这些都会在对话时作为上下文自动带上。
          </p>
        </div>
        <button className="settings-btn" style={{ flexShrink: 0, padding: '6px 12px' }} onClick={() => loadMemories(claimedExpertId)} title="刷新（聊天中新记住的内容会写入这里）">
          <RefreshCw size={13} style={{ marginRight: 5, verticalAlign: 'middle' }} />刷新
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 20 }}>

        {/* 左：新增个人记忆 */}
        <div className="glass-card" style={{ padding: 20, height: 'fit-content', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--brand-primary)', fontWeight: 600, fontSize: 14 }}>
            <Brain size={18} /><span>沉淀个人长期记忆</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            写入你的背景、习惯或偏好，分身会<b>记住</b>并在之后每次对话自动带上，省去反复交代。仅存本地、按岗位隔离。
          </p>
          <form onSubmit={handleAddFact} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <textarea
              className="form-input"
              style={{ minHeight: 100, resize: 'vertical' }}
              placeholder="例如：财务报销发票抬头统一用子公司全称；我周五通常远程办公；对接客户偏好用正式书面语。"
              value={newFact}
              onChange={(e) => setNewFact(e.target.value)}
            />
            <button type="submit" className="settings-btn" style={{ width: '100%' }} disabled={!newFact.trim()}>
              <Plus size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />写入个人长期记忆
            </button>
          </form>
        </div>

        {/* 右：三层展示 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isLoading ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>正在加载记忆与知识…</div>
          ) : (
            <>
              {/* ① 个人长期记忆（真·可编辑） */}
              <div className="glass-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 10 }}>
                  <User size={16} color="var(--brand-secondary)" />
                  <span style={{ fontSize: 13, fontWeight: 'bold' }}>个人长期记忆</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {personalFacts.length} 条</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>本地存储 · 每次对话自动注入</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {personalFacts.map(fact => (
                    <div key={fact.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.12)', padding: 10, borderRadius: 8 }}>
                      <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.6 }}>
                        <div>{fact.content}</div>
                        {fact.timestamp && <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 4 }}>沉淀于 {fact.timestamp}</div>}
                      </div>
                      <button onClick={() => deletePersonalFact(fact.id)} title="删除这条记忆"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}>
                        <Trash2 size={13} style={{ color: 'var(--accent-red)' }} />
                      </button>
                    </div>
                  ))}
                  {personalFacts.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', padding: 10 }}>
                      还没有个人记忆。在左侧写入你的背景/习惯，分身就会记住它。
                    </div>
                  )}
                </div>
              </div>

              {/* ② 岗位技能能力（真·从领用技能派生，只读） */}
              <div className="glass-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 10 }}>
                  <ShieldCheck size={16} color="var(--accent-green)" />
                  <span style={{ fontSize: 13, fontWeight: 'bold' }}>岗位内置能力</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {roleSkills.length} 项技能</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>随领用岗位同步 · 只读</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {roleSkills.map(sk => {
                    const meta = SKILL_TYPE_META[sk.type] || { label: '自定义技能', icon: <Boxes size={14} /> }
                    return (
                      <div key={sk.id} style={{ fontSize: 12.5, background: 'rgba(16,185,129,0.03)', border: '1px solid rgba(16,185,129,0.1)', padding: 10, borderRadius: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                          <span style={{ color: 'var(--accent-green)' }}>{meta.icon}</span>{sk.name}
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>· {meta.label}</span>
                        </div>
                        {sk.description && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, maxHeight: 44, overflow: 'hidden' }}>{sk.description}</div>}
                      </div>
                    )
                  })}
                  {roleSkills.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', padding: 10 }}>
                      当前分身暂未装载技能，可在「设置 → 账号与画像」切换岗位。
                    </div>
                  )}
                </div>
              </div>

              {/* ③ 企业知识库（真·可检索范围 + 文档） */}
              <div className="glass-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 10 }}>
                  <Database size={16} color="var(--brand-primary)" />
                  <span style={{ fontSize: 13, fontWeight: 'bold' }}>企业知识库</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· 可检索 {entTotal} 篇</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>问答时按需 RAG 召回</span>
                </div>
                {/* 可检索范围 */}
                {entCategories.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>授权范围：</span>
                    {entCategories.map((c, i) => (
                      <span key={i} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: 'rgba(59,130,246,0.08)', color: 'var(--brand-primary)', border: '1px solid rgba(59,130,246,0.2)' }}>{c}</span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {entDocs.map((d, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, background: 'rgba(59,130,246,0.03)', border: '1px solid rgba(59,130,246,0.08)', padding: '7px 10px', borderRadius: 6 }}>
                      <FileText size={13} style={{ color: 'var(--brand-primary)', flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{d.category}</span>
                    </div>
                  ))}
                  {entTotal > entDocs.length && (
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', paddingLeft: 4 }}>…等共 {entTotal} 篇，按提问语义实时召回相关内容</div>
                  )}
                  {entTotal === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', padding: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Info size={13} />本岗位暂无可检索的企业知识（管理端「知识中心」上传并授权分类后，问答即可自动引用）。
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
