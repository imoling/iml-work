import React, { useState, useEffect, useRef } from 'react'
import { SkillCenter, Admin, Browser, getBaseUrl } from '../services/api.js'
import { PageHeader, Tag } from '../components/ui.jsx'
import { getDraft } from '../lib/draftStore.js'

// 技能测试：核心是测「快速建技能」里正在调试的草稿（无需先发布）；也可选已上架技能
function parseSkill(sk, systems) {
  let fields = [], navHash = sk.navHash || ''
  try {
    const as = sk.actionScript ? JSON.parse(sk.actionScript) : null
    if (as) {
      if (Array.isArray(as.fields)) fields = as.fields
      if (!navHash) { const steps = as.rawSteps || as.steps || []; const c = steps.find(s => s && s.nav); navHash = c ? c.nav : '' }
    }
  } catch (_) {}
  const sys = (systems || []).find(s => s.id === sk.targetSystemId)
  return {
    name: sk.name, fields, navHash, systemId: sk.targetSystemId || '', sop: sk.sopContent || '',
    skillKind: sk.skillKind, kws: sk.triggerKeywords || [],
    baseUrl: sys ? sys.baseUrl : '', sysName: sys ? sys.name : '（未绑定/已删除）'
  }
}

export default function TestSkill() {
  const [draft, setDraftState] = useState(null)
  const [skills, setSkills] = useState([])
  const [systems, setSystems] = useState([])
  const [source, setSource] = useState('draft') // 'draft' | <skillId>
  const [paragraph, setParagraph] = useState('')
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState(null)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const lineUnsub = useRef(null)

  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))

  useEffect(() => {
    setDraftState(getDraft())
    Promise.all([SkillCenter.list(), Admin.integrations()]).then(([sk, sys]) => {
      setSkills(Array.isArray(sk) ? sk : []); setSystems(Array.isArray(sys) ? sys : [])
    }).catch(() => {})
    return () => { if (lineUnsub.current) lineUnsub.current() }
  }, [])

  // 当前测试目标（草稿 or 已上架技能）
  let target = null
  if (source === 'draft') {
    if (draft) target = { name: draft.name, fields: draft.fields || [], navHash: draft.navHash || '', systemId: draft.systemId || '', sop: draft.sop || '', skillKind: draft.skillKind, kws: draft.triggerKeywords || [], baseUrl: draft.baseUrl || '', sysName: draft.sysName || '（未选系统）' }
  } else {
    const sk = skills.find(s => s.id === source)
    if (sk) target = parseSkill(sk, systems)
  }
  const matched = !!(target && paragraph && (target.kws || []).some(k => paragraph.includes(k)))

  async function runTest() {
    if (!target) return fail('请先选择测试目标（草稿或已上架技能）')
    if (!paragraph.trim()) return fail('请输入一段话（模拟用户对分身说的需求）')
    if (!Browser.available()) return fail('技能测试需在桌面端运行')
    if (!target.baseUrl) return fail('该技能未绑定可访问的业务系统地址，无法执行链路测试')
    setBusy(true); setErr(''); setLines([]); setVerdict(null)
    try {
      if (lineUnsub.current) lineUnsub.current()
      lineUnsub.current = Browser.onLine(l => setLines(prev => [...prev, l]))
      const r = await Browser.testSkill({
        systemId: target.systemId, baseUrl: target.baseUrl, sop: target.sop,
        fields: target.fields, navHash: target.navHash, paragraph, adminBaseUrl: getBaseUrl()
      })
      if (lineUnsub.current) { lineUnsub.current(); lineUnsub.current = null }
      if (!r || r.ok === false) fail((r && r.error) || '测试出错')
      else if (r.loggedIn === false) note('窗口未登录，请在弹出的浏览器登录后重试')
      else { setVerdict({ passed: r.passed, reason: r.reason, fieldValues: r.fieldValues || {}, needInput: r.needInput || null }); note(r.passed ? '链路测试通过' : (r.needInput ? '参数不全，需补充' : '链路未通过，见诊断')) }
    } catch (e) { fail(e) } finally { setBusy(false); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }

  return (
    <>
      <PageHeader title="技能测试" desc="测「快速建技能」里正在调试的草稿：发一段话 → 提炼字段 → 真实链路执行 → 通过/失败，边调边测" />
      <div className="content grid" style={{ gap: 16, maxWidth: 920 }}>
        <div className="hint">在「快速建技能」里录制/命名字段/写 SOP 后，<b>不必发布</b>，直接来这里用真实场景验收：像用户那样说一句需求，系统按字段清单提炼参数，再用 navHash 直达 + AX 感知 + 工具调用真实跑一遍。通过=可上架；不通过=照诊断回去改，再测。</div>
        {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

        {/* 1. 测试目标 */}
        <div className="card grid" style={{ gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <b>1 · 测试目标</b>
            <Tag kind={source === 'draft' ? 'green' : 'gray'}>{source === 'draft' ? '当前草稿' : '已上架技能'}</Tag>
          </div>
          <select value={source} onChange={e => { setSource(e.target.value); setVerdict(null); setLines([]) }}>
            <option value="draft">当前草稿（来自「快速建技能」）{draft ? `：${draft.name}` : '（暂无，请先去建技能）'}</option>
            <optgroup label="已上架技能">
              {skills.map(s => <option key={s.id} value={s.id}>{s.name}（{s.id}）</option>)}
            </optgroup>
          </select>
          {source === 'draft' && !draft && <div className="err">还没有草稿。请先到「快速建技能」录制或编辑一个技能（含 SOP / 直达路由 / 字段），再回来测试。</div>}
          {target && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <b style={{ fontSize: 13 }}>{target.name}</b>
                <Tag kind={target.skillKind === 'read' ? 'blue' : 'amber'}>{target.skillKind === 'read' ? '读取类' : target.skillKind === 'write' ? '写入类' : '类型未标'}</Tag>
                {target.navHash ? <Tag kind="green">直达 {target.navHash}</Tag> : <Tag kind="gray">无直达路由</Tag>}
                <Tag kind="gray">{target.fields.length} 个字段</Tag>
                <span className="sec">系统：{target.sysName}</span>
              </div>
              <div className="sec">触发词：{(target.kws || []).length ? target.kws.join('、') : '（无）'}</div>
              {target.fields.length > 0 && <div className="sec">字段：{target.fields.map(f => f.label || f.name).join('、')}</div>}
              {!target.sop && <div className="err">该草稿还没有 SOP，agent 没有执行依据，请先在「快速建技能」写/生成 SOP。</div>}
            </div>
          )}
        </div>

        {/* 2. 一段话 */}
        <div className="card grid" style={{ gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>2 · 像用户那样说一句需求</b>
            {paragraph && <Tag kind={matched ? 'green' : 'amber'}>{matched ? '✓ 命中触发词' : '⚠ 未命中触发词'}</Tag>}
          </div>
          <textarea rows={3} value={paragraph} onChange={e => setParagraph(e.target.value)} placeholder="例：我今天拜访了中国石油天然气集团的李主任，聊了Q3合作方案，约定下周二再回访敲定合同。" style={{ fontSize: 13 }} />
        </div>

        {/* 3. 运行 + 结果 */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: (lines.length || verdict) ? 12 : 0 }}>
            <b>3 · 链路测试</b>
            <button className="primary" disabled={busy || !target} onClick={runTest}>{busy ? '测试中…' : '发送并测试'}</button>
          </div>
          {verdict && (
            verdict.needInput
              ? <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 600, color: '#B45309', background: '#FEF3E2', border: '1px solid #FCD9A8', borderRadius: 8, padding: '8px 12px' }}>
                  🟡 需要补充参数：{verdict.needInput.join('、')}（已暂停，未操作业务系统。请把这些信息说进需求里再测）
                </div>
              : <div className={verdict.passed ? 'ok' : 'err'} style={{ marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
                  {verdict.passed ? '✅ 链路测试通过' : `❌ 未通过：${verdict.reason || '未完成'}`}
                </div>
          )}
          {verdict && Object.keys(verdict.fieldValues || {}).length > 0 && (
            <div style={{ marginBottom: 10, fontSize: 12 }}>
              <div className="sec" style={{ marginBottom: 4 }}>提炼到的字段：</div>
              {Object.entries(verdict.fieldValues).map(([k, v]) => <div key={k}>· {k}：{v || '（空）'}</div>)}
            </div>
          )}
          {lines.length > 0 && (
            <div style={{ maxHeight: 320, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.8, color: 'var(--sec)' }}>
              {lines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>

        {!Browser.available() && <div className="hint">当前为浏览器预览，技能测试需在桌面端运行。</div>}
      </div>
    </>
  )
}
