import { useEffect, useState } from 'react'
import { Clock, Plus, Repeat, Play, Trash2, Pencil, X, ArrowLeft, ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { useUserStore } from '../stores/userStore'

interface Sched {
  id: string; title: string; prompt: string; expertId: string; expertName: string
  freq: 'daily' | 'weekday' | 'weekly' | 'monthly'; time: string; dow: number; dom: number
  enabled: boolean; lastRun: number; createdAt: number
}

const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function cadence(t: Sched): string {
  if (t.freq === 'daily') return `每天 ${t.time}`
  if (t.freq === 'weekday') return `每个工作日 ${t.time}`
  if (t.freq === 'weekly') return `每${DOW[t.dow]} ${t.time}`
  if (t.freq === 'monthly') return `每月 ${t.dom} 日 ${t.time}`
  return t.time
}

interface TaskRun {
  id: number; task_id: string; conv_id: string; trigger: string
  status: string; summary: string; file_count: number; started_at: number; ended_at: number
}

const TRIGGER_LABEL: Record<string, string> = { schedule: '定时', manual: '手动', catchup: '补跑' }

export default function AutomationView({ onOpenConversation, openTaskId, onTaskOpened }: {
  onOpenConversation?: (convId: string) => void
  openTaskId?: string | null
  onTaskOpened?: () => void
}) {
  const { claimedExpertId, getCurrentExpertName } = useUserStore()
  const [list, setList] = useState<Sched[]>([])
  const [editing, setEditing] = useState<Sched | null>(null)
  // 详情视图（对齐主流形态）：点任务行进详情，展示指令 + 运行记录；每次运行是一个独立会话，Open 跳过去
  const [selId, setSelId] = useState<string | null>(null)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const sel = selId ? list.find(t => t.id === selId) || null : null
  const loadRuns = async (taskId: string) => {
    const r = await window.api.invoke('task-run:list', taskId).catch(() => [])
    setRuns(Array.isArray(r) ? r : [])
  }
  useEffect(() => { if (selId) loadRuns(selId) }, [selId])
  // 侧栏「定时任务」点进来 → 直接打开对应详情
  useEffect(() => {
    if (openTaskId) { setSelId(openTaskId); onTaskOpened?.() }
  }, [openTaskId])

  const blank = (): Sched => ({
    id: 'sch-' + Date.now(), title: '', prompt: '', expertId: claimedExpertId || '', expertName: getCurrentExpertName(),
    freq: 'daily', time: '09:00', dow: 1, dom: 1, enabled: true, lastRun: 0, createdAt: 0
  })
  const load = async () => { const r = await window.api.invoke('schedule:list'); setList(r || []) }
  useEffect(() => {
    load()
    // 聊天里说"每天…"自动建任务后，主进程发 schedule:changed → 实时刷新列表
    const un = window.api.on('schedule:changed', () => load())
    return () => { if (typeof un === 'function') un() }
  }, [])

  const save = async () => {
    if (!editing) return
    if (!editing.title.trim() || !editing.prompt.trim()) { alert('请填写任务名称与给分身的指令'); return }
    const r = await window.api.invoke('schedule:save', { ...editing, expertId: claimedExpertId || editing.expertId, expertName: getCurrentExpertName() })
    setList(r || []); setEditing(null)
  }
  const toggle = async (t: Sched) => { const r = await window.api.invoke('schedule:toggle', { id: t.id, enabled: !t.enabled }); setList(r || []) }
  const del = async (t: Sched) => { if (!confirm(`删除定时任务「${t.title}」？`)) return; const r = await window.api.invoke('schedule:delete', { id: t.id }); setList(r || []) }
  const runNow = async (t: Sched) => { await window.api.invoke('schedule:run-now', { id: t.id }) }

  const set = (patch: Partial<Sched>) => setEditing(e => e ? { ...e, ...patch } : e)

  // ── 详情视图 ──
  if (sel) {
    const fmtTs = (t: number) => t ? new Date(t * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
    return (
      <div className="wb">
        <div className="wb-inner">
          <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14 }} onClick={() => setSelId(null)}>
            <ArrowLeft size={14} />返回任务列表
          </button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="wb-hero-title" style={{ fontSize: 21 }}>{sel.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <span className={`pill ${sel.enabled ? 'pill-mint' : 'pill-gray'}`} style={{ cursor: 'pointer' }} onClick={() => toggle(sel)}>
                  <span className="pill-dot" />{sel.enabled ? '已启用' : '已暂停'}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Clock size={13} />{cadence(sel)}{sel.expertName ? ` · 由「${sel.expertName}」执行` : ''}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button className="settings-btn" onClick={() => { runNow(sel); setTimeout(() => loadRuns(sel.id), 800) }}><Play size={14} />立即运行</button>
              <button className="btn-secondary" onClick={() => { setEditing({ ...sel }); setSelId(null) }}><Pencil size={13} />编辑</button>
              <button className="btn-secondary" style={{ color: 'var(--accent-red)' }} onClick={() => { del(sel); setSelId(null) }}><Trash2 size={13} />删除</button>
            </div>
          </div>

          <div className="wb-section-title" style={{ marginTop: 22 }}>给分身的指令</div>
          <div className="svc-card" style={{ fontSize: 13.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{sel.prompt}</div>

          <div className="wb-section-title" style={{ marginTop: 22 }}>运行记录（{runs.length}）</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -6, marginBottom: 10 }}>
            每次运行都是一个独立会话——点「打开」可以查看分身当时做了什么，还能在那个会话里追问。
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {runs.length === 0 && (
              <div className="svc-card" style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                还没有运行记录。点右上角「立即运行」试一次。
              </div>
            )}
            {runs.map(r => (
              <div key={r.id} className="svc-card" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px' }}>
                <span style={{ marginTop: 2, flexShrink: 0 }}>
                  {r.status === 'ok' ? <CheckCircle2 size={15} color="var(--accent-green)" />
                    : r.status === 'error' ? <XCircle size={15} color="var(--accent-red)" />
                    : <Loader2 size={15} className="drawer-spin" color="var(--accent-blue)" />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmtTs(r.started_at)}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{TRIGGER_LABEL[r.trigger] || r.trigger}</span>
                    {r.file_count > 0 && <span style={{ color: 'var(--text-muted)' }}>· {r.file_count} 个文件</span>}
                  </div>
                  {r.summary && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {r.summary}
                    </div>
                  )}
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, alignSelf: 'center' }}>
                  {r.conv_id && onOpenConversation && (
                    <button className="btn-secondary run-op" onClick={() => onOpenConversation(r.conv_id)}>
                      打开<ExternalLink size={12} />
                    </button>
                  )}
                  <button className="btn-secondary run-op run-op-del" title="删除该运行记录（连同这次运行的会话）"
                    onClick={async () => {
                      if (!confirm(`删除 ${fmtTs(r.started_at)} 的运行记录？该次运行的会话也会一并删除。`)) return
                      await window.api.invoke('task-run:delete', r.id)
                      if (selId) loadRuns(selId)
                    }}>
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="wb">
      <div className="wb-inner">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="wb-hero-title" style={{ fontSize: 22 }}>任务</div>
            <div className="wb-hero-sub">设定定时任务，到点自动把指令发给工作分身执行（写操作仍需你人工确认）。</div>
          </div>
          <button className="settings-btn" onClick={() => setEditing(blank())}><Plus size={15} />新建定时任务</button>
        </div>

        <div className="wb-section-title">定时任务（{list.length}）</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {list.length === 0 && (
            <div className="svc-card" style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              还没有定时任务。点右上角「新建定时任务」，例如：每天 18:00 汇总我的待办、每周一 09:00 巡检报销单。
            </div>
          )}
          {list.map(t => (
            <div key={t.id} className="svc-card" style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }} onClick={() => setSelId(t.id)}>
              <div className="svc-ic"><Repeat size={18} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="svc-name">{t.title}</div>
                <div className="svc-meta" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.prompt}</div>
                {t.expertName && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>岗位：{t.expertName}</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                <Clock size={13} />{cadence(t)}
              </div>
              <span className={`pill ${t.enabled ? 'pill-mint' : 'pill-gray'}`} style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); toggle(t) }} title="点击启用 / 暂停">
                <span className="pill-dot" />{t.enabled ? '已启用' : '已暂停'}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="aut-ico" title="立即运行一次" onClick={e => { e.stopPropagation(); runNow(t) }}><Play size={14} /></button>
                <button className="aut-ico" title="编辑" onClick={e => { e.stopPropagation(); setEditing({ ...t }) }}><Pencil size={14} /></button>
                <button className="aut-ico" title="删除" onClick={e => { e.stopPropagation(); del(t) }}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 新建 / 编辑 —— 居中弹窗 */}
      {editing && (
        <div className="rec-overlay" onClick={() => setEditing(null)}>
          <div className="rec-modal" style={{ width: 540 }} onClick={e => e.stopPropagation()}>
            <div className="rec-head">
              <span style={{ fontSize: 15, fontWeight: 700 }}>{list.some(x => x.id === editing.id) ? '编辑定时任务' : '新建定时任务'}</span>
              <button className="aut-ico" onClick={() => setEditing(null)} title="关闭"><X size={16} /></button>
            </div>
            <div className="rec-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="form-label" style={{ margin: 0 }}>任务名称</label>
                <input className="form-input" placeholder="例如：每日待办汇总" value={editing.title} onChange={e => set({ title: e.target.value })} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="form-label" style={{ margin: 0 }}>给分身的指令 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· 到点会作为一句话发给分身执行</span></label>
                <textarea className="form-input" style={{ minHeight: 80, resize: 'vertical' }} placeholder="例如：查看我今天的待办工作并汇总成清单" value={editing.prompt} onChange={e => set({ prompt: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="form-label" style={{ margin: 0 }}>频率</label>
                  <select className="form-input" value={editing.freq} onChange={e => set({ freq: e.target.value as Sched['freq'] })}>
                    <option value="daily">每天</option>
                    <option value="weekday">每个工作日</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                  </select>
                </div>
                {editing.freq === 'weekly' && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="form-label" style={{ margin: 0 }}>星期</label>
                    <select className="form-input" value={editing.dow} onChange={e => set({ dow: parseInt(e.target.value, 10) })}>
                      {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </select>
                  </div>
                )}
                {editing.freq === 'monthly' && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="form-label" style={{ margin: 0 }}>日期（1-28）</label>
                    <input className="form-input" type="number" min={1} max={28} value={editing.dom} onChange={e => set({ dom: Math.min(28, Math.max(1, parseInt(e.target.value, 10) || 1)) })} />
                  </div>
                )}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="form-label" style={{ margin: 0 }}>时间</label>
                  <input className="form-input" type="time" value={editing.time} onChange={e => set({ time: e.target.value })} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.18)', borderRadius: 8, padding: '10px 12px' }}>
                将在 <b>{cadence(editing)}</b> 由当前领用的岗位「{getCurrentExpertName() || '未领用'}」执行。
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
                <button className="btn-secondary" onClick={() => setEditing(null)}>取消</button>
                <button className="settings-btn" onClick={save}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
