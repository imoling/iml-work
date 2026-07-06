import React, { useState } from 'react'
import { Send, MessageCircle, MessagesSquare, Info } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { swallow } from '../../utils'

// 远程执行通道页：IM 机器人（微信扫码占位 / 飞书 / 钉钉 / QQ 应用凭证）配置与
// 主进程长连接真实起停。凭证只存本地 SQLite 配置库，绝不上传。
// 样式沿用 SettingsPanel 的全局 <style>（svc-card / pill / wechat-qr-modal 等）。

interface BotField { key: string; label: string; secret?: boolean; placeholder?: string }
interface BotDef {
  key: 'wechat' | 'feishu' | 'dingtalk' | 'qq'
  name: string
  tag: string
  desc: string
  mode: 'qr' | 'form'
  brand: { bg: string; node: React.ReactNode }
  fields?: BotField[]
  platformUrl?: string
  platformName?: string
  docUrl?: string
}
const REMOTE_BOTS: BotDef[] = [
  {
    key: 'wechat', name: '微信机器人', tag: '扫码授权', mode: 'qr',
    desc: '扫码登录后可通过微信直接对话，随时随地远程向工作分身下达任务。',
    brand: { bg: '#07C160', node: <MessageCircle size={18} color="#fff" /> },
  },
  {
    key: 'feishu', name: '飞书机器人', tag: '应用凭证', mode: 'form',
    desc: '通过飞书机器人远程发起任务并接收执行链路日志回传。',
    brand: { bg: '#3370FF', node: <Send size={17} color="#fff" /> },
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxx' },
      { key: 'appSecret', label: 'App Secret', secret: true, placeholder: '输入 App Secret' },
    ],
    platformUrl: 'https://open.feishu.cn', platformName: '飞书开放平台',
    docUrl: 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process',
  },
  {
    key: 'dingtalk', name: '钉钉机器人', tag: '应用凭证', mode: 'form',
    desc: '通过钉钉机器人远程发起任务并接收执行链路日志回传。',
    brand: { bg: '#3296FA', node: <MessagesSquare size={17} color="#fff" /> },
    fields: [
      { key: 'clientId', label: 'Client ID (AppKey)', placeholder: '输入 Client ID' },
      { key: 'clientSecret', label: 'Client Secret (AppSecret)', secret: true, placeholder: '输入 Client Secret (AppSecret)' },
    ],
    platformUrl: 'https://open-dev.dingtalk.com', platformName: '钉钉开放平台',
    docUrl: 'https://open.dingtalk.com/document/orgapp/stream',
  },
  {
    key: 'qq', name: 'QQ 机器人', tag: '应用凭证', mode: 'form',
    desc: '通过 QQ 开放平台接收消息并远程发起任务，回传执行结果。',
    brand: { bg: '#12B7F5', node: <MessagesSquare size={17} color="#fff" /> },
    fields: [
      { key: 'appId', label: 'App ID', placeholder: '输入 App ID' },
      { key: 'appSecret', label: 'App Secret', secret: true, placeholder: '输入 App Secret' },
    ],
    platformUrl: 'https://q.qq.com', platformName: 'QQ 开放平台',
    docUrl: 'https://bot.q.qq.com/wiki/',
  },
]

type BotCfg = { enabled: boolean; values: Record<string, string> }

export default function RobotTab() {
  const [botCfg, setBotCfg] = useState<Record<string, BotCfg>>({})
  const [botModal, setBotModal] = useState<string | null>(null)   // 正在配置的机器人 key
  const [botDraft, setBotDraft] = useState<BotCfg>({ enabled: false, values: {} })
  const [botTest, setBotTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [botBusy, setBotBusy] = useState(false)
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [qrPayload, setQrPayload] = useState('')   // 微信扫码：一次性配对令牌（编码进真实二维码）
  // 主进程长连接的真实运行状态（飞书/钉钉/QQ）
  const [botStatus, setBotStatus] = useState<Record<string, { status: string; error?: string }>>({})

  React.useEffect(() => {
    window.api.invoke('db:config-get', 'remoteBots').then((raw: any) => {
      if (typeof raw === 'string' && raw) {
        try { setBotCfg(JSON.parse(raw) || {}) } catch (e) { swallow(e, 'parse remoteBots') }
      }
    }).catch(() => {})
  }, [])

  // 远程控制：拉取主进程长连接真实状态 + 订阅状态变化
  React.useEffect(() => {
    window.api.invoke('remote-bot:status').then((s: any) => { if (s) setBotStatus(s) }).catch(() => {})
    const un = window.api.on('remote-bot:status', (p: any) => {
      if (p && p.key) setBotStatus(prev => ({ ...prev, [p.key]: { status: p.status, error: p.error } }))
    })
    return () => { if (typeof un === 'function') un() }
  }, [])

  const botConfigured = (key: string): boolean => {
    const def = REMOTE_BOTS.find(b => b.key === key)!
    const c = botCfg[key]
    if (!c) return false
    if (def.mode === 'qr') return c.values?.bound === '1'
    return (def.fields || []).every(f => (c.values?.[f.key] || '').trim() !== '')
  }
  const persistBots = (next: Record<string, BotCfg>) => {
    setBotCfg(next)
    window.api.invoke('db:config-set', 'remoteBots', JSON.stringify(next)).catch(() => {})
  }
  const genQrPayload = () => {
    const rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    setQrPayload(`imlwork://pair?bot=wechat&token=${rnd}&ts=${Date.now()}`)
  }
  const openBot = (key: string) => {
    const c = botCfg[key] || { enabled: false, values: {} }
    setBotDraft({ enabled: c.enabled, values: { ...c.values } })
    setBotTest(null)
    if (REMOTE_BOTS.find(b => b.key === key)?.mode === 'qr') genQrPayload()
    setBotModal(key)
  }
  const saveBot = async () => {
    if (!botModal) return
    const key = botModal
    const def = REMOTE_BOTS.find(b => b.key === key)!
    const values = { ...botDraft.values }
    persistBots({ ...botCfg, [key]: { enabled: botDraft.enabled, values } })
    // 飞书/钉钉/QQ：按启用态在主进程真实起停长连接
    if (def.mode === 'form') {
      const complete = (def.fields || []).every(f => (values[f.key] || '').trim() !== '')
      setBotBusy(true)
      try {
        if (botDraft.enabled && complete) {
          const r = await window.api.invoke('remote-bot:start', key, values)
          if (r && !r.success) { setBotTest({ ok: false, msg: r.error || '启动失败' }); setBotBusy(false); return }
        } else {
          await window.api.invoke('remote-bot:stop', key)
        }
      } catch (e: any) { setBotTest({ ok: false, msg: e?.message || '启动失败' }); setBotBusy(false); return }
      setBotBusy(false)
    }
    setBotModal(null)
  }
  const clearBot = async () => {
    if (!botModal) return
    const key = botModal
    const next = { ...botCfg }; delete next[key]
    persistBots(next)
    try { await window.api.invoke('remote-bot:stop', key) } catch (e) { swallow(e, 'remote-bot:stop') }
    setBotDraft({ enabled: false, values: {} })
    setBotTest(null)
  }
  const testBot = async () => {
    if (!botModal) return
    const key = botModal
    const def = REMOTE_BOTS.find(b => b.key === key)!
    const missing = (def.fields || []).filter(f => (botDraft.values[f.key] || '').trim() === '')
    if (missing.length) { setBotTest({ ok: false, msg: `请先填写：${missing.map(m => m.label).join('、')}` }); return }
    setBotBusy(true); setBotTest(null)
    try {
      const r = await window.api.invoke('remote-bot:test', key, { ...botDraft.values })
      if (r && r.success) setBotTest({ ok: true, msg: r.message || '连接成功' })
      else setBotTest({ ok: false, msg: (r && r.error) || '连接失败' })
    } catch (e: any) { setBotTest({ ok: false, msg: e?.message || '连接失败' }) }
    setBotBusy(false)
  }
  const handleWeChatQrScan = () => {
    if (!botModal) return
    persistBots({ ...botCfg, [botModal]: { enabled: true, values: { bound: '1' } } })
    setBotModal(null)
  }

  return (
    <>
      <div className="settings-tab-content">
        <h2 className="tab-title">远程执行通道</h2>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          配置后可在外部 IM 工具中通过消息远程向工作分身下达任务，并接收执行结果回传。凭证仅保存在本机，绝不上传。
        </p>

        <div className="svc-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', maxWidth: 780 }}>
          {REMOTE_BOTS.map(bot => {
            const done = botConfigured(bot.key)
            const rt = botStatus[bot.key]?.status
            // 微信为本地扫码（无长连接）；其余以主进程真实长连接状态为准
            let pillCls = 'pill-gray', pillTxt = '未配置'
            if (bot.mode === 'qr') {
              if (done) { pillCls = 'pill-mint'; pillTxt = '已授权' }
            } else if (rt === 'running') { pillCls = 'pill-mint'; pillTxt = '运行中' }
            else if (rt === 'starting') { pillCls = 'pill-amber'; pillTxt = '连接中' }
            else if (rt === 'error') { pillCls = 'pill-red'; pillTxt = '连接失败' }
            else if (done) { pillCls = 'pill-amber'; pillTxt = '已配置·未启用' }
            return (
              <div key={bot.key} className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic" style={{ background: bot.brand.bg }}>{bot.brand.node}</div>
                  <div style={{ flex: 1 }}>
                    <div className="svc-name">{bot.name}</div>
                    <div className="svc-type">{bot.tag}</div>
                  </div>
                  <span className={`pill ${pillCls}`}>
                    <span className="pill-dot" />{pillTxt}
                  </span>
                </div>
                <div className="svc-meta">{bot.desc}</div>
                <div className="svc-actions">
                  <button className={done ? 'btn-secondary' : 'settings-btn'} style={{ flex: 1 }} onClick={() => openBot(bot.key)}>
                    {done ? '管理配置' : '配置'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 远程控制机器人配置弹窗 */}
      {botModal && (() => {
        const bot = REMOTE_BOTS.find(b => b.key === botModal)!
        const done = botConfigured(bot.key)
        return (
          <div className="wechat-qr-modal" onClick={() => setBotModal(null)}>
            <div className="bot-cfg-box" onClick={(e) => e.stopPropagation()}>
              <div className="bot-cfg-head">
                <div className="svc-ic" style={{ background: bot.brand.bg, width: 34, height: 34 }}>{bot.brand.node}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{bot.name}配置</div>
                  {bot.docUrl && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      配置教程请参考：<a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', bot.docUrl)}>{bot.name}配置教程 ↗</a>
                    </div>
                  )}
                </div>
                <button className="bot-cfg-close" onClick={() => setBotModal(null)}>✕</button>
              </div>

              {bot.mode === 'qr' ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '8px 0' }}>
                  <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center', margin: 0 }}>{bot.desc}</p>
                  <div style={{ fontSize: 11.5, color: '#B45309', background: '#FEF3E2', borderRadius: 8, padding: '7px 12px', textAlign: 'center' }}>
                    微信官方无个人号扫码 Bot 接口，此路径依赖非官方协议（有封号风险），暂未接入。当前为占位演示，真实绑定请优先使用飞书 / 钉钉 / QQ。
                  </div>
                  {done ? (
                    <>
                      <span className="pill pill-mint" style={{ fontSize: 13 }}><span className="pill-dot" />已扫码授权，微信可远程下达任务</span>
                      <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                        <button className="btn-secondary" style={{ flex: 1 }} onClick={handleWeChatQrScan}>重新扫码</button>
                        <button className="btn-secondary" style={{ flex: 1, color: 'var(--accent-red)' }} onClick={clearBot}>解除绑定</button>
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
                  <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    当前状态：{done ? <span style={{ color: 'var(--mint-700)' }}>凭证已保存</span> : '请先填写应用凭证'}
                  </div>
                  {(bot.fields || []).map(f => (
                    <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600 }}>{f.label}</label>
                      <div style={{ position: 'relative' }}>
                        <input
                          className="settings-input"
                          style={{ width: '100%', fontSize: 13, paddingRight: f.secret ? 36 : undefined }}
                          type={f.secret && !showSecret[f.key] ? 'password' : 'text'}
                          placeholder={f.placeholder}
                          value={botDraft.values[f.key] || ''}
                          onChange={(e) => setBotDraft(d => ({ ...d, values: { ...d.values, [f.key]: e.target.value } }))}
                        />
                        {f.secret && (
                          <span onClick={() => setShowSecret(s => ({ ...s, [f.key]: !s[f.key] }))}
                            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12 }}>
                            {showSecret[f.key] ? '隐藏' : '显示'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {bot.platformUrl && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      前往 <a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', bot.platformUrl)}>{bot.platformName} ↗</a> 获取应用凭证。
                    </div>
                  )}
                  {botTest && (
                    <div style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 8, color: botTest.ok ? 'var(--mint-700)' : 'var(--accent-red)', background: botTest.ok ? 'var(--mint-50)' : '#FEF2F2' }}>
                      {botTest.msg}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={botDraft.enabled} onChange={(e) => setBotDraft(d => ({ ...d, enabled: e.target.checked }))} />
                      启用{bot.name}
                    </label>
                    <span style={{ flex: 1 }} />
                    <button className="btn-secondary" style={{ color: 'var(--accent-red)' }} onClick={clearBot} disabled={botBusy}>清空配置</button>
                    <button className="btn-secondary" onClick={testBot} disabled={botBusy}>{botBusy ? '连接中…' : '测试连接'}</button>
                    <button className="settings-btn" onClick={saveBot} disabled={botBusy}>保存配置</button>
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
