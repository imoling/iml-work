import { useEffect, useState } from 'react'
import { Server, Plus, BookOpen, PenLine } from 'lucide-react'
import { swallow } from '../../utils'

// MCP 连接器页：用户自行添加 MCP 服务器（本地 stdio / 远程 Streamable HTTP），
// 测试连接成功后其工具进入分身能力表。从 ConnectorsTab 拆出独立成页——
// 挤在 SaaS 目录下面时被 7 张卡推到滚动深处，用户根本看不见（实测反馈）。
// env/headers 属凭证：明文不出主进程，只有 hasEnv/hasHeaders 标记，留空提交 = 保持不变。
// 样式沿用 SettingsPanel 全局 <style>（svc-card / pill / bot-cfg-box 等）。

interface McpServerView {
  id: string; name: string; transport: 'stdio' | 'http'
  command: string; url: string; hasEnv: boolean; hasHeaders: boolean
  enabled: boolean; identity: string; verifiedAt: number
  tools: { name: string; readOnly: boolean; description: string }[]
}
interface McpDraft { name: string; transport: 'stdio' | 'http'; command: string; url: string; env: string; headers: string; enabled: boolean }
const EMPTY_DRAFT: McpDraft = { name: '', transport: 'stdio', command: '', url: '', env: '', headers: '', enabled: false }

export default function McpTab() {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [modal, setModal] = useState<'new' | string | null>(null)   // 'new'=添加；id=编辑
  const [draft, setDraft] = useState<McpDraft>({ ...EMPTY_DRAFT })
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = () => {
    window.api.invoke('mcp:list').then((r: any) => {
      if (r?.servers) setServers(r.servers)
    }).catch((e: any) => swallow(e, 'mcp:list'))
  }
  useEffect(reload, [])

  const openModal = (id: 'new' | string) => {
    if (id === 'new') setDraft({ ...EMPTY_DRAFT })
    else {
      const s = servers.find(x => x.id === id)
      // env/headers 从空开始（占位提示「已保存」；留空提交 = 保持不变）
      setDraft({ name: s?.name || '', transport: s?.transport || 'stdio', command: s?.command || '', url: s?.url || '', env: '', headers: '', enabled: !!s?.enabled })
    }
    setTest(null)
    setModal(id)
  }

  const patch = () => ({ ...(modal && modal !== 'new' ? { id: modal } : {}), ...draft })

  const doSave = async () => {
    setBusy(true)
    try {
      const r = await window.api.invoke('mcp:save', patch())
      if (r?.success) { reload(); setModal(null) }
      else setTest({ ok: false, msg: r?.error || '保存失败' })
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '保存失败' }) }
    setBusy(false)
  }

  const doTest = async () => {
    setBusy(true); setTest(null)
    try {
      const r = await window.api.invoke('mcp:test', patch())
      if (r?.success) setTest({ ok: true, msg: `连接成功：${r.identity || '服务器可用'}` })
      else setTest({ ok: false, msg: r?.error || '连接失败' })
      // 测试连接会先落盘（新增条目由此产生 id）——把弹窗切到该 id，避免再点一次生成重复条目
      if (r?.id && modal === 'new') setModal(r.id)
      reload()
    } catch (e: any) { setTest({ ok: false, msg: e?.message || '连接失败' }) }
    setBusy(false)
  }

  const doRemove = async () => {
    if (!modal || modal === 'new') return
    try { await window.api.invoke('mcp:remove', modal) } catch (e) { swallow(e, 'mcp:remove') }
    setModal(null); setTest(null)
    reload()
  }

  return (
    <>
      <div className="settings-tab-content wide">
        <h2 className="tab-title">MCP 连接器</h2>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          接入任意 MCP（Model Context Protocol）服务器，其工具自动进入分身能力表：本地进程（stdio）或远程服务（Streamable HTTP）。
          服务器自述「只读」的工具自动放行，<b>其余一律与写操作同样先弹确认卡</b>。凭证（环境变量/请求头）加密保存在本机，绝不上传。
          本地进程会真实在本机启动命令——<b>只添加你信任的服务器</b>。
        </p>

        {servers.length > 0 && (
          <div className="svc-grid">
            {servers.map(s => {
              let pillCls = 'pill-amber', pillTxt = '未验证'
              if (!s.enabled) { pillCls = 'pill-gray'; pillTxt = '未启用' }
              else if (s.tools.length) { pillCls = 'pill-mint'; pillTxt = `已连接 · ${s.tools.length} 个工具` }
              return (
                <div key={s.id} className="svc-card">
                  <div className="svc-head">
                    <div className="svc-ic" style={{ background: '#7C3AED' }}><Server size={17} color="#fff" /></div>
                    <div style={{ flex: 1 }}>
                      <div className="svc-name">{s.name}</div>
                      <div className="svc-type">{s.transport === 'stdio' ? '本地进程 · stdio' : '远程服务 · HTTP'}</div>
                    </div>
                    <span className={`pill ${pillCls}`}><span className="pill-dot" />{pillTxt}</span>
                  </div>
                  <div className="svc-meta" style={{ wordBreak: 'break-all' }}>{s.transport === 'stdio' ? s.command : s.url}</div>
                  {s.tools.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                      {s.tools.slice(0, 6).map(t => (
                        <span key={t.name} title={t.description || (t.readOnly ? '只读工具：自动放行' : '默认按写操作对待：执行前需人工确认')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                          {t.readOnly ? <BookOpen size={11} /> : <PenLine size={11} />}{t.name}
                        </span>
                      ))}
                      {s.tools.length > 6 && <span style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'center' }}>+{s.tools.length - 6}</span>}
                    </div>
                  )}
                  <div className="svc-actions">
                    <button className="btn-secondary" style={{ flex: 1 }} onClick={() => openModal(s.id)}>管理配置</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {servers.length === 0 && (
          <div style={{ border: '1px dashed var(--border-color)', borderRadius: 12, padding: '28px 20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12.5, maxWidth: 780 }}>
            还没有 MCP 服务器。点下方按钮添加第一个——例如官方示例：<code style={{ fontSize: 12 }}>npx -y @modelcontextprotocol/server-everything</code>
          </div>
        )}

        <button className="btn-secondary" style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }} onClick={() => openModal('new')}>
          <Plus size={14} />添加 MCP 服务器
        </button>
      </div>

      {/* MCP 服务器配置弹窗 */}
      {modal && (() => {
        const editing = modal !== 'new' ? servers.find(x => x.id === modal) : null
        return (
          <div className="wechat-qr-modal" onClick={() => setModal(null)}>
            <div className="bot-cfg-box" onClick={(e) => e.stopPropagation()}>
              <div className="bot-cfg-head">
                <div className="svc-ic" style={{ background: '#7C3AED', width: 34, height: 34 }}><Server size={17} color="#fff" /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{editing ? `${editing.name}（MCP）` : '添加 MCP 服务器'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>测试连接成功后，服务器的工具即出现在分身能力表</div>
                </div>
                <button className="bot-cfg-close" onClick={() => setModal(null)}>✕</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {editing?.identity && (
                  <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    上次验证：<span style={{ color: 'var(--mint-700)' }}>{editing.identity}</span>
                    {editing.verifiedAt ? `（${new Date(editing.verifiedAt).toLocaleString()}）` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12.5, fontWeight: 600 }}>名称</label>
                  <input className="settings-input" style={{ width: '100%', fontSize: 13 }} placeholder="如：文件系统 / 内部知识库"
                    value={draft.name} onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12.5, fontWeight: 600 }}>传输方式</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {([['stdio', '本地进程（stdio）'], ['http', '远程服务（HTTP）']] as const).map(([t, label]) => (
                      <label key={t} style={{
                        display: 'inline-flex', alignItems: 'center', padding: '6px 14px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
                        border: draft.transport === t ? '1.5px solid var(--mint-700)' : '1px solid var(--border-color)',
                        color: draft.transport === t ? 'var(--mint-700)' : 'var(--text-secondary)',
                        background: draft.transport === t ? 'var(--mint-50)' : 'var(--bg-surface)',
                      }}>
                        <input type="radio" style={{ display: 'none' }} checked={draft.transport === t}
                          onChange={() => setDraft(d => ({ ...d, transport: t }))} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                {draft.transport === 'stdio' ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600 }}>启动命令</label>
                      <input className="settings-input" style={{ width: '100%', fontSize: 13, fontFamily: 'monospace' }}
                        placeholder="npx -y @modelcontextprotocol/server-filesystem /path/to/dir"
                        value={draft.command} onChange={(e) => setDraft(d => ({ ...d, command: e.target.value }))} />
                      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>完整命令行（含参数）；测试连接会真实在本机启动该进程。</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600 }}>环境变量<span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>（可选）</span></label>
                      <textarea className="settings-input" rows={3} style={{ width: '100%', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}
                        placeholder={editing?.hasEnv ? '已保存（留空保持不变）' : 'KEY=VALUE，每行一条（API 密钥等凭证放这里）'}
                        value={draft.env} onChange={(e) => setDraft(d => ({ ...d, env: e.target.value }))} />
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600 }}>服务地址</label>
                      <input className="settings-input" style={{ width: '100%', fontSize: 13, fontFamily: 'monospace' }}
                        placeholder="https://mcp.example.com/mcp"
                        value={draft.url} onChange={(e) => setDraft(d => ({ ...d, url: e.target.value }))} />
                      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Streamable HTTP 端点（常见路径 /mcp）；旧式 /sse 双端点传输暂不支持。</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600 }}>请求头<span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>（可选）</span></label>
                      <textarea className="settings-input" rows={3} style={{ width: '100%', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}
                        placeholder={editing?.hasHeaders ? '已保存（留空保持不变）' : 'Authorization: Bearer xxx，每行一条'}
                        value={draft.headers} onChange={(e) => setDraft(d => ({ ...d, headers: e.target.value }))} />
                    </div>
                  </>
                )}
                {test && (
                  <div style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 8, color: test.ok ? 'var(--mint-700)' : 'var(--accent-red)', background: test.ok ? 'var(--mint-50)' : '#FEF2F2' }}>
                    {test.msg}
                  </div>
                )}
                {/* flexWrap：窄弹窗里勾选文案+三个按钮放不下时整体换行，而不是把按钮压成竖排 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft(d => ({ ...d, enabled: e.target.checked }))} />
                    启用（分身可在任务中调用）
                  </label>
                  <span style={{ flex: 1 }} />
                  {editing && <button className="btn-secondary" style={{ color: 'var(--accent-red)' }} onClick={doRemove} disabled={busy}>删除</button>}
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
