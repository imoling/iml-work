import React, { useEffect, useState } from 'react'
import { Github, GitBranch, ClipboardList, Webhook, Plug, BookOpen, PenLine } from 'lucide-react'
import { swallow } from '../../utils'

// 服务连接器页：第三方 SaaS/API 集成的配置与探活。
// 定位是**出站**——分身在任务中主动调用外部服务（查工单/建 Issue/推送）。
// IM 平台（飞书/钉钉/企业微信）的连接器在「IM 机器人」页与远程机器人合并成一张卡配置
//（本页按 IM_KEYS 隐藏它们，存储与工具门控不变）；MCP 服务器在「MCP 连接器」页。
// 目录与字段定义来自主进程 connector-defs.ts（经 connectors:list 下发，单一来源）；
// 密钥不出主进程——已保存的密钥字段只回「已保存」标记，留空提交 = 保持不变。
// 样式沿用 SettingsPanel 全局 <style>（svc-card / pill / bot-cfg-box 等）。

interface ConnectorField { key: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string; help?: string }
interface ConnectorDef {
  key: string; name: string; tag: string; desc: string; fields: ConnectorField[]
  brandColor: string; platformUrl?: string; platformName?: string; docUrl?: string; testNotice?: string
  tools: { name: string; label: string; op: 'read' | 'write' }[]
}
interface ConnectorStatus {
  enabled: boolean; configured: boolean; identity: string; verifiedAt: number
  values: Record<string, string>; savedSecrets: string[]
}

/** IM 平台连接器改在「IM 机器人」页配置（与远程机器人同卡），本页不再重复展示。 */
const IM_KEYS = ['feishu', 'dingtalk_bot', 'wecom_bot']

/** 图标按 key 映射（描述符是可序列化纯数据，不携带 React 节点）。 */
const ICONS: Record<string, React.ReactNode> = {
  github: <Github size={17} color="#fff" />,
  gitee: <GitBranch size={17} color="#fff" />,
  jira: <ClipboardList size={17} color="#fff" />,
  webhook: <Webhook size={17} color="#fff" />,
}

export default function ConnectorsTab() {
  const [defs, setDefs] = useState<ConnectorDef[]>([])
  const [status, setStatus] = useState<Record<string, ConnectorStatus | null>>({})
  const [modal, setModal] = useState<string | null>(null)          // 正在配置的连接器 key
  const [draft, setDraft] = useState<Record<string, string>>({})   // 表单草稿（密钥留空=保持不变）
  const [draftEnabled, setDraftEnabled] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})

  const reload = () => {
    window.api.invoke('connectors:list').then((r: any) => {
      if (r?.defs) { setDefs(r.defs.filter((d: ConnectorDef) => !IM_KEYS.includes(d.key))); setStatus(r.status || {}) }
    }).catch((e: any) => swallow(e, 'connectors:list'))
  }
  useEffect(reload, [])

  const openModal = (key: string) => {
    const st = status[key]
    setDraft({ ...(st?.values || {}) })   // 非密钥字段回填明文；密钥字段从空开始（占位提示已保存）
    setDraftEnabled(!!st?.enabled)
    setTest(null)
    setShowSecret({})
    setModal(key)
  }

  const doSave = async () => {
    if (!modal) return
    setBusy(true)
    try {
      const r = await window.api.invoke('connectors:save', modal, { enabled: draftEnabled, values: draft })
      if (r?.success) { reload(); setModal(null) }
      else setTest({ ok: false, msg: r?.error || '保存失败' })
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '保存失败' }) }
    setBusy(false)
  }

  const doTest = async () => {
    if (!modal) return
    setBusy(true); setTest(null)
    try {
      const r = await window.api.invoke('connectors:test', modal, { ...draft })
      if (r?.success) setTest({ ok: true, msg: `连接成功${r.identity ? `：${r.identity}` : ''}` })
      else setTest({ ok: false, msg: r?.error || '连接失败' })
      reload()
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '连接失败' }) }
    setBusy(false)
  }

  const doRemove = async () => {
    if (!modal) return
    try { await window.api.invoke('connectors:remove', modal) } catch (e) { swallow(e, 'connectors:remove') }
    setDraft({}); setDraftEnabled(false); setTest(null)
    reload()
  }

  return (
    <>
      <div className="settings-tab-content wide">
        <h2 className="tab-title">服务连接器</h2>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          连接 GitHub、Jira 等第三方服务后，工作分身即可在任务中<b>主动调用</b>它们（查工单、建 Issue、推送结果…）。
          查询类操作自动放行；<b>所有外发/写入操作都会先弹确认卡，人工签字后才执行</b>。凭证经系统钥匙串加密仅保存在本机，绝不上传。
          <br />IM 平台（飞书/钉钉/企业微信/QQ/微信）在「IM 机器人」页统一配置；MCP 服务器在「MCP 连接器」页接入。
        </p>

        <div className="svc-grid">
          {defs.map(def => {
            const st = status[def.key]
            let pillCls = 'pill-gray', pillTxt = '未配置'
            if (st?.enabled && st?.configured) { pillCls = 'pill-mint'; pillTxt = st.identity ? `已连接 · ${st.identity}` : '已连接' }
            else if (st?.configured) { pillCls = 'pill-amber'; pillTxt = '已配置·未启用' }
            return (
              <div key={def.key} className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic" style={{ background: def.brandColor }}>{ICONS[def.key] || <Plug size={17} color="#fff" />}</div>
                  <div style={{ flex: 1 }}>
                    <div className="svc-name">{def.name}</div>
                    <div className="svc-type">{def.tag}</div>
                  </div>
                  <span className={`pill ${pillCls}`}><span className="pill-dot" />{pillTxt}</span>
                </div>
                <div className="svc-meta">{def.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                  {def.tools.map(t => (
                    <span key={t.name} title={t.op === 'write' ? '写操作：执行前需人工确认' : '查询操作：自动放行'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                      {t.op === 'write' ? <PenLine size={11} /> : <BookOpen size={11} />}{t.label}
                    </span>
                  ))}
                </div>
                <div className="svc-actions">
                  <button className={st?.configured ? 'btn-secondary' : 'settings-btn'} style={{ flex: 1 }} onClick={() => openModal(def.key)}>
                    {st?.configured ? '管理配置' : '配置'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 连接器配置弹窗 */}
      {modal && (() => {
        const def = defs.find(d => d.key === modal)
        if (!def) return null
        const st = status[def.key]
        return (
          <div className="wechat-qr-modal" onClick={() => setModal(null)}>
            <div className="bot-cfg-box" onClick={(e) => e.stopPropagation()}>
              <div className="bot-cfg-head">
                <div className="svc-ic" style={{ background: def.brandColor, width: 34, height: 34 }}>{ICONS[def.key] || <Plug size={17} color="#fff" />}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{def.name}连接器</div>
                  {def.docUrl && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      配置说明：<a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', def.docUrl)}>{def.name}接入文档 ↗</a>
                    </div>
                  )}
                </div>
                <button className="bot-cfg-close" onClick={() => setModal(null)}>✕</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {st?.identity && (
                  <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    上次验证：<span style={{ color: 'var(--mint-700)' }}>{st.identity}</span>
                    {st.verifiedAt ? `（${new Date(st.verifiedAt).toLocaleString()}）` : ''}
                  </div>
                )}
                {def.fields.map(f => {
                  const savedMark = f.secret && (st?.savedSecrets || []).includes(f.key)
                  return (
                    <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600 }}>
                        {f.label}{f.optional ? <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>（可选）</span> : null}
                      </label>
                      <div style={{ position: 'relative' }}>
                        <input
                          className="settings-input"
                          style={{ width: '100%', fontSize: 13, paddingRight: f.secret ? 36 : undefined }}
                          type={f.secret && !showSecret[f.key] ? 'password' : 'text'}
                          placeholder={savedMark ? '已保存（留空保持不变）' : f.placeholder}
                          value={draft[f.key] || ''}
                          onChange={(e) => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                        />
                        {f.secret && (
                          <span onClick={() => setShowSecret(s => ({ ...s, [f.key]: !s[f.key] }))}
                            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12 }}>
                            {showSecret[f.key] ? '隐藏' : '显示'}
                          </span>
                        )}
                      </div>
                      {f.help && <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{f.help}</span>}
                    </div>
                  )
                })}
                {def.platformUrl && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    前往 <a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', def.platformUrl)}>{def.platformName} ↗</a> 获取凭证。
                  </div>
                )}
                {def.testNotice && (
                  <div style={{ fontSize: 11.5, color: '#B45309', background: '#FEF3E2', borderRadius: 8, padding: '7px 12px' }}>{def.testNotice}</div>
                )}
                {test && (
                  <div style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 8, color: test.ok ? 'var(--mint-700)' : 'var(--accent-red)', background: test.ok ? 'var(--mint-50)' : '#FEF2F2' }}>
                    {test.msg}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={draftEnabled} onChange={(e) => setDraftEnabled(e.target.checked)} />
                    启用（分身可在任务中调用）
                  </label>
                  <span style={{ flex: 1 }} />
                  <button className="btn-secondary" style={{ color: 'var(--accent-red)' }} onClick={doRemove} disabled={busy}>清空配置</button>
                  <button className="btn-secondary" onClick={doTest} disabled={busy}>{busy ? '连接中…' : '测试连接'}</button>
                  <button className="settings-btn" onClick={doSave} disabled={busy}>保存</button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}
