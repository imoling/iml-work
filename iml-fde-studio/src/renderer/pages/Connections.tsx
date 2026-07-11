import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Admin, Connections, SkillCenter, Browser, ConnectorActions, modelChat } from '../services/api'
import { PageHeader, useAsync, Loading, ErrorBox, Tag, Pager } from '../components/ui'
import { subscribe as hbSubscribe, setEnabled as hbSetEnabled, runHeartbeat, getState as hbGetState } from '../lib/heartbeat'
import Icon from '../components/Icon'

const OWNER = 'fde-local', DEVICE = 'local-device'
const CAPS = [
  { k: 'read', label: '查询', risk: 'low' },
  { k: 'create', label: '新增', risk: 'low' },
  { k: 'update', label: '修改', risk: 'medium' },
  { k: 'delete', label: '删除', risk: 'high' },
  { k: 'batch', label: '批量', risk: 'high' }
]
const CAP_MAP = Object.fromEntries(CAPS.map(c => [c.k, c]))
// 连接状态：标签 + 圆点色 + 一句话副文案
const STATUS = {
  verified: { label: '已验证', tag: 'green', dot: '#16a34a', sub: '会话有效' },
  verifying: { label: '验证中', tag: 'amber', dot: '#d97706', sub: '验证进行中' },
  draft: { label: '待验证', tag: 'amber', dot: '#d97706', sub: '尚未建立登录会话' },
  expired: { label: '验证失效', tag: 'red', dot: '#dc2626', sub: '登录会话已过期' },
  failed: { label: '验证失败', tag: 'red', dot: '#dc2626', sub: '上次验证未通过' },
  suspended: { label: '已停用', tag: 'gray', dot: '#9ca3af', sub: '连接已停用' },
  revoked: { label: '已吊销', tag: 'red', dot: '#dc2626', sub: '连接已吊销' }
}
const HB_INTERVAL = 4 * 60 * 1000   // 登录保活心跳间隔
const stOf = (conn) => STATUS[conn?.status] || STATUS.draft
function host(u) { try { return new URL(u).host } catch (_) { return (u || '').replace(/^https?:\/\//, '').split('/')[0] } }
function relTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso.replace(' ', 'T')); if (isNaN(d.getTime())) return iso.slice(0, 10)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const a = new Date(d); a.setHours(0, 0, 0, 0); const b = new Date(); b.setHours(0, 0, 0, 0)
  const diff = Math.round((+b - +a) / 86400000)
  if (diff === 0) return '今天 ' + hm
  if (diff === 1) return '昨天 ' + hm
  return d.toISOString().slice(0, 10)
}
function typeIcon(t) { const s = (t || '').toLowerCase(); if (s.includes('mail') || s.includes('email')) return 'folder'; if (s.includes('crm') || s.includes('oa')) return 'briefcase'; return 'link' }
// 操作列按钮文案随状态变化（都打开详情抽屉）
function actionLabel(conn) {
  const s = conn?.status
  if (s === 'verified' || s === 'suspended' || s === 'revoked') return '查看详情'
  if (s === 'verifying') return '继续验证'
  if (s === 'expired' || s === 'failed') return '重新验证'
  return '开始验证'
}

export default function ConnectionsPage() {
  const navigate = useNavigate()
  const { data, loading, error, reload } = useAsync(async () => {
    const [systems, conns, skills] = await Promise.all([Admin.integrations(), Connections.list(), SkillCenter.list()])
    return { systems: systems || [], conns: conns || [], skills: skills || [] }
  }, [])
  const [banner, setBanner] = useState(true)
  const [query, setQuery] = useState('')
  const [typeF, setTypeF] = useState('')
  const [statusF, setStatusF] = useState('')
  const [detailId, setDetailId] = useState('')   // 打开详情抽屉的系统 id
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  useEffect(() => { setPage(1) }, [query, typeF, statusF, pageSize])

  // 登录保活心跳：复用全局 store（在 Layout 常驻运行）；本页只订阅状态 + 提供开关/立即保活
  const [hb, setHb] = useState(hbGetState())
  useEffect(() => hbSubscribe(setHb), [])
  // 每次心跳跑完（lastAt 变化）→ 刷新本页连接状态
  const lastHbRef = useRef('')
  useEffect(() => { if (hb.lastAt && hb.lastAt !== lastHbRef.current) { lastHbRef.current = hb.lastAt; reload() } }, [hb.lastAt]) // eslint-disable-line

  const systems = data?.systems || []
  const connOf = (sysId) => (data?.conns || []).find(c => c.systemId === sysId && c.ownerUserId === OWNER)
  const skillsOf = (sysId) => (data?.skills || []).filter(s => s.targetSystemId === sysId)
  const types = Array.from(new Set(systems.map(s => s.type).filter(Boolean)))

  const q = query.trim().toLowerCase()
  const rows = systems.filter(sys => {
    if (typeF && sys.type !== typeF) return false
    if (statusF && (connOf(sys.id)?.status || 'draft') !== statusF) return false
    if (q && !((sys.name || '') + ' ' + (sys.baseUrl || '')).toLowerCase().includes(q)) return false
    return true
  })
  const paged = rows.slice((page - 1) * pageSize, page * pageSize)
  const detailSys = systems.find(s => s.id === detailId)

  return (
    <>
      <PageHeader title="业务系统连接" desc="管理业务系统的登录验证、授权能力与可调用操作" actions={<>
        {Browser.available() && hb.enabled && <span className="sec" style={{ fontSize: 12, alignSelf: 'center' }}>{hb.busy ? '保活中…' : (hb.lastAt ? `在线 ${hb.online}/${hb.total} · ${hb.lastAt}` : '保活已开启')}</span>}
        {Browser.available() && <button onClick={runHeartbeat} disabled={hb.busy} title="立即在本地已登录 Profile 中静默访问一次，刷新会话并检测在线">立即保活</button>}
        {Browser.available() && <button className={hb.enabled ? 'primary' : ''} onClick={() => hbSetEnabled(!hb.enabled)} title={`每 ${HB_INTERVAL / 60000} 分钟自动静默访问，刷新登录会话有效期、检测掉线`}>登录保活{hb.enabled ? '：开' : '：关'}</button>}
        <button onClick={reload} disabled={loading} title="刷新"><Icon name="grid" size={14} /> 刷新</button>
      </>} />
      <div className="content grid" style={{ gap: 16 }}>
        {banner && (
          <div className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Icon name="shield" size={16} /><span style={{ flex: 1 }}>登录凭证仅保存在本地受管浏览器中，平台不存储账号密码。</span>
            <button className="ghost" style={{ height: 24, padding: '0 6px' }} onClick={() => setBanner(false)}>×</button>
          </div>
        )}

        {loading && !data ? <Loading /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : (
          <div className="card" style={{ padding: 0 }}>
            {/* 工具栏 */}
            <div className="conn-toolbar" style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索系统名称或地址" style={{ flex: 1, minWidth: 200 }} />
              <select value={typeF} onChange={e => setTypeF(e.target.value)} style={{ width: 130 }}>
                <option value="">全部类型</option>
                {types.map((t: any) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={statusF} onChange={e => setStatusF(e.target.value)} style={{ width: 130 }}>
                <option value="">全部状态</option>
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>

            {systems.length === 0
              ? <div className="empty" style={{ padding: 32 }}>管理端还没有业务系统。请先在管理平台「业务系统连接」中登记系统（名称 + 地址）。</div>
              : (<>
                {/* 表头 */}
                <div className="conn-head">
                  <div>业务系统</div><div>连接状态</div><div>授权能力</div><div>技能资产</div><div>最近验证</div><div style={{ textAlign: 'right' }}>操作</div>
                </div>
                {rows.length === 0
                  ? <div className="empty" style={{ padding: 28 }}>没有匹配的连接，换个搜索/筛选条件。</div>
                  : paged.map(sys => {
                    const conn = connOf(sys.id), st = stOf(conn), caps = conn?.capabilities || []
                    const ops = skillsOf(sys.id).length
                    return (
                      <div key={sys.id} className="conn-row">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                          <div className="conn-avatar"><Icon name={typeIcon(sys.type)} size={18} /></div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <b style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sys.name}</b>
                              {sys.type && <span className="tag gray" style={{ fontSize: 10 }}>{sys.type}</span>}
                            </div>
                            <div className="sec" style={{ fontSize: 12 }}>{host(sys.baseUrl)}</div>
                          </div>
                        </div>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="conn-dot" style={{ background: st.dot }} /><Tag kind={st.tag}>{st.label}</Tag></div>
                          <div className="sec" style={{ fontSize: 11.5, marginTop: 3 }}>{st.sub}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {caps.length === 0 ? <span className="sec" style={{ fontSize: 12 }}>—</span>
                            : caps.map(k => { const c = CAP_MAP[k]; if (!c) return null; const kind = conn?.status !== 'verified' ? 'gray' : (c.risk === 'high' ? 'red' : 'green'); return <Tag key={k} kind={kind}>{c.label}</Tag> })}
                        </div>
                        <div className="sec" style={{ fontSize: 13 }}>{ops} 个技能</div>
                        <div className="sec" style={{ fontSize: 13 }}>{relTime(conn?.lastVerifiedAt)}</div>
                        <div style={{ textAlign: 'right' }}>
                          <button className={conn?.status === 'verified' ? '' : 'primary'} style={{ height: 32 }} onClick={() => setDetailId(sys.id)}>{actionLabel(conn)}</button>
                        </div>
                      </div>
                    )
                  })}
                {rows.length > 0 && <Pager total={rows.length} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} unit="个连接" />}
              </>)}
          </div>
        )}
      </div>

      {/* 详情抽屉：能力授权 / 登录验证 / 连接器操作 */}
      {detailSys && <div className="qs-drawer-mask" onClick={() => setDetailId('')} />}
      <div className={'qs-drawer' + (detailSys ? ' open' : '')}>
        {detailSys && (
          <ConnDetail key={detailSys.id} sys={detailSys} conn={connOf(detailSys.id)} skills={skillsOf(detailSys.id)}
            onClose={() => setDetailId('')} reload={reload} navigate={navigate} />
        )}
      </div>
    </>
  )
}

function ConnDetail({ sys, conn, skills = [], onClose, reload, navigate }) {
  const [verifying, setVerifying] = useState(conn?.status === 'verifying')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  // 连接器动作（双形态执行器：录制回放 / API 接口）
  const [cacts, setCacts] = useState([])
  const loadCacts = async () => { try { setCacts(await ConnectorActions.list(sys.id) || []) } catch (_) { setCacts([]) } }
  useEffect(() => { loadCacts() }, [sys.id])
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))
  const st = stOf(conn)
  const caps = conn?.capabilities || ['read']

  async function ensureConn() {
    if (conn) return conn
    return Connections.create({ systemId: sys.id, ownerUserId: OWNER, deviceId: DEVICE, browserProfileRef: 'pwprofile-' + sys.id, capabilities: ['read', 'create'], status: 'draft', environment: 'production' })
  }
  async function startVerify() {
    if (!Browser.available()) return fail('本地验证需在桌面端运行')
    setBusy('v'); setErr('')
    try {
      const c = await ensureConn()
      await Connections.update(c.id, { ...c, status: 'verifying' })
      const r = await Browser.verifyStart({ systemId: sys.id, baseUrl: sys.baseUrl })
      if (!r || !r.ok) throw new Error((r && r.error) || '无法打开验证浏览器（需已装 Chrome）')
      setVerifying(true); note('已打开浏览器：请在其中登录目标系统，登录完成后点「我已登录，检测」')
      await reload()
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function checkVerify() {
    setBusy('c'); setErr('')
    try {
      const r = await Browser.verifyCheck()
      const c = await ensureConn()
      if (r && r.ok && r.loggedIn) { await Connections.verifyResult(c.id, { ok: true, message: '本地登录验证通过' }); note('连接已验证！现在可用于录制与执行。') }
      else { await Connections.verifyResult(c.id, { ok: false, message: r?.error || '页面仍处于登录态，请确认已登录' }); fail('未检测到已登录，请在浏览器中完成登录后重试') }
      await Browser.verifyClose(); setVerifying(false); await reload()
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function cancelVerify() { try { await Browser.verifyClose() } catch (_) {} setVerifying(false); reload() }
  async function toggleCap(k) {
    const c = await ensureConn()
    const cur = c.capabilities || []
    const next = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k]
    await Connections.update(c.id, { ...c, capabilities: next }); reload()
  }
  async function suspend() { if (conn) { setBusy('s'); await Connections.suspend(conn.id); await reload(); setBusy('') } }
  async function revoke() { if (conn && confirm('确认吊销该连接？吊销后需重新验证。')) { setBusy('r'); await Connections.revoke(conn.id); await reload(); setBusy('') } }
  async function setSkillStatus(s, status) {
    if (status === 'DISABLED' && !confirm(`下架「${s.name}」？下架后将脱离所有岗位绑定，客户端不再可调用。`)) return
    try { await SkillCenter.setStatus(s.id, status); note(`已${status === 'DISABLED' ? '下架' : '上架'}「${s.name}」`); reload() } catch (e) { fail(e) }
  }
  async function delSkill(s) {
    if ((s.status || 'PUBLISHED') === 'PUBLISHED') { return fail(`「${s.name}」已上架，请先「下架」再删除（下架会脱离岗位绑定）。`) }
    if (confirm(`删除技能「${s.name}」？此操作不可恢复。`)) { try { await SkillCenter.remove(s.id); reload() } catch (e) { fail(e) } }
  }

  return (
    <>
      <div className="qs-drawer-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="conn-avatar" style={{ width: 34, height: 34 }}><Icon name={typeIcon(sys.type)} size={16} /></div>
          <div>
            <b>{sys.name} {sys.type && <span className="tag gray" style={{ fontSize: 10 }}>{sys.type}</span>}</b>
            <div className="sec" style={{ fontSize: 12 }}>{host(sys.baseUrl)}</div>
          </div>
        </div>
        <button className="ghost" onClick={onClose} style={{ fontSize: 18, lineHeight: 1, padding: '2px 8px' }}>×</button>
      </div>
      <div className="qs-drawer-body">
        {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

        {/* 连接状态 + 验证 */}
        <div className="card grid" style={{ gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b>连接状态</b><span className="conn-dot" style={{ background: st.dot }} /><Tag kind={st.tag}>{st.label}</Tag>
            <span className="sec" style={{ fontSize: 12 }}>{st.sub}</span>
            {conn?.lastVerifiedAt && <span className="sec" style={{ fontSize: 12, marginLeft: 'auto' }}>最近验证：{relTime(conn.lastVerifiedAt)}</span>}
          </div>
          {verifying ? (
            <div className="recbar" style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--mint-50)', border: '1px solid var(--mint-100)', borderRadius: 8, padding: '10px 12px' }}>
              <span style={{ color: 'var(--mint-700)' }}>● 验证浏览器已打开</span><span className="sec">登录后点检测</span>
              <button className="primary" style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={checkVerify}>{busy === 'c' ? '检测中…' : '我已登录，检测'}</button>
              <button disabled={!!busy} onClick={cancelVerify}>取消</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" disabled={!!busy} onClick={startVerify}>{busy === 'v' ? '打开中…' : (conn?.status === 'verified' ? '重新验证' : '本地登录验证')}</button>
              {conn?.status === 'verified' && <button disabled={!!busy} onClick={suspend}>停用</button>}
              {conn && <button className="danger" disabled={!!busy} onClick={revoke}>吊销</button>}
            </div>
          )}
        </div>

        {/* 授权能力 */}
        <div className="card grid" style={{ gap: 8 }}>
          <label className="fl" style={{ margin: 0 }}>授权能力（增删改批量为高风险，运行时强制人工确认）</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {CAPS.map(c => (
              <button key={c.k} className={caps.includes(c.k) ? 'primary' : ''} style={{ height: 28 }} onClick={() => toggleCap(c.k)}>
                {c.label}{c.risk === 'high' ? ' ⚠' : ''}
              </button>
            ))}
          </div>
        </div>

        {/* 连接器操作 · 录制回放（关联「快速建技能」已上架的技能 + 录制形态连接器动作） */}
        <div className="card grid" style={{ gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="fl" style={{ margin: 0 }}>连接器操作 · 录制回放（录一遍最稳，供分身/SKILL 调用）</label>
            <button style={{ height: 28 }} disabled={conn?.status !== 'verified'} title={conn?.status !== 'verified' ? '请先完成本地登录验证' : ''} onClick={() => navigate('/quick')}>+ 录制操作</button>
          </div>
          <div className="sec" style={{ fontSize: 11.5, marginTop: -2 }}>无需录制？下方「免录制动作」可用 SOP 智能体 / API 直调 / AI 起草 直接建，新系统对接更快。</div>
          {skills.length === 0 && cacts.filter(a => !['api', 'sop'].includes(a.kind)).length === 0
            ? <div className="sec" style={{ fontSize: 12 }}>{conn?.status === 'verified' ? '该系统还没有录制类操作。可去「快速建技能」录一条（如"新建拜访记录""查看待办"），或用下方免录制方式建。' : '连接验证通过后，可录制操作，或用下方免录制方式建。'}</div>
            : skills.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                <Tag kind={s.skillKind === 'read' ? 'blue' : 'amber'}>{s.skillKind === 'read' ? '读取' : s.skillKind === 'write' ? '写入' : '操作'}</Tag>
                {(s.status || 'PUBLISHED') !== 'PUBLISHED' && <Tag kind="gray">{s.status === 'DRAFT' ? '草稿' : '已下架'}</Tag>}
                <b style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{s.name}</b>
                {s.navHash && <Tag kind="green">直达</Tag>}
                <span style={{ flex: 1 }} />
                {(s.status || 'PUBLISHED') === 'PUBLISHED'
                  ? <button style={{ height: 26 }} title="下架后脱离岗位绑定" onClick={() => setSkillStatus(s, 'DISABLED')}>下架</button>
                  : <button style={{ height: 26 }} onClick={() => setSkillStatus(s, 'PUBLISHED')}>上架</button>}
                <button style={{ height: 26 }} onClick={() => navigate('/quick?edit=' + s.id)}>编辑</button>
                <button className="ghost danger" style={{ height: 26 }} disabled={(s.status || 'PUBLISHED') === 'PUBLISHED'} title={(s.status || 'PUBLISHED') === 'PUBLISHED' ? '请先下架再删除' : '删除'} onClick={() => delSkill(s)}>删除</button>
              </div>
            ))}
          {/* 录制形态的连接器动作也属于「连接器操作」——嵌入本卡（步骤只读、入参/输出说明可补） */}
          <ConnectorActionsCard sys={sys} items={cacts} reload={loadCacts} note={note} fail={fail} kinds={['replay']} embedded />
        </div>

        {/* 免录制动作：SOP 智能体 / API 直调 / AI 起草——新系统快速对接的主路（无需逐个录制） */}
        <ConnectorActionsCard sys={sys} items={cacts} reload={loadCacts} note={note} fail={fail} kinds={['sop', 'api']} />

        {!Browser.available() && <div className="hint">当前为浏览器预览，登录验证/录制需在桌面端运行。</div>}
      </div>
    </>
  )
}

// ===== 连接器动作：查看/编辑三形态执行器 =====
// replay（录制）：嵌入上方「连接器操作·录制回放」卡（embedded），步骤只读、入参/输出可补；
// sop（SOP 智能体）：免录制——写一段标准流程 + 入口锚点，分身读实时页面逐步执行；
// api（接口）：HTTP 直调——方法/路径/请求体模板，支持 {{字段名}}、{{externalId}} 占位。
// 免录制卡还带「AI 起草」：贴系统操作说明→模型产出草稿(sop/api + 入参 + 触发词)，人工核对后保存。
const METHODS = ['GET', 'POST', 'PUT', 'DELETE']
const KIND_META = {
  replay: { tag: 'amber', label: '录制' },
  sop: { tag: 'green', label: 'SOP' },
  api: { tag: 'blue', label: 'API' }
}
function ConnectorActionsCard({ sys, items, reload, note, fail, kinds = ['api'], embedded = false }) {
  const [openId, setOpenId] = useState('')
  const [form, setForm] = useState(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [draftHint, setDraftHint] = useState('')   // AI 起草后展示的核对提示 + 建议触发词
  const allowsAI = kinds.includes('sop')            // 免录制卡才提供 AI 起草
  const kindOf = (a) => a.kind === 'api' ? 'api' : a.kind === 'sop' ? 'sop' : 'replay'
  const list = items.filter(a => kinds.includes(kindOf(a)))
  const stepsCount = (a) => { try { const s = JSON.parse(a.stepsJson || '[]'); return Array.isArray(s) ? s.length : 0 } catch (_) { return 0 } }
  const fieldsOf = (a) => { try { const f = JSON.parse(a.fieldsJson || '[]'); return Array.isArray(f) ? f : [] } catch (_) { return [] } }
  const edit = (a) => { setDraftHint(''); setOpenId(a.id); setForm({ ...a, kind: kindOf(a), fieldsJson: a.fieldsJson || '[]' }) }
  const blank = (kind) => ({ id: '', systemId: sys.id, name: '', actionKey: '', capability: kind === 'sop' ? 'create' : 'update', kind, apiMethod: 'POST', apiPath: '/', apiBodyTemplate: '', sopHint: '', entryHash: '', fieldsJson: '[]', outputDesc: '' })
  const newOf = (kind) => { setDraftHint(''); setAiOpen(false); setOpenId('new'); setForm(blank(kind)) }
  const close = () => { setOpenId(''); setForm(null); setDraftHint('') }
  const save = async () => {
    if (!form.name || !form.name.trim()) return fail('动作名称不能为空')
    try { const f = JSON.parse(form.fieldsJson || '[]'); if (!Array.isArray(f)) throw new Error() } catch (_) { return fail('输入参数必须是 JSON 数组，如 [{"name":"qty","label":"数量","type":"text"}]') }
    if (form.kind === 'api' && (!form.apiPath || !form.apiPath.trim())) return fail('API 形态必须填写路径')
    if (form.kind === 'sop' && (!form.sopHint || !form.sopHint.trim())) return fail('SOP 智能体形态必须填写标准流程描述')
    try {
      if (form.id) await ConnectorActions.update(form.id, form)
      else await ConnectorActions.create(form)
      note('已保存连接器动作'); close(); reload()
    } catch (e) { fail(e) }
  }
  const remove = async (a) => { if (!confirm(`删除连接器动作「${a.name}」？（已绑定该动作的本体动作将失效）`)) return; try { await ConnectorActions.remove(a.id); close(); reload() } catch (e) { fail(e) } }
  // ===== AI 起草：贴系统操作说明 → 模型产出连接器动作草稿（免逐个录制的对接提速核心）=====
  const aiDraft = async () => {
    if (!aiText.trim()) return fail('请先粘贴该系统的操作说明/步骤')
    setAiBusy(true); setDraftHint('')
    try {
      const sysCtx = `系统名称：${sys.name}；系统地址：${sys.baseUrl || '（未登记）'}；类型：${sys.type || '未知'}`
      const prompt = `你是企业系统对接助手。下面是某业务系统里一个操作的说明，请把它转成一个「连接器动作」草稿，供数字员工调用。\n${sysCtx}\n\n【操作说明】\n${aiText}\n\n规则：\n- 若说明里出现 HTTP 接口/API/URL 路径 → kind="api"，给 apiMethod、apiPath(相对系统地址)、apiBodyTemplate(可空，支持 {{字段}} 占位)；\n- 否则（页面点选/表单类）→ kind="sop"，给 sopHint(标准流程，每步一行、含关键按钮/字段名)、entryHash(入口页锚点如 #/travel/apply，不确定就留空)。\n- name：中文动作名。actionKey：英文机器键(如 travel.apply)。capability：read/create/update/delete/batch 之一。\n- fields：执行前需人工确认的输入参数数组，每项 {"name":"键","label":"中文名","type":"text|select|date|number","options":["仅select"]}；无则 []。\n- triggers：3-6 个用户可能说的触发短语。\n只输出严格 JSON，不要解释：{"name":"","actionKey":"","capability":"","kind":"sop","sopHint":"","entryHash":"","apiMethod":"POST","apiPath":"","apiBodyTemplate":"","fields":[],"triggers":[]}`
      const out = await modelChat(prompt)
      const s = (out || '').replace(/```json/g, '').replace(/```/g, '')
      const a = s.indexOf('{'), b = s.lastIndexOf('}')
      if (a < 0 || b <= a) throw new Error('模型未返回可解析的草稿，请补充操作说明后重试')
      const r = JSON.parse(s.slice(a, b + 1))
      const kind = r.kind === 'api' ? 'api' : 'sop'
      setOpenId('new')
      setForm({
        id: '', systemId: sys.id, name: r.name || '', actionKey: r.actionKey || '', capability: r.capability || (kind === 'sop' ? 'create' : 'update'), kind,
        apiMethod: r.apiMethod || 'POST', apiPath: r.apiPath || '/', apiBodyTemplate: r.apiBodyTemplate || '',
        sopHint: r.sopHint || '', entryHash: r.entryHash || '',
        fieldsJson: JSON.stringify(Array.isArray(r.fields) ? r.fields : [], null, 1), outputDesc: ''
      })
      const trig = Array.isArray(r.triggers) && r.triggers.length ? `　建议触发词：${r.triggers.join('、')}（可复制到绑定的本体动作）` : ''
      setDraftHint(`✨ AI 起草草稿，请核对每一项后再保存。${trig}`)
      setAiOpen(false); setAiText('')
    } catch (e) { fail(e.message || 'AI 起草失败') } finally { setAiBusy(false) }
  }
  const fi: any = { width: "100%", boxSizing: "border-box" }
  const renderEditor = () => form && (
    <div className="grid" style={{ gap: 8, padding: '0 10px 10px', borderTop: '1px solid var(--border)' }}>
      {draftHint && <div className="ok" style={{ marginTop: 8, fontSize: 12 }}>{draftHint}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: draftHint ? 0 : 8 }}>
        <div><label className="fl">名称</label><input style={fi} value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className="fl">动作键</label><input style={fi} value={form.actionKey || ''} onChange={e => setForm({ ...form, actionKey: e.target.value })} placeholder="如 wo.start" /></div>
        <div><label className="fl">能力</label><select style={fi} value={form.capability || 'read'} onChange={e => setForm({ ...form, capability: e.target.value })}>{CAPS.map(c => <option key={c.k} value={c.k}>{c.label}</option>)}</select></div>
      </div>
      <div><label className="fl">执行形态</label>
        <select style={fi} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
          <option value="replay">录制回放（无侵入 UI 操作，最稳）</option>
          <option value="sop">SOP 智能体（免录制，读页面执行）</option>
          <option value="api">API 接口（HTTP 直调）</option>
        </select></div>
      {form.kind === 'api' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
            <div><label className="fl">方法</label><select style={fi} value={form.apiMethod || 'POST'} onChange={e => setForm({ ...form, apiMethod: e.target.value })}>{METHODS.map(m => <option key={m}>{m}</option>)}</select></div>
            <div><label className="fl">路径（拼在系统地址后，支持 {'{{字段}}'}/{'{{externalId}}'} 占位）</label><input style={fi} value={form.apiPath || ''} onChange={e => setForm({ ...form, apiPath: e.target.value })} placeholder="/mes/order/{{externalId}}/start" /></div>
          </div>
          <div><label className="fl">请求体模板（JSON 或 k=v&k2=v2 表单串，支持 {'{{字段}}'} 占位；GET 可留空）</label>
            <textarea style={{ ...fi, minHeight: 56 }} value={form.apiBodyTemplate || ''} onChange={e => setForm({ ...form, apiBodyTemplate: e.target.value })} placeholder='line={{line}}&planStart={{planStart}}' /></div>
        </>
      ) : form.kind === 'sop' ? (
        <>
          <div><label className="fl">标准流程 SOP（每步一行，写清关键按钮/菜单/字段名；智能体照此读页面执行）</label>
            <textarea style={{ ...fi, minHeight: 92 }} value={form.sopHint || ''} onChange={e => setForm({ ...form, sopHint: e.target.value })} placeholder={'1. 左侧菜单进入「差旅管理」\n2. 点「新建申请」\n3. 填目的地、出差事由、预算\n4. 点「提交」'} /></div>
          <div><label className="fl">入口锚点（拼在系统地址后，如 #/travel/apply；留空则从首页起，由智能体自行导航）</label>
            <input style={fi} value={form.entryHash || ''} onChange={e => setForm({ ...form, entryHash: e.target.value })} placeholder="#/travel/apply（可留空）" /></div>
        </>
      ) : (
        <div><label className="fl">录制步骤（{stepsCount(form)} 步 · 由录制产出，只读）</label>
          <textarea style={{ ...fi, minHeight: 72, fontFamily: 'monospace', fontSize: 11 }} readOnly value={(() => { try { return JSON.stringify(JSON.parse(form.stepsJson || '[]'), null, 1) } catch (_) { return form.stepsJson || '[]' } })()} /></div>
      )}
      <div><label className="fl">输入参数（JSON 数组：name/label/type/options——执行前弹表单确认、人工签名的字段）</label>
        <textarea style={{ ...fi, minHeight: 56, fontFamily: 'monospace', fontSize: 11 }} value={form.fieldsJson} onChange={e => setForm({ ...form, fieldsJson: e.target.value })} placeholder='[{"name":"line","label":"产线","type":"select","options":["一号产线","二号产线"]}]' /></div>
      <div><label className="fl">输出说明（执行后的返回/影响，人工维护）</label>
        <textarea style={{ ...fi, minHeight: 44 }} value={form.outputDesc || ''} onChange={e => setForm({ ...form, outputDesc: e.target.value })} placeholder="如：工单状态置为已排产；返回 302 跳转工单详情页" /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" onClick={save}>保存</button>
        <button onClick={close}>取消</button>
      </div>
    </div>
  )
  const rowSummary = (a) => {
    const k = kindOf(a)
    if (k === 'api') return `${a.apiMethod || 'POST'} ${a.apiPath || ''}`
    if (k === 'sop') return `SOP · ${a.entryHash ? a.entryHash : '首页起'}`
    return `${stepsCount(a)} 步录制`
  }
  const rows = () => list.map(a => { const km = KIND_META[kindOf(a)]; return (
    <div key={a.id} style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
        <Tag kind={km.tag}>{km.label}</Tag>
        <b style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{a.name}</b>
        <span className="sec" style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {rowSummary(a)} · 入参 {fieldsOf(a).length}
        </span>
        <span style={{ flex: 1 }} />
        <button style={{ height: 26 }} onClick={() => openId === a.id ? close() : edit(a)}>{openId === a.id ? '收起' : '查看/编辑'}</button>
        <button className="ghost danger" style={{ height: 26 }} onClick={() => remove(a)}>删除</button>
      </div>
      {openId === a.id && renderEditor()}
    </div>
  ) })
  // 嵌入模式：录制形态并入上方「连接器操作」卡，只渲染行（无卡壳/无新建按钮）
  if (embedded) return <>{rows()}</>
  return (
    <div className="card grid" style={{ gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <label className="fl" style={{ margin: 0 }}>免录制动作 · SOP 智能体 / API 直调（新系统快速对接，无需逐个录制）</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ height: 28 }} onClick={() => newOf('sop')}>+ SOP 智能体</button>
          <button style={{ height: 28 }} onClick={() => newOf('api')}>+ API 接口</button>
          {allowsAI && <button className={aiOpen ? 'primary' : ''} style={{ height: 28 }} onClick={() => { setAiOpen(v => !v); setOpenId('') }}>✨ AI 起草</button>}
        </div>
      </div>
      {aiOpen && (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: 10, display: 'grid', gap: 8 }}>
          <div className="sec" style={{ fontSize: 12 }}>贴上该系统里一个操作的说明（操作手册片段、页面步骤、或接口文档），AI 起草成连接器动作草稿，你核对后保存——免逐个录制。</div>
          <textarea style={{ ...fi, minHeight: 90 }} value={aiText} onChange={e => setAiText(e.target.value)} placeholder={'例：在「差旅管理」里点新建申请，填目的地、出差事由、预算天数，提交后进入审批。\n或：POST /api/travel/apply，body 含 dest、reason、budget。'} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={aiBusy} onClick={aiDraft}>{aiBusy ? 'AI 起草中…' : '生成草稿'}</button>
            <button disabled={aiBusy} onClick={() => { setAiOpen(false); setAiText('') }}>取消</button>
          </div>
        </div>
      )}
      {list.length === 0 && openId !== 'new' && !aiOpen && <div className="sec" style={{ fontSize: 12 }}>暂无免录制动作。点「SOP 智能体」写段标准流程即可上线，或「AI 起草」让模型从操作说明生成草稿。</div>}
      {openId === 'new' && <div style={{ border: '1px dashed var(--border)', borderRadius: 8 }}>{renderEditor()}</div>}
      {rows()}
    </div>
  )
}
