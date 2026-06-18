import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Scenarios } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Tag } from '../components/ui.jsx'
import { SCENARIO_STATUS } from '../lib/constants.js'
import Collect from './stages/Collect.jsx'
import FlowModel from './stages/FlowModel.jsx'
import Blueprint from './stages/Blueprint.jsx'

// 场景工作区：一个场景从采集到交付的全流程，按阶段切换（文档 §6.1 主流程）
const STAGES = [
  { key: 'collect', label: '① 素材采集' },
  { key: 'model', label: '② 流程建模' },
  { key: 'blueprint', label: '③ SKILL 蓝图' },
  { key: 'orchestrate', label: '④ 执行编排' },
  { key: 'test', label: '⑤ 试运行' },
  { key: 'delivery', label: '⑥ 交付上架' }
]

export default function ScenarioWorkspace() {
  const { id, stage } = useParams()
  const nav = useNavigate()
  const cur = stage || 'collect'
  const { data, loading, error, reload } = useAsync(() => Scenarios.get(id), [id])

  if (loading) return <><PageHeader title="场景工作区" /><div className="content"><Loading /></div></>
  if (error) return <><PageHeader title="场景工作区" /><div className="content"><ErrorBox error={error} onRetry={reload} /></div></>
  const sc = data
  const st = SCENARIO_STATUS[sc.status] || {}

  return (
    <>
      <PageHeader
        title={sc.name}
        desc={`${sc.department || '—'} · ${sc.businessRole || '—'}`}
        crumb={<div className="crumb"><a onClick={() => nav('/scenarios')} style={{ color: 'var(--brand-d)', cursor: 'pointer' }}>场景库</a> ›</div>}
        actions={<Tag kind={st.tag}>{st.label || sc.status}</Tag>} />

      {/* 阶段步进条 */}
      <div style={{ display: 'flex', gap: 6, padding: '12px 22px', borderBottom: '1px solid var(--border)', background: '#fff', flexWrap: 'wrap' }}>
        {STAGES.map(s => (
          <button key={s.key} className={cur === s.key ? 'primary' : ''} onClick={() => nav(`/scenarios/${id}/${s.key}`)}>{s.label}</button>
        ))}
      </div>

      <div className="content">
        <StagePanel stage={cur} scenario={sc} reload={reload} />
      </div>
    </>
  )
}

function StagePanel({ stage, scenario, reload }) {
  if (stage === 'collect') return <Collect scenario={scenario} reload={reload} />
  if (stage === 'model') return <FlowModel scenario={scenario} reload={reload} />
  if (stage === 'blueprint') return <Blueprint scenario={scenario} reload={reload} />
  // P5-P6 将逐个替换为真实阶段组件
  const titles = { orchestrate: '执行编排（绑定执行器）', test: '试运行中心', delivery: '交付上架' }
  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{titles[stage] || stage}</div>
      <div className="hint">本阶段正在按需求文档分阶段实现中（P5–P6）。当前已实现：素材采集 + 流程建模 + SKILL 蓝图。</div>
    </div>
  )
}
