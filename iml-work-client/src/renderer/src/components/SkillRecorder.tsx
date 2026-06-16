import { useState, useEffect, useRef } from 'react'
import { X, Circle, Square, Trash2, MousePointerClick, Keyboard, ListChecks, Save, Loader2 } from 'lucide-react'

interface SysItem { id: string; name: string; baseUrl: string; type: string }
interface RecStep { action: 'click' | 'fill' | 'select'; selector: string; value: string; label: string; tag: string; url: string }

type Phase = 'setup' | 'recording' | 'review'

export default function SkillRecorder({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [phase, setPhase] = useState<Phase>('setup')
  const [systems, setSystems] = useState<SysItem[]>([])
  const [systemId, setSystemId] = useState('')
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [liveSteps, setLiveSteps] = useState<RecStep[]>([])
  const [steps, setSteps] = useState<RecStep[]>([])
  const [marked, setMarked] = useState<Record<number, boolean>>({})
  const [labels, setLabels] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const unsubRef = useRef<null | (() => void)>(null)

  useEffect(() => {
    window.api.invoke('systems:list').then((r: any) => {
      if (r?.ok) { setSystems(r.systems || []); if (r.systems?.[0]) setSystemId(r.systems[0].id) }
    })
    return () => { if (unsubRef.current) unsubRef.current() }
  }, [])

  const sys = systems.find(s => s.id === systemId)

  const startRecording = async () => {
    setErr('')
    if (!sys) { setErr('请先选择要操作的业务系统'); return }
    if (!name.trim()) { setErr('请填写技能名称'); return }
    setLiveSteps([])
    unsubRef.current = window.api.on('recorder:step', (step: RecStep) => setLiveSteps(prev => [...prev, step]))
    const r = await window.api.invoke('recorder:start', { systemId: sys.id, baseUrl: sys.baseUrl, systemName: sys.name })
    if (!r?.ok) { setErr('无法启动录制：' + (r?.error || '未知错误')); if (unsubRef.current) unsubRef.current(); return }
    setPhase('recording')
  }

  const stopRecording = async () => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    const r = await window.api.invoke('recorder:stop')
    const captured: RecStep[] = (r?.steps || [])
    setSteps(captured)
    // 默认把所有 fill/select 步骤标为可填字段
    const m: Record<number, boolean> = {}, l: Record<number, string> = {}
    captured.forEach((s, i) => { if (s.action !== 'click') { m[i] = true; l[i] = s.label || `字段${i + 1}` } })
    setMarked(m); setLabels(l)
    setPhase('review')
  }

  const cancelRecording = async () => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    await window.api.invoke('recorder:cancel')
    onClose()
  }

  const deleteStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx))
    setMarked(prev => { const n = { ...prev }; delete n[idx]; return n })
    setLabels(prev => { const n = { ...prev }; delete n[idx]; return n })
  }

  const save = async () => {
    setErr('')
    if (steps.length === 0) { setErr('没有可保存的操作步骤'); return }
    setSaving(true)
    const outSteps = steps.map((s, i) => marked[i] ? { ...s, fieldName: `f${i}` } : s)
    const fields = steps.map((s, i) => marked[i]
      ? { name: `f${i}`, label: labels[i] || s.label || `字段${i + 1}`, type: s.tag === 'textarea' ? 'textarea' : 'text' }
      : null).filter(Boolean)
    const actionScript = JSON.stringify({ steps: outSteps, fields })
    const triggerKeywords = keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
    const r = await window.api.invoke('skill:save-recorded', {
      name: name.trim(), triggerKeywords, targetSystemId: systemId, actionScript
    })
    setSaving(false)
    if (!r?.ok) { setErr('保存失败：' + (r?.error || '未知错误')); return }
    onSaved()
  }

  const actionIcon = (a: string) => a === 'click' ? <MousePointerClick size={13} /> : a === 'select' ? <ListChecks size={13} /> : <Keyboard size={13} />

  return (
    <div className="rec-overlay" onClick={phase === 'recording' ? undefined : onClose}>
      <div className="rec-modal" onClick={e => e.stopPropagation()}>
        <div className="rec-head">
          <div style={{ fontWeight: 700, fontSize: 15 }}>实操录制业务技能</div>
          <button className="icon-btn" onClick={phase === 'recording' ? cancelRecording : onClose}><X size={16} /></button>
        </div>

        {phase === 'setup' && (
          <div className="rec-body">
            <div className="rec-hint">选择要操作的业务系统并命名技能，然后开始录制。系统会打开浏览器窗口（复用你已有的登录态），你只要照常操作一遍，平台会记录每一步点击与输入的稳健定位，生成可回放的技能。</div>
            <div className="form-field"><label className="form-label">目标业务系统</label>
              <select className="form-input" value={systemId} onChange={e => setSystemId(e.target.value)}>
                {systems.length === 0 && <option value="">（未配置业务系统，请先在 设置 → 企业系统连接 添加）</option>}
                {systems.map(s => <option key={s.id} value={s.id}>{s.name}（{s.type}）</option>)}
              </select>
            </div>
            <div className="form-field"><label className="form-label">技能名称</label>
              <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="例如：CRM 客户拜访记录录入" />
            </div>
            <div className="form-field"><label className="form-label">触发关键词（用逗号或空格分隔）</label>
              <input className="form-input" value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="拜访记录, 填写拜访, 客户拜访" />
            </div>
            {err && <div className="rec-err">{err}</div>}
            <div className="rec-actions">
              <button className="btn-secondary" onClick={onClose}>取消</button>
              <button className="btn-primary" onClick={startRecording} disabled={!sys}><Circle size={13} /><span>开始录制</span></button>
            </div>
          </div>
        )}

        {phase === 'recording' && (
          <div className="rec-body">
            <div className="rec-recording-bar"><span className="rec-dot-live" />正在录制 ·「{sys?.name}」· 请在弹出的浏览器窗口中操作，完成后点「结束录制」</div>
            <div className="rec-steps">
              {liveSteps.length === 0 && <div className="rec-empty">等待操作…每次点击/输入都会出现在这里</div>}
              {liveSteps.map((s, i) => (
                <div key={i} className="rec-step">
                  <span className="rec-step-ic">{actionIcon(s.action)}</span>
                  <span className="rec-step-label">{s.label || s.selector}</span>
                  {s.value && <span className="rec-step-val">{s.value}</span>}
                </div>
              ))}
            </div>
            <div className="rec-actions">
              <button className="btn-secondary" onClick={cancelRecording}>取消</button>
              <button className="btn-primary" onClick={stopRecording}><Square size={13} /><span>结束录制（{liveSteps.length} 步）</span></button>
            </div>
          </div>
        )}

        {phase === 'review' && (
          <div className="rec-body">
            <div className="rec-hint">核对录制的操作步骤。把需要每次让用户确认填写的输入步骤勾选为「可填字段」并起个名字——执行时会先弹出表单让用户确认这些值，再确定性回放全部步骤。</div>
            <div className="rec-steps rec-steps-review">
              {steps.map((s, i) => (
                <div key={i} className="rec-step-review">
                  <span className="rec-step-no">{i + 1}</span>
                  <span className="rec-step-ic">{actionIcon(s.action)}</span>
                  <span className="rec-step-label" title={s.selector}>{s.label || s.selector}</span>
                  {s.action !== 'click' ? (
                    <label className="rec-mark">
                      <input type="checkbox" checked={!!marked[i]} onChange={e => setMarked({ ...marked, [i]: e.target.checked })} />
                      可填字段
                      {marked[i] && <input className="rec-field-name" value={labels[i] || ''} onChange={e => setLabels({ ...labels, [i]: e.target.value })} placeholder="字段名" />}
                    </label>
                  ) : <span className="rec-step-val">{s.value}</span>}
                  <button className="icon-btn danger" onClick={() => deleteStep(i)}><Trash2 size={12} /></button>
                </div>
              ))}
              {steps.length === 0 && <div className="rec-empty">未捕获到操作步骤</div>}
            </div>
            {err && <div className="rec-err">{err}</div>}
            <div className="rec-actions">
              <button className="btn-secondary" onClick={() => setPhase('setup')}>重录</button>
              <button className="btn-primary" onClick={save} disabled={saving}>{saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}<span>{saving ? '保存中…' : '保存技能'}</span></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
