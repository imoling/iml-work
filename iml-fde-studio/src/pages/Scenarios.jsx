import React, { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Scenarios, Projects } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Modal, Field, Tag } from '../components/ui.jsx'
import { SCENARIO_STATUS, FREQUENCY, RISK } from '../lib/constants.js'

const BLANK = { name: '', projectId: '', department: '', businessRole: '', description: '', frequency: 'daily' }

export default function ScenariosPage() {
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { data, loading, error, reload } = useAsync(() => Scenarios.list(), [])
  const [modal, setModal] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => { if (sp.get('new')) { setModal(true); sp.delete('new'); setSp(sp, { replace: true }) } }, []) // eslint-disable-line

  const rows = (data || []).filter(s => !filter || s.status === filter)
  return (
    <>
      <PageHeader title="场景库" desc="管理从客户业务中发现的可 Agent 化场景"
        actions={<button className="primary" onClick={() => setModal(true)}>+ 新建场景</button>} />
      <div className="content grid" style={{ gap: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="sec">状态筛选：</span>
          <select style={{ width: 180 }} value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(SCENARIO_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        {loading ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : (
          rows.length === 0 ? <div className="card"><div className="empty">还没有场景。新建场景后进入采集页，上传访谈纪要/SOP 让系统抽取要素。</div></div> : (
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead><tr><th>场景名称</th><th>部门</th><th>角色</th><th>频率</th><th>风险</th><th>复用</th><th>状态</th></tr></thead>
                <tbody>
                  {rows.map(s => {
                    const st = SCENARIO_STATUS[s.status] || {}
                    return (
                      <tr key={s.id} className="clickable" onClick={() => nav('/scenarios/' + s.id)}>
                        <td><b>{s.name}</b></td>
                        <td className="sec">{s.department || '—'}</td>
                        <td className="sec">{s.businessRole || '—'}</td>
                        <td className="sec">{FREQUENCY[s.frequency] || '—'}</td>
                        <td className="sec">{s.riskLevel ? RISK[s.riskLevel] : '—'}</td>
                        <td className="sec">{s.reusePotential ? RISK[s.reusePotential] : '—'}</td>
                        <td><Tag kind={st.tag}>{st.label || s.status}</Tag></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
      {modal && <CreateModal onClose={() => setModal(false)} onCreated={(s) => { setModal(false); nav('/scenarios/' + s.id) }} />}
    </>
  )
}

function CreateModal({ onClose, onCreated }) {
  const [f, setF] = useState(BLANK)
  const [projects, setProjects] = useState([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { Projects.list().then(ps => { setProjects(ps || []); if (ps && ps[0]) setF(v => ({ ...v, projectId: ps[0].id })) }).catch(() => {}) }, [])
  const upd = (k) => (e) => setF({ ...f, [k]: e.target.value })
  async function save() {
    if (!f.name.trim()) return setErr('请填写场景名称')
    if (!f.projectId) return setErr('请选择所属项目')
    setSaving(true); setErr('')
    try { const s = await Scenarios.create({ ...f, status: 'draft' }); onCreated(s) }
    catch (e) { setErr(e.message); setSaving(false) }
  }
  return (
    <Modal title="新建业务场景" onClose={onClose}>
      <Field label="所属项目 *">
        <select value={f.projectId} onChange={upd('projectId')}>
          <option value="">请选择…</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="场景名称 *"><input value={f.name} onChange={upd('name')} placeholder="如：销售 CRM 客户拜访记录整理" autoFocus /></Field>
      <div className="row">
        <Field label="所属部门"><input value={f.department} onChange={upd('department')} /></Field>
        <Field label="业务角色"><input value={f.businessRole} onChange={upd('businessRole')} placeholder="如：销售代表" /></Field>
      </div>
      <Field label="发生频率">
        <select value={f.frequency} onChange={upd('frequency')}>
          {Object.entries(FREQUENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="场景描述"><textarea rows={3} value={f.description} onChange={upd('description')} placeholder="一句话说明这个场景做什么" /></Field>
      {projects.length === 0 && <div className="hint">还没有项目，建议先到「项目总览」新建一个客户项目。</div>}
      {err && <div className="err">{err}</div>}
      <div className="actions">
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={saving} onClick={save}>{saving ? '创建中…' : '创建并进入采集'}</button>
      </div>
    </Modal>
  )
}
