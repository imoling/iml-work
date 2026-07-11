import React, { useState, useEffect } from 'react'
import { Brain, User, ShieldCheck, Database, Plus, Trash2, RefreshCw } from 'lucide-react'
import { useMemoryStore } from '../stores/memoryStore'
import { useUserStore } from '../stores/userStore'

// 资料与记忆：主体是「个人长期记忆」（用户手动/对话沉淀，会持续增长，对话时自动注入）。
// 岗位 Soul 与企业知识库随领用自动生效、在别处有完整视图（技能页 / 文件→资料库），
// 此处只留一句话说明 + 指路，不重复铺陈列表。
export default function MemoryPanel() {
  const { personalFacts, roleProfile, roleSkills, entTotal, isLoading, addPersonalFact, deletePersonalFact, loadMemories } = useMemoryStore()
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
            管理分身对你的<b>个人长期记忆</b>（每次对话自动注入）。岗位 Soul 与企业知识库随领用自动生效，见下方说明。
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
            写入你的背景、习惯或偏好，分身会<b>记住</b>并在之后每次对话自动带上，省去反复交代。仅存本地、按岗位隔离。聊天中说"记住…"也会自动沉淀到这里。
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

        {/* 右：个人长期记忆列表（主体，会持续增长） + 两条说明 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isLoading ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>正在加载记忆…</div>
          ) : (
            <>
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

              {/* 说明条 ①：岗位 Soul —— 完整内容在技能页/管理端，这里只说明生效方式 */}
              <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <ShieldCheck size={15} color="var(--accent-green)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <b style={{ color: 'var(--text-primary)' }}>岗位 Soul</b>
                  {roleProfile?.title ? `（${roleProfile.title}）` : ''}：随领用岗位同步的人格与能力——职责画像、行为准则、工作风格、业务域侧重与 {roleSkills.length} 项内置技能，对话中<b>自动生效</b>（技能按语义路由调用）。
                  技能明细见左侧「<b>技能</b>」页；岗位配置由管理端「岗位专家」维护。
                </div>
              </div>

              {/* 说明条 ②：企业知识库 —— 实体展示在 文件→资料库，这里只说明生效方式 */}
              <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <Database size={15} color="var(--brand-primary)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <b style={{ color: 'var(--text-primary)' }}>企业知识库</b>：授权范围内当前可检索 <b>{entTotal}</b> 篇，回答问题时<b>按需检索引用</b>（不整体注入）。
                  范围与文档明细见左侧「<b>文件 → 资料库</b>」；个人资料也可在那里提名归档进企业库。
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
