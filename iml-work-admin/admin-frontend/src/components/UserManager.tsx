import { useState, useEffect } from 'react'
import { UserPlus, Users, ShieldHalf, RefreshCw, Trash2, KeyRound, Pencil, Check, X, Inbox, ScrollText } from 'lucide-react'

interface Role { name: string; label: string; permissions: string[]; builtin: boolean }
interface AdminUser {
  id: string; username: string; displayName: string; department?: string; phone?: string
  enabled: boolean; roles: string[]; assignedExpertIds: string[]; allowAllExperts: boolean; mustChangePassword?: boolean
}
interface Expert { id: string; name: string }
interface Perm { key: string; label: string }
interface ResetReq { id: string; username: string; phone?: string; createdAt: string }
interface AuditRow { username: string; success: boolean; reason: string; clientType: string; ip: string; createdAt: string }

const emptyForm = { id: '', username: '', password: '', displayName: '', department: '', phone: '', roles: [] as string[], allowAllExperts: true, assignedExpertIds: [] as string[], enabled: true }

export default function UserManager() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [perms, setPerms] = useState<Perm[]>([])
  const [experts, setExperts] = useState<Expert[]>([])
  const [resetReqs, setResetReqs] = useState<ResetReq[]>([])
  const [audit, setAudit] = useState<{ recent: AuditRow[]; totalSuccess: number; totalFail: number }>({ recent: [], totalSuccess: 0, totalFail: 0 })
  const [tab, setTab] = useState<'users' | 'roles' | 'requests' | 'audit'>('users')

  // user modal
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })

  // role editor
  const [roleSel, setRoleSel] = useState<string>('')

  // 通用密码抽屉（重置密码 / 批准找回）
  const [pwdDrawer, setPwdDrawer] = useState<null | { title: string; hint?: string; allowEmpty?: boolean; confirmLabel?: string; onConfirm: (pwd: string) => Promise<void> }>(null)
  const [pwdValue, setPwdValue] = useState('')
  const [pwdBusy, setPwdBusy] = useState(false)

  const load = () => {
    fetch('/api/v1/users').then(r => r.ok && r.json()).then(d => d && setUsers(d)).catch(() => {})
    fetch('/api/v1/roles').then(r => r.ok && r.json()).then(d => d && setRoles(d)).catch(() => {})
    fetch('/api/v1/roles/permissions').then(r => r.ok && r.json()).then(d => d && setPerms(d)).catch(() => {})
    fetch('/api/v1/experts').then(r => r.ok && r.json()).then(d => Array.isArray(d) && setExperts(d.map((e: any) => ({ id: e.id, name: e.title || e.name || e.id })))).catch(() => {})
    fetch('/api/v1/users/reset-requests').then(r => r.ok && r.json()).then(d => Array.isArray(d) && setResetReqs(d)).catch(() => {})
    fetch('/api/v1/users/login-audit').then(r => r.ok && r.json()).then(d => d && setAudit(d)).catch(() => {})
  }
  useEffect(load, [])

  // 批准找回：请线下核验身份后，直接重置为默认密码 123456（用户下次登录强制改密）。
  const approveReset = async (req: ResetReq) => {
    if (!confirm(`批准「${req.username}」的找回申请，并把密码重置为默认密码 123456？\n请确保已线下核验其身份。用户下次登录需立即改密。`)) return
    const res = await fetch(`/api/v1/users/reset-requests/${req.id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    })
    const d = await res.json()
    if (res.ok && d.success) { alert(`已把「${d.username}」的密码重置为默认密码：${d.tempPassword}\n请转达用户，登录后需立即修改。`); load() }
    else alert(d.error || '失败')
  }
  const rejectReset = async (id: string) => {
    if (!confirm('驳回该找回申请？')) return
    const res = await fetch(`/api/v1/users/reset-requests/${id}/reject`, { method: 'POST' })
    if (res.ok) load()
  }

  const openCreate = () => { setForm({ ...emptyForm, password: '123456' }); setEditing(false); setShowForm(true) }
  const openEdit = (u: AdminUser) => {
    setForm({ id: u.id, username: u.username, password: '', displayName: u.displayName || '', department: u.department || '', phone: u.phone || '', roles: u.roles || [], allowAllExperts: u.allowAllExperts, assignedExpertIds: u.assignedExpertIds || [], enabled: u.enabled })
    setEditing(true); setShowForm(true)
  }

  const saveUser = async () => {
    const payload: any = { displayName: form.displayName, department: form.department, phone: form.phone, roles: form.roles, allowAllExperts: form.allowAllExperts, assignedExpertIds: form.assignedExpertIds, enabled: form.enabled }
    let res
    if (editing) {
      res = await fetch(`/api/v1/users/${form.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } else {
      res = await fetch('/api/v1/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, username: form.username, password: form.password }) })
    }
    const d = await res.json()
    if (res.ok && d.success) { setShowForm(false); load() } else alert(d.error || '保存失败')
  }

  const resetPwd = (u: AdminUser) => {
    setPwdValue('')
    setPwdDrawer({
      title: `重置密码 · ${u.displayName || u.username}`,
      hint: '设置新密码（≥6 位）；重置后用户下次登录需立即改密。',
      confirmLabel: '重置密码',
      onConfirm: async (pwd) => {
        if (pwd.length < 6) { alert('新密码至少 6 位'); return }
        const res = await fetch(`/api/v1/users/${u.id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) })
        const d = await res.json()
        if (res.ok && d.success) { setPwdDrawer(null); alert('已重置') } else alert(d.error || '失败')
      }
    })
  }

  const delUser = async (u: AdminUser) => {
    if (!confirm(`删除用户「${u.displayName || u.username}」？`)) return
    const res = await fetch(`/api/v1/users/${u.id}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  const toggleFormRole = (r: string) => setForm(f => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter(x => x !== r) : [...f.roles, r] }))
  const toggleAssigned = (id: string) => setForm(f => ({ ...f, assignedExpertIds: f.assignedExpertIds.includes(id) ? f.assignedExpertIds.filter(x => x !== id) : [...f.assignedExpertIds, id] }))

  // role permission editing
  const currentRole = roles.find(r => r.name === roleSel)
  const [roleDraft, setRoleDraft] = useState<string[]>([])
  useEffect(() => { setRoleDraft(currentRole ? [...currentRole.permissions] : []) }, [roleSel])
  const isSuper = roleDraft.includes('*')
  const toggleRolePerm = (p: string) => setRoleDraft(d => d.includes(p) ? d.filter(x => x !== p) : [...d, p])
  const saveRole = async () => {
    if (!currentRole) return
    const res = await fetch(`/api/v1/roles/${currentRole.name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: roleDraft }) })
    if (res.ok) load()
  }

  const roleLabel = (name: string) => roles.find(r => r.name === name)?.label || name

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={tab === 'users' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('users')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={14} />用户</button>
        <button className={tab === 'roles' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('roles')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ShieldHalf size={14} />角色与权限</button>
        <button className={tab === 'requests' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('requests')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Inbox size={14} />找回申请{resetReqs.length > 0 && <span className="badge badge-yellow">{resetReqs.length}</span>}</button>
        <button className={tab === 'audit' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('audit')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ScrollText size={14} />登录审计</button>
        <div style={{ flex: 1 }} />
        <button className="btn-secondary" onClick={load} style={{ padding: '4px 8px' }}><RefreshCw size={12} /></button>
      </div>

      {tab === 'users' && (
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>用户账户（{users.length}）</h3>
            <button className="btn-primary" onClick={openCreate} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><UserPlus size={14} />新建用户</button>
          </div>
          <table className="admin-table">
            <thead><tr><th>用户</th><th>部门</th><th>角色</th><th>可领岗位</th><th>状态</th><th style={{ width: 140 }}>操作</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td><div style={{ fontWeight: 600 }}>{u.displayName || u.username}</div><div style={{ fontSize: 9, color: 'var(--text-muted)' }}>@{u.username}</div></td>
                  <td>{u.department || '—'}</td>
                  <td>{(u.roles || []).map(r => <span key={r} className="badge badge-purple" style={{ marginRight: 4 }}>{roleLabel(r)}</span>)}</td>
                  <td>{u.allowAllExperts ? <span className="badge badge-green">全部</span> : <span className="badge badge-yellow">{(u.assignedExpertIds || []).length} 个</span>}</td>
                  <td>{u.enabled ? <span className="badge badge-green">启用</span> : <span className="badge badge-red">停用</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn-secondary" style={{ padding: '3px 6px' }} title="编辑" onClick={() => openEdit(u)}><Pencil size={12} /></button>
                      <button className="btn-secondary" style={{ padding: '3px 6px' }} title="重置密码" onClick={() => resetPwd(u)}><KeyRound size={12} /></button>
                      <button className="btn-danger" style={{ padding: '3px 6px' }} title="删除" onClick={() => delUser(u)}><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'roles' && (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>角色</h3>
            {roles.map(r => (
              <button key={r.name} className={`nav-item ${roleSel === r.name ? 'active' : ''}`} onClick={() => setRoleSel(r.name)} style={{ justifyContent: 'space-between' }}>
                <span>{r.label}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.permissions.includes('*') ? '全部' : r.permissions.length}</span>
              </button>
            ))}
          </div>
          <div className="glass-panel">
            {!currentRole ? <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 30 }}>选择左侧角色以编辑权限点</div> : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600 }}>{currentRole.label} {currentRole.builtin && <span className="badge badge-purple" style={{ marginLeft: 6 }}>内置</span>}</h3>
                  <button className="btn-primary" onClick={saveRole} disabled={isSuper} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Check size={14} />保存权限</button>
                </div>
                {isSuper ? <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>超级管理员拥有全部权限（不可编辑）。</div> : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                    {perms.map(p => (
                      <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 8px', border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={roleDraft.includes(p.key)} onChange={() => toggleRolePerm(p.key)} />
                        <span>{p.label}</span><span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{p.key}</span>
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'requests' && (
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>找回密码申请（{resetReqs.length}）</h3>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 0' }}>用户在登录页提交找回申请后出现在此。请**线下核验身份**后再批准重置（返回临时密码，用户下次登录需改密）。</p>
          </div>
          {resetReqs.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24, fontSize: 13 }}>暂无待处理的找回申请。</div>
          ) : (
            <table className="admin-table">
              <thead><tr><th>用户名</th><th>预留手机号</th><th>申请时间</th><th style={{ width: 150 }}>操作</th></tr></thead>
              <tbody>
                {resetReqs.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.username}</td>
                    <td>{r.phone || '—'}</td>
                    <td style={{ fontSize: 12 }}>{r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-primary" style={{ padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => approveReset(r)}><Check size={12} />批准重置</button>
                        <button className="btn-danger" style={{ padding: '3px 6px' }} onClick={() => rejectReset(r.id)}><X size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>登录审计（最近 100 条）</h3>
            <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
              <span className="badge badge-green">成功 {audit.totalSuccess}</span>
              <span className="badge badge-red">失败 {audit.totalFail}</span>
            </div>
          </div>
          <table className="admin-table">
            <thead><tr><th>时间</th><th>用户名</th><th>结果</th><th>说明</th><th>来源端</th><th>IP</th></tr></thead>
            <tbody>
              {audit.recent.map((a, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12 }}>{a.createdAt ? new Date(a.createdAt).toLocaleString() : '—'}</td>
                  <td style={{ fontWeight: 600 }}>{a.username}</td>
                  <td><span className={`badge ${a.success ? 'badge-green' : 'badge-red'}`}>{a.success ? '成功' : '失败'}</span></td>
                  <td style={{ fontSize: 12 }}>{a.reason}</td>
                  <td><span className="badge badge-purple">{a.clientType}</span></td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.ip}</td>
                </tr>
              ))}
              {audit.recent.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>暂无登录记录</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* user create/edit drawer（与其他模块一致，右侧抽屉）*/}
      {showForm && (
        <div className="skill-drawer-overlay" onClick={() => setShowForm(false)}>
          <div className="skill-drawer" style={{ width: 520 }} onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>{editing ? '编辑用户' : '新建用户'}</h3>
              <button className="btn-secondary" style={{ padding: '3px 6px' }} onClick={() => setShowForm(false)}><X size={14} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group"><label className="form-label">用户名</label><input className="form-input" value={form.username} disabled={editing} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></div>
              <div className="form-group"><label className="form-label">{editing ? '（改密请用“重置密码”）' : '初始密码（默认 123456 · 首次登录强制改密）'}</label><input className="form-input" type={editing ? 'password' : 'text'} value={form.password} disabled={editing} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder={editing ? '—' : '留空默认 123456'} /></div>
              <div className="form-group"><label className="form-label">姓名</label><input className="form-input" value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} /></div>
              <div className="form-group"><label className="form-label">部门</label><input className="form-input" value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} /></div>
              <div className="form-group"><label className="form-label">手机号</label><input className="form-input" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
              <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label className="form-label">状态</label><label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, height: 34 }}><input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />启用</label></div>
            </div>
            <div className="form-group">
              <label className="form-label">角色</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {roles.map(r => (
                  <label key={r.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', border: '1px solid var(--border-color)', borderRadius: 999, cursor: 'pointer', background: form.roles.includes(r.name) ? 'var(--mint-50, rgba(55,201,139,0.12))' : 'transparent' }}>
                    <input type="checkbox" checked={form.roles.includes(r.name)} onChange={() => toggleFormRole(r.name)} />{r.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                可领用岗位
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 400 }}>
                  <input type="checkbox" checked={form.allowAllExperts} onChange={e => setForm(f => ({ ...f, allowAllExperts: e.target.checked }))} />允许全部岗位
                </label>
              </label>
              {!form.allowAllExperts && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                  {experts.map(ex => (
                    <label key={ex.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer', background: form.assignedExpertIds.includes(ex.id) ? 'var(--mint-50, rgba(55,201,139,0.12))' : 'transparent' }}>
                      <input type="checkbox" checked={form.assignedExpertIds.includes(ex.id)} onChange={() => toggleAssigned(ex.id)} />{ex.name}
                    </label>
                  ))}
                  {experts.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>暂无岗位</span>}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-secondary" onClick={() => setShowForm(false)}>取消</button>
              <button className="btn-primary" onClick={saveUser}>{editing ? '保存' : '创建'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 密码抽屉（重置密码 / 批准找回）*/}
      {pwdDrawer && (
        <div className="skill-drawer-overlay" onClick={() => setPwdDrawer(null)}>
          <div className="skill-drawer" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>{pwdDrawer.title}</h3>
              <button className="btn-secondary" style={{ padding: '3px 6px' }} onClick={() => setPwdDrawer(null)}><X size={14} /></button>
            </div>
            {pwdDrawer.hint && <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{pwdDrawer.hint}</p>}
            <div className="form-group">
              <label className="form-label">{pwdDrawer.allowEmpty ? '临时密码（可留空自动生成）' : '新密码'}</label>
              <input className="form-input" type="text" value={pwdValue} autoFocus
                onChange={e => setPwdValue(e.target.value)}
                placeholder={pwdDrawer.allowEmpty ? '留空则自动生成' : '至少 6 位'}
                onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !pwdBusy) { e.preventDefault(); (async () => { setPwdBusy(true); await pwdDrawer.onConfirm(pwdValue.trim()); setPwdBusy(false) })() } }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-secondary" onClick={() => setPwdDrawer(null)}>取消</button>
              <button className="btn-primary" disabled={pwdBusy} onClick={async () => { setPwdBusy(true); await pwdDrawer.onConfirm(pwdValue.trim()); setPwdBusy(false) }}>
                {pwdBusy ? '处理中…' : (pwdDrawer.confirmLabel || '确定')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
