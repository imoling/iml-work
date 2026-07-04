import { useEffect, useState } from 'react'
import { Workflow, Clock, Plus, Repeat, Play, Trash2, Pencil, X } from 'lucide-react'
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

export default function AutomationView() {
  const { claimedExpertId, getCurrentExpertName } = useUserStore()
  const [list, setList] = useState<Sched[]>([])
  const [editing, setEditing] = useState<Sched | null>(null)

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

  return (
    <div className="wb">
      <div className="wb-inner">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="wb-hero-title" style={{ fontSize: 22 }}>自动化</div>
            <div className="wb-hero-sub">设定定时任务，让工作分身在指定时间自动执行。到点会把指令注入对话，按完整链路执行（写操作仍需你人工确认）。</div>
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
            <div key={t.id} className="svc-card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="svc-ic"><Repeat size={18} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="svc-name">{t.title}</div>
                <div className="svc-meta" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.prompt}</div>
                {t.expertName && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>岗位：{t.expertName}</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                <Clock size={13} />{cadence(t)}
              </div>
              <span className={`pill ${t.enabled ? 'pill-mint' : 'pill-gray'}`} style={{ cursor: 'pointer' }} onClick={() => toggle(t)} title="点击启用 / 暂停">
                <span className="pill-dot" />{t.enabled ? '已启用' : '已暂停'}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="aut-ico" title="立即运行一次" onClick={() => runNow(t)}><Play size={14} /></button>
                <button className="aut-ico" title="编辑" onClick={() => setEditing({ ...t })}><Pencil size={14} /></button>
                <button className="aut-ico" title="删除" onClick={() => del(t)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, fontSize: 12, color: 'var(--text-muted)' }}>
          <Workflow size={14} /> 定时任务在本地安全环境中按计划唤起工作分身；需应用保持运行。
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
