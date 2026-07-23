// 实操录制技能（员工版）——「录制 → 语义 SKILL」流水线（设计：docs/design-recording-to-semantic-skill.md）。
// 录制是「演示」：结束录制后交 AI 转译成语义 SKILL（意图 + 参数表 + SOP），评审区以**参数表 + SOP 为中心**，
// 录制步骤折叠为参考（hints）。执行由 browse 按 SOP 分步推进（M2）。
import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Circle, Square, Save, Loader2, Sparkles, Plus, Trash2, ChevronRight, ChevronDown, MousePointerClick, Keyboard, ListChecks } from 'lucide-react'
import { useUserStore } from '../stores/userStore'

interface SysItem { id: string; name: string; baseUrl: string; type: string }
interface RecStep { action: string; selector: string; value: string; label: string; tag: string; url: string; inputType?: string; options?: string[] }
interface SkillParam { name: string; type: 'text' | 'date' | 'select' | 'search'; sample: string; options?: string[]; required?: boolean }

type Phase = 'setup' | 'recording' | 'review'

// 录制草稿本地键（v3 形状）：评审内容实时存本地，保存失败（登录/权限/网络）不丢，下次打开自动恢复。
const DRAFT_KEY = 'iml-rec-draft-v3'

const PARAM_TYPE_LABEL: Record<SkillParam['type'], string> = { text: '文本', date: '日期', select: '下拉', search: '检索选择' }

// 规则兜底（AI 转译失败时）：fill/select 步骤直接进参数表；SOP 规则拼接引用 {{参数名}}。
const FORM_DATE = new Set(['date', 'datetime-local', 'time', 'month', 'week'])
function fallbackTranspile(steps: RecStep[], name: string): { kind: 'read' | 'write'; params: SkillParam[]; sop: string } {
  const params: SkillParam[] = []
  const lines: string[] = [`# ${name || '录制技能'} SOP`, '', '## 操作步骤', '1. 打开绑定的业务系统（登录会话由客户端注入）。']
  let n = 2
  const seen = new Set<string>()
  steps.forEach((s, i) => {
    const label = (s.label || '').trim() || `字段${i + 1}`
    if (s.action === 'fill' || s.action === 'select') {
      let pname = label
      for (let k = 2; seen.has(pname); k++) pname = `${label}${k}`
      seen.add(pname)
      const type: SkillParam['type'] = s.action === 'select' ? 'select' : (FORM_DATE.has(String(s.inputType || '').toLowerCase()) ? 'date' : 'text')
      params.push({ name: pname, type, sample: s.value || '', options: Array.isArray(s.options) && s.options.length ? s.options : undefined })
      lines.push(`${n++}. 在「${label}」${s.action === 'select' ? '选择' : '填入'}「{{${pname}}}」。`)
    } else if (s.action === 'click' && label) {
      lines.push(`${n++}. 点击「${label}」。`)
    }
  })
  lines.push('', '## 反馈要求', '- 成功：回报操作完成并复述关键信息；失败/未登录：如实说明卡在哪一步，绝不编造业务数据。')
  const kind: 'read' | 'write' = steps.some(s => s.action === 'fill' || s.action === 'select') ? 'write' : 'read'
  return { kind, params, sop: lines.join('\n') }
}

// 录制步骤的人话展示（折叠参考区用，只读）。
function readableStep(s: RecStep): string {
  const lbl = (s.label || '').trim()
  if (lbl && !/[>{}]|nth-of-type|:nth|#|\.[a-z]/i.test(lbl)) return lbl
  const act = s.action === 'fill' ? '填写' : s.action === 'select' ? '选择' : '点击'
  const row = (s.selector || '').match(/tr:nth-of-type\((\d+)\)/)
  if (row) return `${act} · 表格第 ${row[1]} 行`
  if (s.action === 'fill') return '填写 · 输入框' + (s.value ? `（${String(s.value).slice(0, 16)}）` : '')
  if (s.action === 'select') return '选择 · 下拉' + (s.value ? `（${String(s.value).slice(0, 16)}）` : '')
  return `${act} · ${((s.selector || '').split('>').pop() || '元素').trim().replace(/:nth-of-type\(\d+\)/g, '').replace(/[#.].*/, '') || '元素'}`
}

export default function SkillRecorder({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [phase, setPhase] = useState<Phase>('setup')
  const [systems, setSystems] = useState<SysItem[]>([])
  const [systemId, setSystemId] = useState('')
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [liveSteps, setLiveSteps] = useState<RecStep[]>([])
  const [steps, setSteps] = useState<RecStep[]>([])            // 录制原始步骤 = hints（只读参考）
  // ── 语义 SKILL（评审主体）────────────────────────────────────────────────
  const [transpiling, setTranspiling] = useState(false)
  const [transpileFailed, setTranspileFailed] = useState(false)
  const [intent, setIntent] = useState('')
  const [kind, setKind] = useState<'read' | 'write'>('write')
  const [params, setParams] = useState<SkillParam[]>([])
  const [sop, setSop] = useState('')
  const sopDirty = useRef(false)
  const [showSteps, setShowSteps] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [restored, setRestored] = useState(false)
  const unsubRef = useRef<null | (() => void)>(null)

  useEffect(() => {
    let draft: any = null
    try { const raw = localStorage.getItem(DRAFT_KEY); if (raw) draft = JSON.parse(raw) } catch (e) { console.error('[rec-draft] 读取草稿失败', e) }
    window.api.invoke('systems:list').then((r: any) => {
      if (r?.ok) {
        setSystems(r.systems || [])
        if (draft?.systemId) setSystemId(draft.systemId)
        else if (r.systems?.[0]) setSystemId(r.systems[0].id)
      }
    })
    if (draft && Array.isArray(draft.steps) && draft.steps.length) {
      setName(draft.name || ''); setKeywords(draft.keywords || '')
      setSteps(draft.steps); setIntent(draft.intent || ''); setKind(draft.kind === 'read' ? 'read' : 'write')
      setParams(Array.isArray(draft.params) ? draft.params : [])
      if (draft.sop) { setSop(draft.sop); sopDirty.current = true }
      setRestored(true); setPhase('review')
    }
    return () => { if (unsubRef.current) unsubRef.current() }
  }, [])

  // 评审期实时存草稿（保存失败不丢）；保存成功/重录时清。
  useEffect(() => {
    if (phase !== 'review') return
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ systemId, name, keywords, steps, intent, kind, params, sop })) }
    catch (e) { console.error('[rec-draft] 写入草稿失败', e) }
  }, [phase, systemId, name, keywords, steps, intent, kind, params, sop])
  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY) } catch (e) { console.error('[rec-draft] 清除草稿失败', e) } }

  const sys = systems.find(s => s.id === systemId)

  // ── AI 转译：结束录制自动跑；失败退规则版兜底（不阻塞保存）──────────────────
  const runTranspile = useCallback(async (captured: RecStep[]) => {
    setTranspiling(true); setTranspileFailed(false)
    const u = useUserStore.getState()
    const llmConfig = {
      mode: (u.llmConnectionMode === 'proxy' || u.llmConnectionMode === 'direct') ? u.llmConnectionMode : 'direct',
      apiMode: (u.llmApiMode === 'chat' || u.llmApiMode === 'anthropic') ? u.llmApiMode : 'chat',
      baseUrl: u.llmBaseUrl || '', apiKey: u.llmApiKey || '', modelName: u.llmModelName || ''
    }
    const sysName = systems.find(s => s.id === systemId)?.name || '业务系统'
    let ok = false
    try {
      const r = await window.api.invoke('skill:transpile-recording', { steps: captured, name: name.trim() || '录制技能', systemName: sysName, llmConfig })
      if (r?.ok && r.skill) {
        setIntent(r.skill.intent || ''); setKind(r.skill.kind === 'read' ? 'read' : 'write')
        setParams(Array.isArray(r.skill.params) ? r.skill.params : [])
        if (!sopDirty.current) setSop(r.skill.sop || '')
        ok = true
      }
    } catch (e) { console.error('[rec-transpile] 调用失败', e) }
    if (!ok) {
      const fb = fallbackTranspile(captured, name.trim())
      setKind(fb.kind); setParams(fb.params)
      if (!sopDirty.current) setSop(fb.sop)
      setTranspileFailed(true)
    }
    setTranspiling(false)
  }, [systems, systemId, name])

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

  // 进入评审：主窗「结束录制」与录制窗浮层按钮（recorder:stopped）共用；进入即触发 AI 转译。
  const enterReview = useCallback((captured: RecStep[]) => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    setSteps(captured)
    setIntent(''); setParams([]); setSop(''); sopDirty.current = false; setKind('write'); setTranspileFailed(false)
    setPhase('review')
    if (captured.length) void runTranspile(captured)
  }, [runTranspile])
  const stopRecording = async () => {
    const r = await window.api.invoke('recorder:stop')
    enterReview(r?.steps || [])
  }
  useEffect(() => {
    const un = window.api.on('recorder:stopped', (payload: { cancelled?: boolean; steps?: RecStep[] }) => {
      if (payload?.cancelled) { if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }; onClose(); return }
      enterReview(payload?.steps || [])
    })
    return () => { un && un() }
  }, [enterReview, onClose])

  const cancelRecording = async () => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    await window.api.invoke('recorder:cancel')
    onClose()
  }

  // ── 参数表编辑 ───────────────────────────────────────────────────────────
  const patchParam = (i: number, patch: Partial<SkillParam>) => setParams(prev => prev.map((p, idx) => idx === i ? { ...p, ...patch } : p))
  const deleteParam = (i: number) => setParams(prev => prev.filter((_, idx) => idx !== i))
  const addParam = () => setParams(prev => [...prev, { name: '', type: 'text', sample: '' }])

  const save = async () => {
    setErr('')
    if (steps.length === 0) { setErr('没有可保存的录制内容'); return }
    if (!sop.trim()) { setErr('SOP 不能为空（AI 生成失败可点「重新生成」或手写）'); return }
    const cleanParams = params.map(p => ({ ...p, name: (p.name || '').trim() })).filter(p => p.name)
    const dup = cleanParams.map(p => p.name).find((n, i, a) => a.indexOf(n) !== i)
    if (dup) { setErr(`参数「${dup}」重名，请改名或删除`); return }
    setSaving(true)
    // v3：语义 SKILL 为主体（params + SOP），录制步骤降级为 hints。
    const actionScript = JSON.stringify({ version: 3, params: cleanParams, hints: steps })
    const triggerKeywords = keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
    const r = await window.api.invoke('skill:save-recorded', {
      name: name.trim(), triggerKeywords, targetSystemId: systemId, actionScript,
      skillKind: kind, sopContent: sop.trim(), description: intent.trim()
    })
    setSaving(false)
    if (!r?.ok) { setErr('保存失败：' + (r?.error || '未知错误')); return }
    clearDraft()
    onSaved()
  }

  const actionIcon = (a: string) => a === 'click' ? <MousePointerClick size={13} /> : a === 'select' ? <ListChecks size={13} /> : <Keyboard size={13} />

  return (
    <div className="rec-overlay" onClick={phase === 'recording' ? undefined : onClose}>
      <div className="rec-modal" onClick={e => e.stopPropagation()}>
        <div className="rec-head">
          <div style={{ fontWeight: 700, fontSize: 15 }}>实操录制技能</div>
          <button className="icon-btn" onClick={phase === 'recording' ? cancelRecording : onClose}><X size={16} /></button>
        </div>

        {phase === 'setup' && (
          <div className="rec-body">
            <div className="rec-hint">选择业务系统并命名技能，然后开始录制：你照常把这件事**演示一遍**，结束后 AI 会自动看懂这场演示——识别出每次会变的动态参数（日期/类型/审批人…）、生成操作 SOP。你只需核对确认，录完即用。</div>
            <div className="form-field"><label className="form-label">目标业务系统</label>
              <select className="form-input" value={systemId} onChange={e => setSystemId(e.target.value)}>
                {systems.length === 0 && <option value="">（未配置业务系统，请先在 设置 → 企业系统连接 添加）</option>}
                {systems.map(s => <option key={s.id} value={s.id}>{s.name}（{s.type}）</option>)}
              </select>
            </div>
            <div className="form-field"><label className="form-label">技能名称</label>
              <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="例如：考勤维护" />
            </div>
            <div className="form-field"><label className="form-label">触发关键词（用逗号或空格分隔）</label>
              <input className="form-input" value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="考勤维护, 补卡, 因公误时" />
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
            <div className="rec-recording-bar"><span className="rec-dot-live" />正在录制 ·「{sys?.name}」· 请在弹出的浏览器窗口中演示一遍，完成后点「结束录制」</div>
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
            {restored && <div className="rec-hint" style={{ background: '#f0fdf4', borderColor: '#16a34a', color: '#15803d' }}>已恢复上次未保存的录制（{steps.length} 步）——核对后可直接保存；不想要就点「重录」。</div>}

            {transpiling ? (
              <div className="rec-transpiling"><Loader2 size={16} className="spin" /><span>AI 正在把这场演示整理成技能：识别动态参数、生成操作 SOP…</span></div>
            ) : (
              <>
                {transpileFailed && <div className="rec-hint" style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.35)' }}>AI 转译暂不可用，已按规则生成初稿——参数与 SOP 可手动修改，不影响保存。可点 SOP 右上「重新生成」重试 AI。</div>}
                {intent && <div className="rec-intent">{intent}</div>}

                {/* 读/写判定（AI 判 + 可覆盖） */}
                <div className="rec-kindbar">
                  <span className="rec-kindbar-lbl">读/写判定</span>
                  {(['read', 'write'] as const).map(v => (
                    <button key={v} type="button" className={'rec-kind-btn' + (kind === v ? ' on' : '')} onClick={() => setKind(v)}>{v === 'read' ? '读取' : '写入'}</button>
                  ))}
                  <span className="rec-kind-note">{kind === 'write' ? '写入类：执行前确认参数，提交前读单据签字' : '读取类：只打开抓取，不改动系统'}</span>
                </div>

                {/* 参数表（评审主体①）：AI 自动识别的动态参数，确认/改名即可 */}
                <div className="rec-params">
                  <div className="rec-params-head">
                    <span className="rec-sop-title">动态参数<span className="rec-sop-sub">每次执行会变的值——AI 已从演示识别，录制值只是样例</span></span>
                    <button type="button" className="rec-sop-regen" onClick={addParam}><Plus size={11} /> 添加参数</button>
                  </div>
                  {params.length === 0 && <div className="rec-empty" style={{ padding: 12 }}>无参数（纯固定流程技能）。若有每次会变的值，点「添加参数」补上并在 SOP 里以 {'{{参数名}}'} 引用。</div>}
                  {params.map((p, i) => (
                    <div key={i} className="rec-param-row">
                      <input className="rec-field-name" style={{ width: 120 }} value={p.name} placeholder="参数名" onChange={e => patchParam(i, { name: e.target.value })} />
                      <span className="rec-param-type">{PARAM_TYPE_LABEL[p.type] || p.type}</span>
                      <span className="rec-param-sample" title={p.options?.length ? `候选：${p.options.join(' / ')}` : undefined}>
                        样例：{p.sample || '（空）'}{p.options?.length ? `（${p.options.length} 个候选）` : ''}
                      </span>
                      <label className="rec-mark"><input type="checkbox" checked={!!p.required} onChange={e => patchParam(i, { required: e.target.checked })} />必填</label>
                      <button className="icon-btn danger" onClick={() => deleteParam(i)}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>

                {/* SOP（评审主体②）：browse 分步执行的可控计划 */}
                <div className="rec-sop">
                  <div className="rec-sop-head">
                    <span className="rec-sop-title">操作 SOP<span className="rec-sop-sub">执行时分身按此分步推进，可编辑；参数以 {'{{参数名}}'} 引用</span></span>
                    <button type="button" className="rec-sop-regen" onClick={() => { sopDirty.current = false; void runTranspile(steps) }}><Sparkles size={11} /> 重新生成</button>
                  </div>
                  <textarea className="rec-sop-text" rows={8} value={sop}
                    onChange={e => { sopDirty.current = true; setSop(e.target.value) }}
                    placeholder="AI 转译后自动生成，可编辑" />
                </div>

                {/* 录制步骤（折叠参考，hints） */}
                <div className="rec-steps-fold">
                  <button type="button" className="rec-fold-btn" onClick={() => setShowSteps(v => !v)}>
                    {showSteps ? <ChevronDown size={13} /> : <ChevronRight size={13} />} 录制步骤（{steps.length} 步 · 仅作执行时的定位参考）
                  </button>
                  {showSteps && (
                    <div className="rec-steps rec-steps-review">
                      {steps.map((s, i) => (
                        <div key={i} className="rec-step-review">
                          <span className="rec-step-no">{i + 1}</span>
                          <span className="rec-step-ic">{actionIcon(s.action)}</span>
                          <span className="rec-step-label" title={s.selector}>{readableStep(s)}</span>
                          {s.value && <span className="rec-step-val">{s.value}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {err && <div className="rec-err">{err}</div>}
            <div className="rec-actions">
              <button className="btn-secondary" onClick={() => { clearDraft(); setRestored(false); setIntent(''); setParams([]); setSop(''); sopDirty.current = false; setPhase('setup') }}>重录</button>
              <button className="btn-primary" onClick={save} disabled={saving || transpiling}>{saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}<span>{saving ? '保存中…' : '保存技能'}</span></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
