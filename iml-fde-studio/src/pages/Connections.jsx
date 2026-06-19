import React, { useState, useEffect } from 'react'
import { Admin, Connections, Browser } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Tag } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

const OWNER = 'fde-local', DEVICE = 'local-device'
const CAPS = [
  { k: 'read', label: '查询', risk: 'low' },
  { k: 'create', label: '新增', risk: 'medium' },
  { k: 'update', label: '修改', risk: 'medium' },
  { k: 'delete', label: '删除', risk: 'high' },
  { k: 'batch', label: '批量', risk: 'high' }
]
const STATUS = {
  draft: { label: '草稿', tag: 'gray' }, verifying: { label: '验证中', tag: 'amber' },
  verified: { label: '已验证', tag: 'green' }, expired: { label: '已过期', tag: 'amber' },
  failed: { label: '验证失败', tag: 'red' }, suspended: { label: '已停用', tag: 'gray' }, revoked: { label: '已吊销', tag: 'red' }
}

export default function ConnectionsPage() {
  const { data, loading, error, reload } = useAsync(async () => {
    const [systems, conns] = await Promise.all([Admin.integrations(), Connections.list()])
    return { systems: systems || [], conns: conns || [] }
  }, [])

  return (
    <>
      <PageHeader title="业务系统连接" desc="为无 API 的业务系统建立已验证的本地连接，供录制与执行引用（登录凭证只在本地，平台不存密码）" />
      <div className="content grid" style={{ gap: 16 }}>
        <div className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Icon name="shield" size={16} /> 登录在本地受管浏览器完成，Cookie/会话只保存在你电脑的独立 Profile；平台仅记录验证状态与能力，绝不上传账号密码。
        </div>
        {loading ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : (
          data.systems.length === 0
            ? <div className="card"><div className="empty">管理端还没有业务系统。请先在管理平台「业务系统连接」中登记系统（名称 + 地址）。</div></div>
            : data.systems.map(sys => (
              <SystemConn key={sys.id} sys={sys} conn={data.conns.find(c => c.systemId === sys.id && c.ownerUserId === OWNER)} reload={reload} />
            ))
        )}
      </div>
    </>
  )
}

function SystemConn({ sys, conn, reload }) {
  const [verifying, setVerifying] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))
  const st = STATUS[conn?.status] || STATUS.draft
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
      if (r && r.ok && r.loggedIn) {
        await Connections.verifyResult(c.id, { ok: true, message: '本地登录验证通过' })
        note('连接已验证！现在可用于录制与执行。')
      } else {
        await Connections.verifyResult(c.id, { ok: false, message: r?.error || '页面仍处于登录态，请确认已登录' })
        fail('未检测到已登录，请在浏览器中完成登录后重试')
      }
      await Browser.verifyClose(); setVerifying(false); await reload()
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function cancelVerify() { try { await Browser.verifyClose() } catch (_) {} setVerifying(false); reload() }

  async function toggleCap(k) {
    const c = await ensureConn()
    const cur = c.capabilities || []   // 用刚确保的连接真实能力，避免覆盖新建时的默认能力
    const next = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k]
    await Connections.update(c.id, { ...c, capabilities: next }); reload()
  }
  async function suspend() { if (conn) { setBusy('s'); await Connections.suspend(conn.id); await reload(); setBusy('') } }
  async function revoke() { if (conn && confirm('确认吊销该连接？吊销后需重新验证。')) { setBusy('r'); await Connections.revoke(conn.id); await reload(); setBusy('') } }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div className="stat-ic" style={{ width: 32, height: 32 }}><Icon name="link" size={16} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{sys.name} <span className="sec" style={{ fontWeight: 400, fontSize: 12 }}>· {sys.baseUrl}</span></div>
          <div className="sec" style={{ fontSize: 12 }}>{sys.type || '业务系统'}</div>
        </div>
        <Tag kind={st.tag}>{st.label}</Tag>
      </div>

      {(msg || err) && <div className={err ? 'err' : 'ok'} style={{ marginBottom: 10 }}>{err || msg}</div>}

      {/* CRUD 能力 */}
      <div style={{ marginBottom: 12 }}>
        <label className="fl">授予能力（增删改批量为高风险，运行时强制人工确认）</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {CAPS.map(c => (
            <button key={c.k} className={caps.includes(c.k) ? 'primary' : ''} style={{ height: 28 }} onClick={() => toggleCap(c.k)}>
              {c.label}{c.risk === 'high' ? ' ⚠' : ''}
            </button>
          ))}
        </div>
      </div>

      {/* 验证 */}
      {verifying ? (
        <div className="recbar" style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--mint-50)', border: '1px solid var(--mint-100)', borderRadius: 8, padding: '10px 12px' }}>
          <span style={{ color: 'var(--mint-700)' }}>● 验证浏览器已打开</span>
          <span className="sec">请在其中登录后点检测</span>
          <button className="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={checkVerify}>{busy === 'c' ? '检测中…' : '我已登录，检测'}</button>
          <button disabled={busy} onClick={cancelVerify}>取消</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" disabled={busy} onClick={startVerify}>{busy === 'v' ? '打开中…' : (conn?.status === 'verified' ? '重新验证' : '本地登录验证')}</button>
          {conn && conn.status === 'verified' && <button disabled={busy} onClick={suspend}>停用</button>}
          {conn && <button className="danger" disabled={busy} onClick={revoke}>吊销</button>}
          {conn?.lastVerifiedAt && <span className="sec" style={{ alignSelf: 'center', fontSize: 12 }}>最近验证：{conn.lastVerifiedAt.replace('T', ' ').slice(0, 19)}</span>}
        </div>
      )}
    </div>
  )
}
