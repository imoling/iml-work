import React, { useEffect, useState } from 'react'
import { Send, MessageCircle, MessagesSquare, Info } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { swallow } from '../../utils'

// IM 机器人页：**一个 IM 平台一张卡**，入站（在 IM 里远程给分身下任务的长连接机器人）
// 与出站（分身在任务中外发消息的连接器）在同一张卡里配置。
// 此前分居「远程执行通道」与「服务连接器」两页：飞书同一对凭证要填两遍、钉钉出现两次，
// 用户分不清是不是一回事（实测反馈），故合并成单一入口。
// 存储与主进程链路保持不动：入站走 remoteBots（remote-bot:* IPC 起停长连接）、
// 出站走 saasConnectors（connectors:* IPC，工具门控）——本页只是同一张表单写两处。
// 出站侧密钥不出主进程（掩码 + 留空保持不变）；入站侧沿用 remoteBots 既有明文回填行为。

interface Field { key: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string }
interface Platform {
  key: string
  name: string
  tag: string
  brand: { bg: string; node: React.ReactNode }
  desc: string
  /** 入站：remoteBots 配置键 + 长连接凭证字段（字段定义历来在渲染层，沿用）。 */
  inbound?: { botKey: string; fields: Field[] }
  /** 出站：saasConnectors 连接器 key。shared=true 复用入站同一组凭证（飞书）；
   *  字段与 testNotice 不在此重复定义——运行时从 connectors:list 下发的 defs 取（单一来源）。 */
  outbound?: { connectorKey: string; shared?: boolean }
  platformUrl?: string
  platformName?: string
  docUrl?: string
  /** 微信：扫码占位（无长连接、无凭证表单）。 */
  qr?: boolean
}

const PLATFORMS: Platform[] = [
  {
    key: 'feishu', name: '飞书', tag: '应用凭证 · 收发一体',
    brand: { bg: '#3370FF', node: <Send size={17} color="#fff" /> },
    desc: '同一个自建应用，凭证只填一遍：在飞书里远程给分身下任务；分身在任务中发消息、查所在群。',
    inbound: {
      botKey: 'feishu',
      fields: [
        { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxx' },
        { key: 'appSecret', label: 'App Secret', secret: true, placeholder: '输入 App Secret' },
      ],
    },
    outbound: { connectorKey: 'feishu', shared: true },
    platformUrl: 'https://open.feishu.cn', platformName: '飞书开放平台',
    docUrl: 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process',
  },
  {
    key: 'dingtalk', name: '钉钉', tag: '双通道',
    brand: { bg: '#3296FA', node: <MessagesSquare size={17} color="#fff" /> },
    desc: '远程下任务用应用凭证（Stream 长连接）；分身发群消息用群自定义机器人 Webhook。两套凭证独立，可只配其一。',
    inbound: {
      botKey: 'dingtalk',
      fields: [
        { key: 'clientId', label: 'Client ID (AppKey)', placeholder: '输入 Client ID' },
        { key: 'clientSecret', label: 'Client Secret (AppSecret)', secret: true, placeholder: '输入 Client Secret (AppSecret)' },
      ],
    },
    outbound: { connectorKey: 'dingtalk_bot' },
    platformUrl: 'https://open-dev.dingtalk.com', platformName: '钉钉开放平台',
    docUrl: 'https://open.dingtalk.com/document/orgapp/stream',
  },
  {
    key: 'wecom', name: '企业微信', tag: '群 Webhook',
    brand: { bg: '#07C160', node: <MessageCircle size={17} color="#fff" /> },
    desc: '分身向指定企业微信群发送消息（群设置 → 群机器人 → 添加）。',
    outbound: { connectorKey: 'wecom_bot' },
    docUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
  },
  {
    key: 'qq', name: 'QQ', tag: '应用凭证',
    brand: { bg: '#12B7F5', node: <MessagesSquare size={17} color="#fff" /> },
    desc: '通过 QQ 开放平台接收消息并远程发起任务，回传执行结果。',
    inbound: {
      botKey: 'qq',
      fields: [
        { key: 'appId', label: 'App ID', placeholder: '输入 App ID' },
        { key: 'appSecret', label: 'App Secret', secret: true, placeholder: '输入 App Secret' },
      ],
    },
    platformUrl: 'https://q.qq.com', platformName: 'QQ 开放平台', docUrl: 'https://bot.q.qq.com/wiki/',
  },
  {
    key: 'wechat', name: '微信', tag: '扫码授权', qr: true,
    brand: { bg: '#07C160', node: <MessageCircle size={18} color="#fff" /> },
    desc: '扫码登录后可通过微信直接对话，随时随地远程向工作分身下达任务。',
  },
]

type BotCfg = { enabled: boolean; values: Record<string, string> }

export default function ImTab() {
  const [botCfg, setBotCfg] = useState<Record<string, BotCfg>>({})
  const [botStatus, setBotStatus] = useState<Record<string, { status: string; error?: string }>>({})
  const [connStatus, setConnStatus] = useState<Record<string, any>>({})
  const [connDefs, setConnDefs] = useState<any[]>([])   // 出站字段/testNotice 的单一来源（connector-defs 下发）
  const [modal, setModal] = useState<string | null>(null)   // 正在配置的平台 key
  const [inDraft, setInDraft] = useState<Record<string, string>>({})
  const [outDraft, setOutDraft] = useState<Record<string, string>>({})
  const [inEnabled, setInEnabled] = useState(false)
  const [outEnabled, setOutEnabled] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [qrPayload, setQrPayload] = useState('')

  const reload = () => {
    window.api.invoke('db:config-get', 'remoteBots').then((raw: any) => {
      if (typeof raw === 'string' && raw) {
        try { setBotCfg(JSON.parse(raw) || {}) } catch (e) { swallow(e, 'parse remoteBots') }
      }
    }).catch((e: any) => swallow(e, 'remoteBots:get'))
    window.api.invoke('connectors:list').then((r: any) => {
      if (r?.status) setConnStatus(r.status)
      if (r?.defs) setConnDefs(r.defs)
    }).catch((e: any) => swallow(e, 'connectors:list'))
  }
  useEffect(reload, [])

  // 长连接真实运行状态：初始拉取 + 订阅主进程推送
  useEffect(() => {
    window.api.invoke('remote-bot:status').then((s: any) => { if (s) setBotStatus(s) }).catch(() => {})
    const un = window.api.on('remote-bot:status', (p: any) => {
      if (p && p.key) setBotStatus(prev => ({ ...prev, [p.key]: { status: p.status, error: p.error } }))
    })
    return () => { if (typeof un === 'function') un() }
  }, [])

  const persistBots = async (next: Record<string, BotCfg>) => {
    setBotCfg(next)
    await window.api.invoke('db:config-set', 'remoteBots', JSON.stringify(next)).catch((e: any) => swallow(e, 'remoteBots:set'))
  }
  const genQrPayload = () => {
    const rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    setQrPayload(`imlwork://pair?bot=wechat&token=${rnd}&ts=${Date.now()}`)
  }

  const openModal = (p: Platform) => {
    const bc = p.inbound ? botCfg[p.inbound.botKey] : null
    setInDraft({ ...(bc?.values || {}) })
    setInEnabled(!!bc?.enabled)
    const cs = p.outbound ? connStatus[p.outbound.connectorKey] : null
    setOutDraft({ ...(cs?.values || {}) })   // 非密钥字段明文回填；密钥字段从空开始（占位提示已保存）
    setOutEnabled(!!cs?.enabled)
    // 飞书共享凭证：入站没配而出站已配时，把非密钥的 appId 回填进共享表单
    if (p.outbound?.shared && !(bc?.values?.appId || '').trim() && (cs?.values?.appId || '').trim()) {
      setInDraft(d => ({ ...d, appId: cs.values.appId }))
    }
    setTest(null); setShowSecret({})
    if (p.qr) genQrPayload()
    setModal(p.key)
  }

  const doSave = async (p: Platform) => {
    setBusy(true); setTest(null)
    try {
      if (p.inbound) {
        const values = { ...inDraft }
        await persistBots({ ...botCfg, [p.inbound.botKey]: { enabled: inEnabled, values } })
        const complete = p.inbound.fields.every(f => f.optional || (values[f.key] || '').trim() !== '')
        if (inEnabled && complete) {
          const r = await window.api.invoke('remote-bot:start', p.inbound.botKey, values)
          if (r && !r.success) { setTest({ ok: false, msg: r.error || '长连接启动失败' }); setBusy(false); return }
        } else {
          await window.api.invoke('remote-bot:stop', p.inbound.botKey)
        }
      }
      if (p.outbound) {
        const values = p.outbound.shared ? { ...inDraft } : { ...outDraft }
        const r = await window.api.invoke('connectors:save', p.outbound.connectorKey, { enabled: outEnabled, values })
        if (r && !r.success) { setTest({ ok: false, msg: r.error || '保存失败' }); setBusy(false); return }
      }
      reload()
      setModal(null)
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '保存失败' }) }
    setBusy(false)
  }

  const doClear = async (p: Platform) => {
    setBusy(true)
    try {
      if (p.inbound || p.qr) {
        const botKey = p.inbound?.botKey || p.key
        const next = { ...botCfg }; delete next[botKey]
        await persistBots(next)
        try { await window.api.invoke('remote-bot:stop', botKey) } catch (e) { swallow(e, 'remote-bot:stop') }
      }
      if (p.outbound) {
        try { await window.api.invoke('connectors:remove', p.outbound.connectorKey) } catch (e) { swallow(e, 'connectors:remove') }
      }
      setInDraft({}); setOutDraft({}); setInEnabled(false); setOutEnabled(false); setTest(null)
      reload()
    } finally { setBusy(false) }
  }

  /** 入站测试：真实建一次长连接（成功即保持运行）。 */
  const doTestIn = async (p: Platform) => {
    if (!p.inbound) return
    const missing = p.inbound.fields.filter(f => !f.optional && (inDraft[f.key] || '').trim() === '')
    if (missing.length) { setTest({ ok: false, msg: `请先填写：${missing.map(m => m.label).join('、')}` }); return }
    setBusy(true); setTest(null)
    try {
      const r = await window.api.invoke('remote-bot:test', p.inbound.botKey, { ...inDraft })
      if (r && r.success) setTest({ ok: true, msg: r.message || '连接成功' })
      else setTest({ ok: false, msg: (r && r.error) || '连接失败' })
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '连接失败' }) }
    setBusy(false)
  }

  /** 出站测试：真调目标 API 探活（凭证与身份验证通过即落盘）。 */
  const doTestOut = async (p: Platform) => {
    if (!p.outbound) return
    setBusy(true); setTest(null)
    try {
      const values = p.outbound.shared ? { ...inDraft } : { ...outDraft }
      const r = await window.api.invoke('connectors:test', p.outbound.connectorKey, values)
      if (r?.success) setTest({ ok: true, msg: `连接成功${r.identity ? `：${r.identity}` : ''}` })
      else setTest({ ok: false, msg: r?.error || '连接失败' })
      reload()
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '连接失败' }) }
    setBusy(false)
  }

  const handleWeChatQrScan = async () => {
    if (!modal) return
    await persistBots({ ...botCfg, [modal]: { enabled: true, values: { bound: '1' } } })
    setModal(null)
  }

  // ── 卡片状态徽章 ─────────────────────────────────────────────────────────

  const inboundPill = (p: Platform): { cls: string; txt: string } | null => {
    if (p.qr) {
      return botCfg[p.key]?.values?.bound === '1'
        ? { cls: 'pill-mint', txt: '远程下任务 · 已授权' }
        : { cls: 'pill-gray', txt: '远程下任务 · 未绑定' }
    }
    if (!p.inbound) return null
    const c = botCfg[p.inbound.botKey]
    const configured = !!c && p.inbound.fields.every(f => f.optional || (c.values?.[f.key] || '').trim() !== '')
    const rt = botStatus[p.inbound.botKey]?.status
    if (rt === 'running') return { cls: 'pill-mint', txt: '远程下任务 · 运行中' }
    if (rt === 'starting') return { cls: 'pill-amber', txt: '远程下任务 · 连接中' }
    if (rt === 'error') return { cls: 'pill-red', txt: '远程下任务 · 连接失败' }
    if (configured) return { cls: 'pill-amber', txt: c!.enabled ? '远程下任务 · 未运行' : '远程下任务 · 未启用' }
    return { cls: 'pill-gray', txt: '远程下任务 · 未配置' }
  }

  const outboundPill = (p: Platform): { cls: string; txt: string } | null => {
    if (!p.outbound) return null
    const st = connStatus[p.outbound.connectorKey]
    if (st?.enabled && st?.configured) return { cls: 'pill-mint', txt: '分身外发 · 已启用' }
    if (st?.configured) return { cls: 'pill-amber', txt: '分身外发 · 未启用' }
    return { cls: 'pill-gray', txt: '分身外发 · 未配置' }
  }

  const renderFields = (fields: Field[], draft: Record<string, string>, setDraftFn: React.Dispatch<React.SetStateAction<Record<string, string>>>, savedSecrets: string[]) =>
    fields.map(f => {
      const savedMark = f.secret && savedSecrets.includes(f.key) && !(draft[f.key] || '')
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
              onChange={(e) => setDraftFn(d => ({ ...d, [f.key]: e.target.value }))}
            />
            {f.secret && (
              <span onClick={() => setShowSecret(s => ({ ...s, [f.key]: !s[f.key] }))}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12 }}>
                {showSecret[f.key] ? '隐藏' : '显示'}
              </span>
            )}
          </div>
        </div>
      )
    })

  const sectionTitle = (txt: string) => (
    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', paddingBottom: 6 }}>{txt}</div>
  )

  return (
    <>
      <div className="settings-tab-content wide">
        <h2 className="tab-title">IM 机器人</h2>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          每个平台一张卡，两种能力一处配置：<b>远程下任务</b>（在 IM 里发消息给分身、接收执行结果回传）与<b>分身外发</b>（分身在任务中主动发消息，执行前弹确认卡）。
          凭证仅保存在本机，绝不上传。
        </p>

        <div className="svc-grid">
          {PLATFORMS.map(p => {
            const pills = [inboundPill(p), outboundPill(p)].filter(Boolean) as { cls: string; txt: string }[]
            const configured = pills.some(x => x.cls !== 'pill-gray')
            return (
              <div key={p.key} className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic" style={{ background: p.brand.bg }}>{p.brand.node}</div>
                  <div style={{ flex: 1 }}>
                    <div className="svc-name">{p.name}</div>
                    <div className="svc-type">{p.tag}</div>
                  </div>
                </div>
                <div className="svc-meta">{p.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                  {pills.map(x => <span key={x.txt} className={`pill ${x.cls}`}><span className="pill-dot" />{x.txt}</span>)}
                </div>
                <div className="svc-actions">
                  <button className={configured ? 'btn-secondary' : 'settings-btn'} style={{ flex: 1 }} onClick={() => openModal(p)}>
                    {configured ? '管理配置' : '配置'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 平台配置弹窗 */}
      {modal && (() => {
        const p = PLATFORMS.find(x => x.key === modal)
        if (!p) return null
        const outDef = p.outbound ? connDefs.find((d: any) => d.key === p.outbound!.connectorKey) : null
        const outFields: Field[] = (outDef?.fields || []) as Field[]
        const outSaved: string[] = (p.outbound && connStatus[p.outbound.connectorKey]?.savedSecrets) || []
        const wechatBound = botCfg[p.key]?.values?.bound === '1'
        return (
          <div className="wechat-qr-modal" onClick={() => setModal(null)}>
            <div className="bot-cfg-box" onClick={(e) => e.stopPropagation()}>
              <div className="bot-cfg-head">
                <div className="svc-ic" style={{ background: p.brand.bg, width: 34, height: 34 }}>{p.brand.node}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{p.name}机器人</div>
                  {p.docUrl && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      配置说明：<a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', p.docUrl)}>{p.name}接入文档 ↗</a>
                    </div>
                  )}
                </div>
                <button className="bot-cfg-close" onClick={() => setModal(null)}>✕</button>
              </div>

              {p.qr ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '8px 0' }}>
                  <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center', margin: 0 }}>{p.desc}</p>
                  <div style={{ fontSize: 11.5, color: '#B45309', background: '#FEF3E2', borderRadius: 8, padding: '7px 12px', textAlign: 'center' }}>
                    微信官方无个人号扫码 Bot 接口，此路径依赖非官方协议（有封号风险），暂未接入。当前为占位演示，真实绑定请优先使用飞书 / 钉钉 / QQ。
                  </div>
                  {wechatBound ? (
                    <>
                      <span className="pill pill-mint" style={{ fontSize: 13 }}><span className="pill-dot" />已扫码授权，微信可远程下达任务</span>
                      <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                        <button className="btn-secondary" style={{ flex: 1 }} onClick={handleWeChatQrScan}>重新扫码</button>
                        <button className="btn-secondary" style={{ flex: 1, color: 'var(--accent-red)' }} onClick={() => doClear(p)}>解除绑定</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div onClick={handleWeChatQrScan} title="点击模拟扫码成功"
                        style={{ cursor: 'pointer', background: '#fff', padding: 14, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,.08)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <QRCodeSVG value={qrPayload || 'imlwork://pair'} size={168} level="M" fgColor="#111" bgColor="#fff" />
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>[ 点击模拟扫码 ]</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Info size={13} />扫码验证后的微信可以远程操控本机，请谨慎保管二维码
                      </div>
                      <button className="btn-secondary" onClick={genQrPayload}>刷新二维码</button>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* 凭证区：飞书收发共用一组；钉钉入站/出站各一组；企微仅出站；QQ 仅入站 */}
                  {p.inbound && (
                    <>
                      {p.outbound?.shared
                        ? sectionTitle('应用凭证（远程下任务与分身外发共用）')
                        : p.outbound ? sectionTitle('应用凭证 · 远程下任务') : null}
                      {renderFields(p.inbound.fields, inDraft, setInDraft, [])}
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={inEnabled} onChange={(e) => setInEnabled(e.target.checked)} />
                        启用远程下任务（保存后建立长连接）
                      </label>
                      {!p.outbound?.shared && p.outbound && (
                        <button className="btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => doTestIn(p)} disabled={busy}>
                          {busy ? '连接中…' : '测试长连接'}
                        </button>
                      )}
                    </>
                  )}
                  {p.outbound && !p.outbound.shared && (
                    <>
                      {p.inbound ? sectionTitle('群机器人 Webhook · 分身外发') : null}
                      {renderFields(outFields, outDraft, setOutDraft, outSaved)}
                    </>
                  )}
                  {p.outbound && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={outEnabled} onChange={(e) => setOutEnabled(e.target.checked)} />
                      启用分身外发（任务中可调用，执行前弹确认卡）
                    </label>
                  )}
                  {outDef?.testNotice && (
                    <div style={{ fontSize: 11.5, color: '#B45309', background: '#FEF3E2', borderRadius: 8, padding: '7px 12px' }}>{outDef.testNotice}</div>
                  )}
                  {p.platformUrl && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      前往 <a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', p.platformUrl)}>{p.platformName} ↗</a> 获取凭证。
                    </div>
                  )}
                  {test && (
                    <div style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 8, color: test.ok ? 'var(--mint-700)' : 'var(--accent-red)', background: test.ok ? 'var(--mint-50)' : '#FEF2F2' }}>
                      {test.msg}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                    <span style={{ flex: 1 }} />
                    <button className="btn-secondary" style={{ color: 'var(--accent-red)' }} onClick={() => doClear(p)} disabled={busy}>清空配置</button>
                    {/* 测试入口：飞书共用凭证走出站探活（只读、即时）；钉钉出站/入站各自有测试；QQ 走长连接测试 */}
                    {p.outbound
                      ? <button className="btn-secondary" onClick={() => doTestOut(p)} disabled={busy}>{busy ? '连接中…' : p.inbound && !p.outbound.shared ? '测试 Webhook' : '测试连接'}</button>
                      : <button className="btn-secondary" onClick={() => doTestIn(p)} disabled={busy}>{busy ? '连接中…' : '测试连接'}</button>}
                    <button className="settings-btn" onClick={() => doSave(p)} disabled={busy}>保存</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </>
  )
}
