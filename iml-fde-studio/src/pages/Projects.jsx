import React, { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Projects } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Modal, Field, Tag } from '../components/ui.jsx'
import { PROJECT_STAGE } from '../lib/constants.js'

const BLANK = { name: '', customerName: '', industry: '', pilotDepartment: '', owner: '', plannedLaunchDate: '' }

export default function ProjectsPage() {
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { data, loading, error, reload } = useAsync(() => Projects.list(), [])
  const [modal, setModal] = useState(false)

  useEffect(() => { if (sp.get('new')) { setModal(true); sp.delete('new'); setSp(sp, { replace: true }) } }, []) // eslint-disable-line

  return (
    <>
      <PageHeader title="项目总览" desc="以客户项目为单位管理 SKILL 生产进度"
        actions={<button className="primary" onClick={() => setModal(true)}>+ 新建项目</button>} />
      <div className="content">
        {loading ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : (
          (data || []).length === 0 ? <div className="card"><div className="empty">还没有项目。新建项目后即可在其下采集业务场景。</div></div> : (
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead><tr><th>项目名称</th><th>客户</th><th>行业</th><th>试点部门</th><th>负责人</th><th>阶段</th><th>计划上线</th></tr></thead>
                <tbody>
                  {data.map(p => (
                    <tr key={p.id} className="clickable" onClick={() => nav('/projects/' + p.id)}>
                      <td><b>{p.name}</b></td>
                      <td className="sec">{p.customerName || '—'}</td>
                      <td className="sec">{p.industry || '—'}</td>
                      <td className="sec">{p.pilotDepartment || '—'}</td>
                      <td className="sec">{p.owner || '—'}</td>
                      <td><Tag kind="blue">{PROJECT_STAGE[p.stage] || p.stage}</Tag></td>
                      <td className="sec">{p.plannedLaunchDate || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
      {modal && <CreateModal onClose={() => setModal(false)} onCreated={(p) => { setModal(false); nav('/projects/' + p.id) }} />}
    </>
  )
}

function CreateModal({ onClose, onCreated }) {
  const [f, setF] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const upd = (k) => (e) => setF({ ...f, [k]: e.target.value })
  async function save() {
    if (!f.name.trim()) return setErr('请填写项目名称')
    setSaving(true); setErr('')
    try { const p = await Projects.create({ ...f, stage: 'discovery' }); onCreated(p) }
    catch (e) { setErr(e.message); setSaving(false) }
  }
  return (
    <Modal title="新建客户项目" onClose={onClose}>
      <Field label="项目名称 *"><input value={f.name} onChange={upd('name')} placeholder="如：XX 集团销售数字化交付" autoFocus /></Field>
      <div className="row">
        <Field label="客户名称"><input value={f.customerName} onChange={upd('customerName')} /></Field>
        <Field label="行业"><input value={f.industry} onChange={upd('industry')} /></Field>
      </div>
      <div className="row">
        <Field label="试点部门"><input value={f.pilotDepartment} onChange={upd('pilotDepartment')} /></Field>
        <Field label="项目负责人"><input value={f.owner} onChange={upd('owner')} /></Field>
      </div>
      <Field label="计划上线时间"><input type="date" value={f.plannedLaunchDate} onChange={upd('plannedLaunchDate')} /></Field>
      {err && <div className="err">{err}</div>}
      <div className="actions">
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={saving} onClick={save}>{saving ? '创建中…' : '创建项目'}</button>
      </div>
    </Modal>
  )
}
