import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Admin, Connections, SkillCenter, Browser } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Tag, Pager } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

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
  const d = new Date(iso.replace(' ', 'T')); if (isNaN(d)) return iso.slice(0, 10)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const a = new Date(d); a.setHours(0, 0, 0, 0); const b = new Date(); b.setHours(0, 0, 0, 0)
  const diff = Math.round((b - a) / 86400000)
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

  // 登录保活心跳：定时静默访问已验证系统，刷新会话有效期 + 回写在线状态
  const [hb, setHb] = useState(() => (typeof localStorage !== 'undefined' ? localStorage.getItem('fde.hb') !== 'off' : true))
  const [hbBusy, setHbBusy] = useState(false)
  const [hbAt, setHbAt] = useState('')
  const dataRef = useRef(data); dataRef.current = data
  const toggleHb = () => setHb(v => { const n = !v; try { localStorage.setItem('fde.hb', n ? 'on' : 'off') } catch (_) {} return n })
  async function runHeartbeat() {
    if (!Browser.available() || hbBusy) return
    const d = dataRef.current; if (!d) return
    const targets = d.systems.map(s => ({ s, c: d.conns.find(c => c.systemId === s.id && c.ownerUserId === OWNER) }))
      .filter(x => x.c && x.c.status === 'verified' && x.s.baseUrl)
    if (!targets.length) return
    setHbBusy(true); let changed = false
    for (const { s, c } of targets) {
      try {
        const r = await Browser.ping({ systemId: s.id, baseUrl: s.baseUrl })
        if (!r || r.ok === false || r.skipped) continue
        await Connections.verifyResult(c.id, { ok: !!r.loggedIn, message: r.loggedIn ? '心跳保活：会话有效' : '心跳检测：登录会话已失效' })
        changed = true
      } catch (_) {}
    }
    const now = new Date()
    setHbAt(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
    setHbBusy(false)
    if (changed) reload()
  }
  useEffect(() => {
    if (!hb || !Browser.available()) return
    const t = setInterval(() => { runHeartbeat() }, HB_INTERVAL)
    return () => clearInterval(t)
  }, [hb]) // eslint-disable-line

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
        {Browser.available() && hb && <span className="sec" style={{ fontSize: 12, alignSelf: 'center' }}>{hbBusy ? '保活中…' : (hbAt ? `上次保活 ${hbAt}` : '保活已开启')}</span>}
        {Browser.available() && <button onClick={runHeartbeat} disabled={hbBusy} title="立即在本地已登录 Profile 中静默访问一次，刷新会话并检测在线">立即保活</button>}
        {Browser.available() && <button className={hb ? 'primary' : ''} onClick={toggleHb} title={`每 ${HB_INTERVAL / 60000} 分钟自动静默访问，刷新登录会话有效期、检测掉线`}>登录保活{hb ? '：开' : '：关'}</button>}
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
                {types.map(t => <option key={t} value={t}>{t}</option>)}
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
  async function delSkill(s) { if (confirm(`删除技能「${s.name}」？删除后客户端将无法再调用它。`)) { await SkillCenter.remove(s.id); reload() } }

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
              <button className="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={checkVerify}>{busy === 'c' ? '检测中…' : '我已登录，检测'}</button>
              <button disabled={busy} onClick={cancelVerify}>取消</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" disabled={busy} onClick={startVerify}>{busy === 'v' ? '打开中…' : (conn?.status === 'verified' ? '重新验证' : '本地登录验证')}</button>
              {conn?.status === 'verified' && <button disabled={busy} onClick={suspend}>停用</button>}
              {conn && <button className="danger" disabled={busy} onClick={revoke}>吊销</button>}
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

        {/* 连接器操作（关联「快速建技能」已上架的技能） */}
        <div className="card grid" style={{ gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="fl" style={{ margin: 0 }}>连接器操作（在「快速建技能」录制上架，供分身/SKILL 调用）</label>
            <button style={{ height: 28 }} disabled={conn?.status !== 'verified'} title={conn?.status !== 'verified' ? '请先完成本地登录验证' : ''} onClick={() => navigate('/quick')}>+ 新建操作</button>
          </div>
          {skills.length === 0
            ? <div className="sec" style={{ fontSize: 12 }}>{conn?.status === 'verified' ? '该系统还没有上架的操作。去「快速建技能」录制一条（如"新建拜访记录""查看待办"）。' : '连接验证通过后，去「快速建技能」录制并上架操作。'}</div>
            : skills.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                <Tag kind={s.skillKind === 'read' ? 'blue' : 'amber'}>{s.skillKind === 'read' ? '读取' : s.skillKind === 'write' ? '写入' : '操作'}</Tag>
                <b style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{s.name}</b>
                {s.navHash && <Tag kind="green">直达</Tag>}
                <span className="sec" style={{ fontSize: 12, marginLeft: 'auto' }}>{(s.triggerKeywords || []).slice(0, 2).join('、')}</span>
                <button style={{ height: 26 }} onClick={() => navigate('/quick?edit=' + s.id)}>编辑</button>
                <button className="ghost danger" style={{ height: 26 }} onClick={() => delSkill(s)}>删除</button>
              </div>
            ))}
        </div>

        {!Browser.available() && <div className="hint">当前为浏览器预览，登录验证/录制需在桌面端运行。</div>}
      </div>
    </>
  )
}
