import React, { useState, useEffect } from 'react'
import { Scenarios, Blueprints } from '../../services/api.js'
import { Field } from '../../components/ui.jsx'
import { safeParse, SCENARIO_STATUS } from '../../lib/constants.js'
import { generateBlueprint, blueprintToMarkdown } from '../../lib/ai.js'

export default function Blueprint({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const facts = init.facts, nodes = (init.flow && init.flow.nodes) || []
  const [bp, setBp] = useState(null)         // 蓝图结构
  const [md, setMd] = useState('')           // SKILL.md 草案
  const [existingId, setExistingId] = useState(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 2500) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))

  useEffect(() => {
    Blueprints.list(scenario.id).then(list => {
      const ex = (list || [])[0]
      if (ex) { setExistingId(ex.id); setMd(ex.markdownDraft || ''); setBp({ name: ex.name, ...safeParse(ex.contentJson, {}) }) }
    }).catch(() => {})
  }, [scenario.id])

  async function onGen() {
    if (!nodes.length) return fail('请先在「② 流程建模」生成并保存流程')
    setBusy('gen'); setErr('')
    try {
      const b = await generateBlueprint(scenario, facts, nodes)
      if (!b) throw new Error('AI 未返回有效蓝图')
      setBp(b); setMd(b.markdownDraft || ''); note('已生成蓝图与 SKILL.md 草案，可编辑')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function save() {
    if (!bp) return fail('请先生成蓝图')
    setBusy('save'); setErr('')
    try {
      const { name, markdownDraft, ...rest } = bp
      const payload = { scenarioId: scenario.id, name: name || scenario.name, version: '1.0.0', markdownDraft: md, contentJson: JSON.stringify(rest) }
      const saved = existingId ? await Blueprints.update(existingId, { id: existingId, ...payload }) : await Blueprints.create(payload)
      setExistingId(saved.id)
      const cur = SCENARIO_STATUS[scenario.status]?.step ?? 0
      const status = (SCENARIO_STATUS.blueprint_ready.step > cur) ? 'blueprint_ready' : scenario.status
      await Scenarios.update(scenario.id, { ...scenario, contentJson: JSON.stringify({ ...init, blueprintId: saved.id }), status })
      await reload(); note('蓝图已保存，状态 → 蓝图就绪')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  const setBpField = (k, v) => setBp({ ...bp, [k]: v })
  function regenMd() { if (bp) { const m = blueprintToMarkdown({ ...bp, markdownDraft: undefined }, scenario); setMd(m); note('已根据当前字段重生成 SKILL.md') } }

  return (
    <div className="grid" style={{ gap: 16 }}>
      {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}
      {!nodes.length && <div className="hint">建议先到「② 流程建模」生成并保存流程，AI 才能据此生成蓝图。</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>SKILL 蓝图</b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy} onClick={onGen}>{busy === 'gen' ? 'AI 生成中…' : 'AI 生成蓝图'}</button>
            <button disabled={busy || !bp} onClick={save}>{busy === 'save' ? '保存中…' : '保存蓝图'}</button>
          </div>
        </div>
      </div>

      {bp && (
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          <div className="card grid" style={{ gap: 4 }}>
            <Field label="技能名称"><input value={bp.name || ''} onChange={e => setBpField('name', e.target.value)} /></Field>
            <Field label="技能简介"><textarea rows={2} value={bp.summary || ''} onChange={e => setBpField('summary', e.target.value)} /></Field>
            <Field label="触发词（逗号分隔）"><input value={(bp.triggerKeywords || []).join('，')} onChange={e => setBpField('triggerKeywords', e.target.value.split(/[，,]/).map(s => s.trim()).filter(Boolean))} /></Field>
            <Field label="适用岗位（逗号分隔）"><input value={(bp.applicableRoles || []).join('，')} onChange={e => setBpField('applicableRoles', e.target.value.split(/[，,]/).map(s => s.trim()).filter(Boolean))} /></Field>
            <ListView label="输入参数" items={(bp.inputParams || []).map(p => `${p.label || p.name}（${p.type}${p.required ? '，必填' : ''}）`)} />
            <ListView label="系统依赖" items={bp.systemDependencies} />
            <ListView label="知识依赖" items={bp.knowledgeDependencies} />
            <ListView label="敏感动作" items={bp.sensitiveActions} />
            <ListView label="人工确认规则" items={bp.confirmationRules} />
            <ListView label="验收用例" items={(bp.acceptanceCases || []).map(c => c.title)} />
          </div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <b>SKILL.md 草案</b>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="ghost" onClick={regenMd}>按字段重生成</button>
                <button className="ghost" onClick={() => { navigator.clipboard?.writeText(md); note('已复制') }}>复制</button>
              </div>
            </div>
            <textarea rows={26} value={md} onChange={e => setMd(e.target.value)} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
          </div>
        </div>
      )}
    </div>
  )
}

function ListView({ label, items }) {
  const arr = items || []
  return (
    <div className="field">
      <label className="fl">{label}</label>
      {arr.length === 0 ? <span className="sec" style={{ fontSize: 12 }}>—</span> : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{arr.map((x, i) => <span key={i} className="tag">{x}</span>)}</div>
      )}
    </div>
  )
}
