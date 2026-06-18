import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Projects, Scenarios } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Tag } from '../components/ui.jsx'
import { PROJECT_STAGE, SCENARIO_STATUS, FREQUENCY } from '../lib/constants.js'

export default function ProjectDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { data, loading, error, reload } = useAsync(async () => {
    const [project, scenarios] = await Promise.all([Projects.get(id), Scenarios.list(id)])
    return { project, scenarios: scenarios || [] }
  }, [id])

  if (loading) return <><PageHeader title="项目详情" /><div className="content"><Loading /></div></>
  if (error) return <><PageHeader title="项目详情" /><div className="content"><ErrorBox error={error} onRetry={reload} /></div></>
  const { project, scenarios } = data

  return (
    <>
      <PageHeader title={project.name} desc={`${project.customerName || '—'} · ${project.industry || '—'}`}
        crumb={<div className="crumb"><a onClick={() => nav('/projects')} style={{ color: 'var(--brand-d)', cursor: 'pointer' }}>项目总览</a> ›</div>}
        actions={<button className="primary" onClick={() => nav('/scenarios?new=1')}>+ 新建场景</button>} />
      <div className="content grid" style={{ gap: 16 }}>
        <div className="card">
          <div className="row">
            <Info l="试点部门" v={project.pilotDepartment} />
            <Info l="负责人" v={project.owner} />
            <Info l="阶段" v={PROJECT_STAGE[project.stage] || project.stage} />
            <Info l="计划上线" v={project.plannedLaunchDate} />
          </div>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ fontWeight: 700, padding: '14px 16px 0' }}>业务场景（{scenarios.length}）</div>
          {scenarios.length === 0 ? <div className="empty">该项目下还没有场景。</div> : (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>场景</th><th>部门</th><th>频率</th><th>状态</th></tr></thead>
              <tbody>
                {scenarios.map(s => (
                  <tr key={s.id} className="clickable" onClick={() => nav('/scenarios/' + s.id)}>
                    <td><b>{s.name}</b></td>
                    <td className="sec">{s.department || '—'}</td>
                    <td className="sec">{FREQUENCY[s.frequency] || '—'}</td>
                    <td><Tag kind={SCENARIO_STATUS[s.status]?.tag}>{SCENARIO_STATUS[s.status]?.label || s.status}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}

function Info({ l, v }) { return <div><div className="sec" style={{ fontSize: 12 }}>{l}</div><div style={{ marginTop: 4, fontWeight: 600 }}>{v || '—'}</div></div> }
