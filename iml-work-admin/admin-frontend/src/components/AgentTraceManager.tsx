import { useState, useEffect } from 'react'
import {
  Fingerprint, RefreshCw, Search, Globe, Monitor, Cpu, ShieldAlert, X, Clock,
  Link as LinkIcon, Download, CheckCircle2, Box
} from 'lucide-react'

interface TraceRow {
  id: string; createdAt: string; userNickname: string; deviceHost: string; expertName: string
  modelName: string; modelProvider: string; question: string; durationMs: number; totalTokens: number
  webSearchUsed: boolean; sandboxUsed?: boolean; skillUsed: string; riskLevel: string; status: string; sensitiveHit: boolean; feedback?: string
}

const MODES = [{ k: 'LIGHT', label: '轻度' }, { k: 'STANDARD', label: '标准' }, { k: 'STRONG', label: '强' }]
const ROLES = [
  { k: 'admin', label: '普通管理员' }, { k: 'auditor', label: '安全审计员' },
  { k: 'sysadmin', label: '系统管理员' }, { k: 'super', label: '超级管理员' }, { k: 'external', label: '外部审计' }
]
const TABS = [
  { k: 'overview', label: '会话概览' }, { k: 'timeline', label: '执行时间线' },
  { k: 'sources', label: '证据与来源' }, { k: 'audit', label: '安全审计' }, { k: 'desensitize', label: '一键脱敏' }
]

const riskBadge = (r: string) => r === 'HIGH' ? <span className="badge badge-red">高危</span>
  : r === 'MEDIUM' ? <span className="badge badge-yellow">中</span> : <span className="badge badge-green">低</span>
const statusBadge = (s: string) => s === 'SUCCESS' ? <span className="badge badge-green">成功</span>
  : s === 'BLOCKED' ? <span className="badge badge-yellow">已拦截</span> : <span className="badge badge-red">失败</span>
const parse = (s: any) => { try { return JSON.parse(s || '[]') } catch { return [] } }

export default function AgentTraceManager() {
  const [rows, setRows] = useState<TraceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState(''); const [fRisk, setFRisk] = useState('全部'); const [fWeb, setFWeb] = useState('全部')

  const [detail, setDetail] = useState<any>(null)
  const [mode, setMode] = useState('STANDARD'); const [role, setRole] = useState('auditor')
  const [tab, setTab] = useState('overview')

  const fetchRows = async () => {
    setLoading(true)
    try { const r = await fetch('/api/v1/traces'); if (r.ok) setRows(await r.json()) } catch (e) { console.error(e) }
    setLoading(false)
  }
  useEffect(() => { fetchRows() }, [])

  const openDetail = async (id: string, m = mode, rl = role) => {
    const r = await fetch(`/api/v1/traces/${id}?mode=${m}&role=${rl}`)
    if (r.ok) { setDetail(await r.json()); setTab('overview') }
  }
  // 切换脱敏模式/角色时重新拉取（后端按角色+模式返回不同版本）
  const reload = async (m: string, rl: string) => { setMode(m); setRole(rl); if (detail) { const r = await fetch(`/api/v1/traces/${detail.id}?mode=${m}&role=${rl}`); if (r.ok) setDetail(await r.json()) } }

  const exportReport = async () => {
    const res = await fetch(`/api/v1/traces/${detail.id}/desensitize-audit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, role, operator: '管理员', hitRules: (detail.hits || []).map((h: any) => h.rule).join(','), hitCount: detail.hitTotal, exported: true })
    })
    if (res.ok) { const a = await res.json(); alert(`已生成脱敏报告并留痕。\n导出编号：${a.exportNo}\n模式：${mode} · 角色：${role} · 命中 ${detail.hitTotal} 处`) }
  }

  const visible = rows.filter(r => {
    if (fRisk !== '全部' && r.riskLevel !== fRisk) return false
    if (fWeb !== '全部' && String(r.webSearchUsed) !== fWeb) return false
    if (q.trim() && !`${r.question} ${r.userNickname} ${r.expertName} ${r.modelName}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })

  const kv = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 10, fontSize: 13, padding: '5px 0' }}>
      <span style={{ width: 96, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{value || '-'}</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 680 }}>
          全链路执行轨迹（Agent Trace）：一次任务 = 一个 Trace，记录终端 / 用户 / 问题 / 模型 / 推理摘要 / 技能 / 联网 / 证据 / 权限 / 结果 / 异常，供安全审计追溯，并支持按角色 + 模式一键脱敏。
        </div>
        <button className="btn-secondary" onClick={fetchRows}><RefreshCw size={14} /><span>刷新</span></button>
      </div>

      <div className="glass-panel" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 300 }}>
          <input className="form-input" placeholder="搜索问题 / 用户 / 分身 / 模型" value={q} onChange={e => setQ(e.target.value)} style={{ paddingLeft: 30 }} />
          <Search size={14} style={{ position: 'absolute', left: 9, top: 11, color: 'var(--text-muted)' }} />
        </div>
        <select className="form-select" style={{ width: 130 }} value={fRisk} onChange={e => setFRisk(e.target.value)}>
          <option value="全部">全部风险</option><option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高危</option>
        </select>
        <select className="form-select" style={{ width: 130 }} value={fWeb} onChange={e => setFWeb(e.target.value)}>
          <option value="全部">是否联网</option><option value="true">已联网</option><option value="false">未联网</option>
        </select>
      </div>

      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-secondary)' }}>正在拉取执行轨迹...</div> : (
          <table className="admin-table">
            <thead><tr>
              <th style={{ whiteSpace: 'nowrap' }}>时间 / 用户 / 终端</th><th>问题（标准脱敏）</th><th style={{ width: 110, whiteSpace: 'nowrap' }}>模型</th>
              <th style={{ width: 60, whiteSpace: 'nowrap' }}>联网</th><th style={{ width: 60, whiteSpace: 'nowrap' }}>沙箱</th><th style={{ width: 90, whiteSpace: 'nowrap' }}>耗时/词元</th><th style={{ width: 64, whiteSpace: 'nowrap' }}>风险</th>
              <th style={{ width: 90, whiteSpace: 'nowrap' }}>状态</th><th style={{ width: 56, whiteSpace: 'nowrap' }}>反馈</th><th style={{ width: 80, whiteSpace: 'nowrap' }}>操作</th>
            </tr></thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(r.id)}>
                  <td>
                    <div style={{ fontSize: 12 }}>{r.createdAt?.replace('T', ' ').slice(0, 19)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{r.userNickname} · {r.deviceHost}</div>
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 280 }}>{r.question}{r.sensitiveHit && <span className="badge badge-yellow" style={{ marginLeft: 6, fontSize: 9 }}>敏感</span>}</td>
                  <td style={{ fontSize: 11 }}><div>{r.modelName}</div><div style={{ color: 'var(--text-muted)' }}>{r.modelProvider}</div></td>
                  <td>{r.webSearchUsed ? <span className="badge badge-blue" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Globe size={9} />是</span> : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>否</span>}</td>
                  <td>{r.sandboxUsed ? <span className="badge badge-purple" title="代码在公司级 Docker 沙箱隔离执行" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Box size={9} />是</span> : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>否</span>}</td>
                  <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}><div>{(r.durationMs / 1000).toFixed(1)}s</div><div style={{ color: 'var(--text-muted)' }}>{r.totalTokens} tk</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{riskBadge(r.riskLevel)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{statusBadge(r.status)}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>{r.feedback === 'UP' ? <span title="用户：有帮助">👍</span> : r.feedback === 'DOWN' ? <span title="用户：待改进">👎</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={e => { e.stopPropagation(); openDetail(r.id) }}>追溯</button></td>
                </tr>
              ))}
              {visible.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>暂无执行轨迹</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <div className="skill-drawer-overlay" onClick={() => setDetail(null)}>
          <div className="skill-drawer" style={{ width: 720 }} onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}><Fingerprint size={16} />执行轨迹追溯</h3>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{detail.id}</div>
              </div>
              <button className="icon-btn" onClick={() => setDetail(null)}><X size={16} /></button>
            </div>

            {/* 角色 + 脱敏模式（两行，避免拥挤遮挡） */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 60, flexShrink: 0 }}>查看角色</span>
                <select className="form-select" style={{ width: 160, fontSize: 13, flexShrink: 0 }} value={role} onChange={e => reload(mode, e.target.value)}>
                  {ROLES.map(r => <option key={r.k} value={r.k}>{r.label}</option>)}
                </select>
                <span className="badge badge-green" style={{ marginLeft: 'auto' }}>{detail.mode === 'RAW' ? '原文（超管）' : '已脱敏 · ' + detail.mode}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 60, flexShrink: 0 }}>脱敏模式</span>
                {MODES.map(m => (
                  <button key={m.k} className={`filter-chip ${mode === m.k ? 'active' : ''}`} onClick={() => reload(m.k, role)} disabled={role === 'super'}>{m.label}</button>
                ))}
                {role === 'super' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>超级管理员查看原文，不脱敏</span>}
              </div>
            </div>

            <div className="settings-tabbar" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)', marginTop: 4 }}>
              {TABS.map(t => (
                <button key={t.k} className={`filter-chip ${tab === t.k ? 'active' : ''}`} style={{ borderRadius: '8px 8px 0 0' }} onClick={() => setTab(t.k)}>{t.label}</button>
              ))}
            </div>

            {tab === 'overview' && (
              <div>
                {kv('用户', `${detail.userNickname}（${detail.userId}）`)}
                {kv('终端', <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Monitor size={12} />{detail.deviceHost} · {detail.appVersion} · {detail.clientIp}</span>)}
                {kv('岗位分身', `${detail.expertName}（${detail.expertId}）`)}
                {kv('用户问题', detail.userQuestion)}
                {kv('模型', <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Cpu size={12} />{detail.modelName} · {detail.modelProvider} · {detail.connectionMode}</span>)}
                {kv('耗时 / 词元', `${(detail.durationMs / 1000).toFixed(1)}s · ${detail.promptTokens}+${detail.completionTokens} tokens`)}
                {kv('联网 / 技能', `${detail.webSearchUsed ? '已联网' : '未联网'}${detail.skillUsed ? ' · 技能：' + detail.skillUsed : ''}`)}
                {kv('沙箱执行', detail.sandboxUsed ? '是 · 代码在公司级 Docker 沙箱隔离执行（详见执行时间线）' : '否')}
                {kv('风险 / 状态', <span style={{ display: 'inline-flex', gap: 6 }}>{riskBadge(detail.riskLevel)}{statusBadge(detail.status)}</span>)}
                <div style={{ marginTop: 10, padding: 12, background: 'var(--bg-subtle)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>可审计推理摘要</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{detail.reasoningSummary || '—'}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>* 仅保存目标/计划/关键决策/失败原因，不保存完整思维链。</div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>最终回答</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{detail.finalAnswer}</div>
                </div>
              </div>
            )}

            {tab === 'timeline' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {parse(detail.spans).map((s: any, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                    <span className={`badge ${s.status === 'ok' ? 'badge-green' : s.status === 'warn' ? 'badge-yellow' : 'badge-red'}`}>{s.type}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
                      {s.detail && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.detail}</div>}
                    </div>
                    {s.durationMs != null && <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Clock size={10} />{s.durationMs}ms</span>}
                  </div>
                ))}
                {parse(detail.spans).length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>无时间线数据</div>}
              </div>
            )}

            {tab === 'sources' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>回答中的结论来自以下证据：</div>
                {parse(detail.sources).map((s: any, i: number) => (
                  <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 8, textDecoration: 'none' }}>
                    <LinkIcon size={13} color="var(--brand-secondary)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--brand-secondary)' }}>{s.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</div>
                    </div>
                  </a>
                ))}
                {parse(detail.sources).length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>本次无外部证据来源</div>}
                {detail.knowledgeUsed && <div style={{ fontSize: 12 }}>知识库：<span className="badge badge-yellow">{detail.knowledgeUsed}</span></div>}
              </div>
            )}

            {tab === 'audit' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>安全事件 / 责任链路</div>
                {parse(detail.events).map((e: any, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12 }}>
                    {e.type === 'guardrail' || e.type === 'sensitive' ? <ShieldAlert size={13} color="var(--accent-orange)" /> : <CheckCircle2 size={13} color="var(--accent-green)" />}
                    <span style={{ flex: 1 }}>{e.name}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{e.result || (e.rule ? '规则 ' + e.rule : '')}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 16, fontSize: 12, marginTop: 4 }}>
                  <span>触发审批：{detail.approvalTriggered ? '是' : '否'}</span>
                  <span>敏感命中：{detail.sensitiveHit ? '是' : '否'}</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>脱敏命中（当前模式 {detail.mode}）</div>
                {role === 'admin'
                  ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>共命中 {detail.hitTotal} 处，切换为「安全审计员」可查看命中明细与原因。</div>
                  : (detail.hits || []).length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>未命中敏感规则</div>
                    : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{detail.hits.map((h: any) => <span key={h.rule} className="badge badge-red" style={{ display: 'inline-flex', gap: 4 }}>{h.rule} {h.name} · {h.level} ×{h.count}</span>)}</div>}
              </div>
            )}

            {tab === 'desensitize' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  脱敏机制采用「分类识别、分级处理、按权展示、全程留痕」：对用户问题、模型调用、技能执行、联网访问、工具返回、文件产物等全流程数据自动扫描脱敏。
                </div>
                <div style={{ display: 'flex', gap: 14 }}>
                  {[{ k: 'LIGHT', t: '轻度脱敏', d: '保留业务可读性，内部复盘' }, { k: 'STANDARD', t: '标准脱敏', d: '默认，安全审计' }, { k: 'STRONG', t: '强脱敏', d: '客户名/金额/路径全泛化，外部汇报' }].map(m => (
                    <button key={m.k} className={`glass-panel ${mode === m.k ? '' : ''}`} onClick={() => reload(m.k, role)}
                      style={{ flex: 1, padding: 12, textAlign: 'left', cursor: 'pointer', border: mode === m.k ? '1px solid var(--brand-primary)' : '1px solid var(--border-color)', background: mode === m.k ? 'var(--bg-active)' : 'var(--bg-surface)' }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{m.t}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{m.d}</div>
                    </button>
                  ))}
                </div>
                <div style={{ padding: 12, background: 'var(--bg-subtle)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>本次脱敏命中报告（共 {detail.hitTotal} 处）</div>
                  {(detail.hits || []).length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{role === 'admin' ? '切换为「安全审计员」可查看命中明细' : '未命中敏感规则'}</div>
                    : <table className="admin-table" style={{ fontSize: 12 }}>
                      <thead><tr><th>规则</th><th>类型</th><th>级别</th><th>命中字段范围</th><th>次数</th></tr></thead>
                      <tbody>{detail.hits.map((h: any) => (
                        <tr key={h.rule}><td>{h.rule}</td><td>{h.name}</td><td><span className={`badge ${h.level === 'L3' ? 'badge-red' : h.level === 'L2' ? 'badge-yellow' : 'badge-blue'}`}>{h.level}</span></td><td style={{ color: 'var(--text-muted)' }}>问题/回答/工具/网页等全流程</td><td>{h.count}</td></tr>
                      ))}</tbody>
                    </table>}
                </div>
                <div>
                  <button className="btn-primary" onClick={exportReport}><Download size={14} /><span>导出脱敏报告并留痕</span></button>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 10 }}>导出会记录：模式、角色、命中规则、操作人、时间、导出编号。</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
