import React, { useState } from 'react'
import { Scenarios } from '../../services/api.js'
import { Field, Tag } from '../../components/ui.jsx'
import { safeParse, SCENARIO_STATUS } from '../../lib/constants.js'
import { extractFacts, scoreScenario } from '../../lib/ai.js'

const FACT_FIELDS = [
  ['businessGoal', '业务目标', 2], ['triggerCondition', '触发条件', 2],
  ['roles', '使用角色', 1], ['systems', '涉及系统', 2],
  ['inputs', '输入材料', 2], ['outputs', '输出结果', 2],
  ['keyRules', '关键规则', 3], ['exceptions', '异常情况', 2],
  ['riskActions', '风险动作', 2], ['humanConfirmPoints', '人工确认点', 2]
]
const SCORE_DIMS = [
  ['frequency', '高频程度'], ['repeatability', '重复程度'], ['ruleClarity', '规则清晰度'],
  ['systemOperability', '系统可操作性'], ['dataAvailability', '数据可获得性'],
  ['riskControllability', '风险可控性'], ['auditNeed', '留痕必要性'], ['reusePotential', '复用潜力']
]
const RECO = {
  priority: { label: '优先转化', tag: 'green' }, pilot: { label: '可试点', tag: 'blue' },
  need_more_materials: { label: '需补充材料', tag: 'amber' }, not_recommended: { label: '不建议', tag: 'red' }
}

export default function Collect({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const [materials, setMaterials] = useState(init.materials || { description: scenario.description || '', interview: '', sop: '', systemNotes: '', files: [] })
  const [facts, setFacts] = useState(init.facts || null)
  const [score, setScore] = useState(init.score || null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const mUpd = (k) => (e) => setMaterials({ ...materials, [k]: e.target.value })
  const fUpd = (k) => (e) => setFacts({ ...facts, [k]: e.target.value })

  function note(m) { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 2500) }
  function fail(e) { setErr(typeof e === 'string' ? e : (e.message || '操作失败')) }

  async function persist(nextStatus) {
    const content = { ...init, materials, facts, score }
    const curStep = SCENARIO_STATUS[scenario.status]?.step ?? 0
    const tgtStep = SCENARIO_STATUS[nextStatus]?.step ?? 0
    const status = tgtStep > curStep ? nextStatus : scenario.status
    await Scenarios.update(scenario.id, { ...scenario, contentJson: JSON.stringify(content), status })
    await reload()
  }

  async function onExtract() {
    setBusy('extract'); setErr('')
    try {
      const f = await extractFacts(scenario, materials)
      if (!f) throw new Error('AI 未返回有效结果，请重试或检查管理端模型中转站')
      setFacts(f); note('已抽取场景要素，请核对后保存')
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function onScore() {
    setBusy('score'); setErr('')
    try {
      const s = await scoreScenario(scenario, facts)
      if (!s) throw new Error('AI 未返回有效评分')
      setScore(s); note('已生成评分，可手动微调')
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function saveMaterials() { setBusy('saveM'); try { await persist(scenario.status); note('素材已保存') } catch (e) { fail(e) } finally { setBusy('') } }
  async function saveFacts() { setBusy('saveF'); try { await persist('collected'); note('场景要素已保存，状态 → 已采集') } catch (e) { fail(e) } finally { setBusy('') } }
  async function saveScore() { setBusy('saveS'); try { await persist('scored'); note('评分已保存，状态 → 已评分') } catch (e) { fail(e) } finally { setBusy('') } }

  return (
    <div className="grid" style={{ gap: 16 }}>
      {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

      {/* ① 素材输入 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <b>① 素材输入</b>
          <button disabled={busy} onClick={saveMaterials}>{busy === 'saveM' ? '保存中…' : '保存素材'}</button>
        </div>
        <div className="row">
          <Field label="业务描述"><textarea rows={3} value={materials.description} onChange={mUpd('description')} placeholder="一句话/一段话说明这个业务场景" /></Field>
          <Field label="系统页面说明"><textarea rows={3} value={materials.systemNotes} onChange={mUpd('systemNotes')} placeholder="涉及哪些系统页面、入口怎么进" /></Field>
        </div>
        <div className="row">
          <Field label="访谈纪要"><textarea rows={4} value={materials.interview} onChange={mUpd('interview')} placeholder="粘贴客户访谈记录" /></Field>
          <Field label="SOP / 制度"><textarea rows={4} value={materials.sop} onChange={mUpd('sop')} placeholder="粘贴相关 SOP、操作规范" /></Field>
        </div>
        <FilesEditor files={materials.files || []} onChange={(files) => setMaterials({ ...materials, files })} />
      </div>

      {/* ② 场景要素抽取 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <b>② 场景要素抽取</b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy} onClick={onExtract}>{busy === 'extract' ? 'AI 抽取中…' : 'AI 抽取要素'}</button>
            {facts && <button disabled={busy} onClick={saveFacts}>{busy === 'saveF' ? '保存中…' : '保存要素'}</button>}
          </div>
        </div>
        {!facts ? <div className="hint">填好素材后点「AI 抽取要素」，系统会从材料中抽取业务目标、触发条件、角色、系统、规则、风险动作、人工确认点等结构化要素，供你核对修改。</div> : (
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {FACT_FIELDS.map(([k, label, rows]) => (
              <Field key={k} label={label}><textarea rows={rows} value={facts[k] || ''} onChange={fUpd(k)} /></Field>
            ))}
          </div>
        )}
      </div>

      {/* ③ 场景评分 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <b>③ 场景评分（是否适合 Agent 化）</b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy || !facts} onClick={onScore}>{busy === 'score' ? 'AI 评分中…' : 'AI 评分'}</button>
            {score && <button disabled={busy} onClick={saveScore}>{busy === 'saveS' ? '保存中…' : '保存评分'}</button>}
          </div>
        </div>
        {!score ? <div className="hint">完成要素抽取后可让 AI 按 8 个维度评分（高频/重复/规则清晰/系统可操作/数据可得/风险可控/留痕必要/复用潜力），并给出转化建议。分数可手动微调。</div> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span>总分 <b style={{ fontSize: 20 }}>{score.total ?? '—'}</b> / 40</span>
              {score.recommendation && <Tag kind={RECO[score.recommendation]?.tag}>{RECO[score.recommendation]?.label || score.recommendation}</Tag>}
              {score.reason && <span className="sec">{score.reason}</span>}
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 10 }}>
              {SCORE_DIMS.map(([k, label]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                  <span className="sec">{label}</span>
                  <select style={{ width: 56 }} value={score[k] ?? 3} onChange={e => { const v = Number(e.target.value); const ns = { ...score, [k]: v }; ns.total = SCORE_DIMS.reduce((a, [d]) => a + (Number(ns[d]) || 0), 0); setScore(ns) }}>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {facts && score && (
        <div className="hint">要素与评分就绪。下一步到「② 流程建模」把场景拆成可执行的流程节点。</div>
      )}
    </div>
  )
}

function FilesEditor({ files, onChange }) {
  const [name, setName] = useState('')
  return (
    <div>
      <label className="fl">附件清单（第一版登记文件名，后续接真实上传/解析）</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {files.map((f, i) => (
          <span key={i} className="tag">{f.name} <a style={{ cursor: 'pointer', color: '#dc2626' }} onClick={() => onChange(files.filter((_, j) => j !== i))}>×</a></span>
        ))}
        {files.length === 0 && <span className="sec" style={{ fontSize: 12 }}>暂无附件</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="如：客户拜访纪要.docx" onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { onChange([...files, { name: name.trim() }]); setName('') } }} />
        <button onClick={() => { if (name.trim()) { onChange([...files, { name: name.trim() }]); setName('') } }}>添加</button>
      </div>
    </div>
  )
}
