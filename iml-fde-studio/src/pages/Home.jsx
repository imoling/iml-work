import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Projects, Scenarios } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Tag } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { SCENARIO_STATUS, PIPELINE } from '../lib/constants.js'

export default function Home() {
  const nav = useNavigate()
  const { data, loading, error, reload } = useAsync(async () => {
    const [projects, scenarios] = await Promise.all([Projects.list(), Scenarios.list()])
    return { projects: projects || [], scenarios: scenarios || [] }
  }, [])

  return (
    <>
      <PageHeader title="FDE 项目交付驾驶舱" desc="把客户业务场景转化为可运行、可测试、可上架、可复用的企业 SKILL 技能包"
        actions={<>
          <button className="primary" onClick={() => nav('/scenarios?new=1')}>+ 新建场景</button>
          <button onClick={() => nav('/projects?new=1')}>+ 新建项目</button>
        </>} />
      <div className="content grid" style={{ gap: 16 }}>
        {loading ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : <Dashboard {...data} nav={nav} />}
      </div>
    </>
  )
}

function Dashboard({ projects, scenarios, nav }) {
  const byStep = PIPELINE.map((_, i) => scenarios.filter(s => (SCENARIO_STATUS[s.status]?.step ?? 0) >= i).length)
  const passed = scenarios.filter(s => ['test_passed', 'submitted', 'published', 'templated'].includes(s.status)).length
  const published = scenarios.filter(s => ['published', 'templated'].includes(s.status)).length
  const blueprints = scenarios.filter(s => (SCENARIO_STATUS[s.status]?.step ?? 0) >= 3).length
  // 风险：缺素材/未建模/试运行失败
  const risks = scenarios.filter(s => ['draft', 'test_failed'].includes(s.status))

  return (
    <>
      <div className="stat-grid">
        <Stat ic="briefcase" n={projects.length} l="客户项目" />
        <Stat ic="layers" n={scenarios.length} l="业务场景" />
        <Stat ic="grid" n={blueprints} l="已生成蓝图" />
        <Stat ic="check" n={passed} l="试运行通过" />
        <Stat ic="upload" n={published} l="已上架" />
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 14 }}>场景转化漏斗</div>
        <div className="pipeline">
          {PIPELINE.map((label, i) => (
            <React.Fragment key={label}>
              {i > 0 && <span className="arr">›</span>}
              <span className="seg done" title={label}>{label} <b>{byStep[i]}</b></span>
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 700 }}>关键风险（{risks.length}）</div>
        </div>
        {risks.length === 0 ? <div className="sec">暂无阻塞风险。</div> : (
          <table>
            <thead><tr><th>场景</th><th>部门</th><th>状态</th><th>风险</th></tr></thead>
            <tbody>
              {risks.map(s => (
                <tr key={s.id} className="clickable" onClick={() => nav('/scenarios/' + s.id)}>
                  <td>{s.name}</td>
                  <td className="sec">{s.department || '—'}</td>
                  <td><Tag kind={SCENARIO_STATUS[s.status]?.tag}>{SCENARIO_STATUS[s.status]?.label || s.status}</Tag></td>
                  <td className="sec">{s.status === 'draft' ? '缺少素材采集' : '试运行失败，待修正'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 12 }}>最近项目</div>
        {projects.length === 0 ? <div className="sec">还没有项目，点右上角「新建项目」开始。</div> : (
          <table>
            <thead><tr><th>项目</th><th>客户</th><th>行业</th><th>负责人</th></tr></thead>
            <tbody>
              {projects.slice(0, 6).map(p => (
                <tr key={p.id} className="clickable" onClick={() => nav('/projects/' + p.id)}>
                  <td>{p.name}</td><td className="sec">{p.customerName || '—'}</td>
                  <td className="sec">{p.industry || '—'}</td><td className="sec">{p.owner || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function Stat({ ic, n, l }) {
  return (
    <div className="stat">
      <div className="stat-ic"><Icon name={ic} size={18} /></div>
      <div><div className="n">{n}</div><div className="l">{l}</div></div>
    </div>
  )
}
