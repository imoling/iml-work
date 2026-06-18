import React, { useState, useEffect } from 'react'
import { Scenarios, Blueprints, TestRuns, Deliveries, Templates, SkillCenter } from '../../services/api.js'
import { Tag } from '../../components/ui.jsx'
import { safeParse, SCENARIO_STATUS } from '../../lib/constants.js'

export default function Delivery({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const nodes = (init.flow && init.flow.nodes) || []
  const [blueprint, setBlueprint] = useState(null)
  const [runs, setRuns] = useState([])
  const [delivery, setDelivery] = useState(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))

  useEffect(() => {
    Blueprints.list(scenario.id).then(l => setBlueprint((l || [])[0] || null)).catch(() => {})
    TestRuns.list(scenario.id).then(l => setRuns(l || [])).catch(() => {})
    Deliveries.list(scenario.id).then(l => setDelivery((l || [])[0] || null)).catch(() => {})
  }, [scenario.id])

  const bp = blueprint ? { name: blueprint.name, markdownDraft: blueprint.markdownDraft, ...safeParse(blueprint.contentJson, {}) } : null
  const lastRun = runs[0]
  const browserNode = nodes.find(n => n.executorType === 'browser_automation' && (n.executor?.steps || []).length)
  const passed = ['test_passed', 'submitted', 'published', 'templated'].includes(scenario.status)

  function buildPackage() {
    return {
      scenario: { id: scenario.id, name: scenario.name, department: scenario.department },
      skillMarkdown: bp?.markdownDraft || '',
      metadata: { name: bp?.name, summary: bp?.summary, triggerKeywords: bp?.triggerKeywords, applicableRoles: bp?.applicableRoles, version: '1.0.0' },
      inputParams: bp?.inputParams || [],
      flowModel: { nodes },
      executorConfig: nodes.map(n => ({ node: n.title, type: n.executorType, hasSteps: (n.executor?.steps || []).length || 0 })),
      knowledgeDependencies: bp?.knowledgeDependencies || [],
      systemDependencies: bp?.systemDependencies || [],
      permissionSuggestions: bp?.permissionBoundaries || [],
      confirmationRules: bp?.confirmationRules || [],
      acceptanceCases: bp?.acceptanceCases || [],
      testRunIds: runs.map(r => r.id),
      lastTestStatus: lastRun?.status || 'none'
    }
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
  }

  async function genPackage() {
    if (!bp) return fail('请先在「③ SKILL 蓝图」生成蓝图')
    setBusy('gen'); setErr('')
    try {
      const pkg = buildPackage()
      const payload = { scenarioId: scenario.id, blueprintId: blueprint.id, status: 'ready', submitTarget: 'admin_skill_center', skillMarkdown: pkg.skillMarkdown, contentJson: JSON.stringify(pkg) }
      const d = delivery ? await Deliveries.update(delivery.id, { id: delivery.id, ...payload }) : await Deliveries.create(payload)
      setDelivery(d); note('交付包已生成')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function submit() {
    if (!bp) return fail('请先生成蓝图与交付包')
    setBusy('submit'); setErr('')
    try {
      // 映射为技能中心可消费的技能：浏览器节点的录制步骤 + SKILL.md 作为 SOP
      const steps = browserNode?.executor?.steps || []
      const fields = (bp.inputParams || []).map(p => ({ name: p.name, label: p.label, type: p.type }))
      const skillPayload = {
        name: bp.name || scenario.name,
        triggerKeywords: bp.triggerKeywords || [],
        targetSystemId: browserNode?.executor?.systemId || '',
        steps, fields, engine: 'browser', sop: bp.markdownDraft || ''
      }
      const res = await SkillCenter.fromRecording(skillPayload)
      const skillId = res?.id || res?.skill?.id || ''
      // 更新交付包 + 场景状态
      let d = delivery
      if (!d) { d = await Deliveries.create({ scenarioId: scenario.id, blueprintId: blueprint.id, status: 'ready', submitTarget: 'admin_skill_center', skillMarkdown: bp.markdownDraft || '', contentJson: JSON.stringify(buildPackage()) }) }
      // 发送完整对象（控制器 PUT 会覆盖缺失字段为 null）
      d = await Deliveries.update(d.id, { ...d, status: 'submitted', publishedSkillId: skillId })
      setDelivery(d)
      const cur = SCENARIO_STATUS[scenario.status]?.step ?? 0
      const status = (SCENARIO_STATUS.submitted.step > cur) ? 'submitted' : scenario.status
      await Scenarios.update(scenario.id, { ...scenario, status })
      await reload(); note('已提交到企业技能中心' + (skillId ? `（技能 ${skillId}）` : ''))
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function toTemplate() {
    setBusy('tpl'); setErr('')
    try {
      await Templates.create({
        name: (bp?.name || scenario.name) + ' · 模板', type: 'process', version: '1.0.0', sourceProjectId: scenario.projectId,
        contentJson: JSON.stringify({ flowNodes: nodes, executors: buildPackage().executorConfig, acceptanceCases: bp?.acceptanceCases || [], systems: bp?.systemDependencies || [] })
      })
      const cur = SCENARIO_STATUS[scenario.status]?.step ?? 0
      const status = (SCENARIO_STATUS.templated.step > cur) ? 'templated' : scenario.status
      await Scenarios.update(scenario.id, { ...scenario, status })
      await reload(); note('已沉淀为流程模板，可在「模板库」复用')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  if (!bp) return <div className="hint">请先完成「③ SKILL 蓝图」，再生成交付包。</div>

  return (
    <div className="grid" style={{ gap: 16 }}>
      {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}
      {!passed && <div className="hint">建议先在「⑤ 试运行」通过后再上架。当前仍可生成交付包预览。</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>交付包</b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy} onClick={genPackage}>{busy === 'gen' ? '生成中…' : '生成交付包'}</button>
            <button className="ghost" onClick={() => download((bp.name || 'SKILL') + '.md', bp.markdownDraft || '', 'text/markdown')}>下载 SKILL.md</button>
            <button className="ghost" onClick={() => download((bp.name || 'delivery') + '.json', JSON.stringify(buildPackage(), null, 2), 'application/json')}>下载交付包 JSON</button>
            <button className="primary" disabled={busy} onClick={submit}>{busy === 'submit' ? '提交中…' : '提交到企业技能中心'}</button>
          </div>
        </div>
        {delivery && (
          <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Tag kind={delivery.status === 'submitted' ? 'green' : 'blue'}>{delivery.status === 'submitted' ? '已提交' : '就绪'}</Tag>
            {delivery.publishedSkillId && <span className="sec">技能中心 ID：{delivery.publishedSkillId}</span>}
            {delivery.status === 'submitted' && <button className="ghost" disabled={busy} onClick={toTemplate}>{busy === 'tpl' ? '沉淀中…' : '沉淀为模板'}</button>}
          </div>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card">
          <b>交付物清单</b>
          <div className="grid" style={{ gap: 6, marginTop: 10, fontSize: 13 }}>
            <Item ok={!!bp.markdownDraft} label="SKILL.md 草案" />
            <Item ok={nodes.length > 0} label={`流程模型（${nodes.length} 节点）`} />
            <Item ok={nodes.some(n => n.executorType)} label="执行器配置" />
            <Item ok={(bp.systemDependencies || []).length > 0} label={`系统依赖（${(bp.systemDependencies || []).length}）`} />
            <Item ok={(bp.knowledgeDependencies || []).length > 0} label={`知识依赖（${(bp.knowledgeDependencies || []).length}）`} />
            <Item ok={(bp.acceptanceCases || []).length > 0} label={`验收用例（${(bp.acceptanceCases || []).length}）`} />
            <Item ok={!!browserNode} label={browserNode ? `浏览器录制（${browserNode.executor.steps.length} 步）` : '浏览器录制（未录制）'} />
            <Item ok={lastRun?.status === 'passed'} label={`最近试运行：${lastRun?.status || '未运行'}`} />
          </div>
        </div>
        <div className="card">
          <b>SKILL.md 预览</b>
          <pre style={{ marginTop: 10, maxHeight: 360, overflow: 'auto', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 12, borderRadius: 8 }}>{bp.markdownDraft}</pre>
        </div>
      </div>
    </div>
  )
}

function Item({ ok, label }) {
  return <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ color: ok ? 'var(--brand-d)' : 'var(--muted)' }}>{ok ? '✓' : '○'}</span><span className={ok ? '' : 'sec'}>{label}</span></div>
}
