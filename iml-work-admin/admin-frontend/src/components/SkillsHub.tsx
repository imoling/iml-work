import { useState, useEffect } from 'react'
import {
  Search, Upload, Play, Save, Plus, RefreshCw, Trash2, X, Terminal,
  Globe, Code2, MousePointer2, Brain, Boxes, CheckCircle2, FileEdit, PauseCircle, Send, Tag, Plug, Sparkles, Download, ShieldCheck, PackagePlus, AlertTriangle
} from 'lucide-react'

interface Skill {
  id: string
  name: string
  type: string
  category: string
  status: string
  version: string
  description: string
  triggerKeywords: string[]
  allowedRoles: string[]
  sopContent: string
  code: string
  source: string
  targetSystemId: string
  actionScript?: string
}

// ===== 语义脚本 DSL：校验 / 高亮 / 试运行预演 =====
const DSL_VERBS: Record<string, { args: 'text' | 'num' | 'labelVal' | 'label'; hint: string }> = {
  click: { args: 'text', hint: 'click "可见文本"  — 点击按钮/菜单/链接' },
  fill: { args: 'labelVal', hint: 'fill "字段标签" = 值  — 填输入框/文本域' },
  select: { args: 'labelVal', hint: 'select "字段标签" = 值  — 原生下拉选择' },
  dropdown: { args: 'labelVal', hint: 'dropdown "字段标签" = 值  — 自定义下拉(点开后选)' },
  searchSelect: { args: 'labelVal', hint: 'searchSelect "字段标签" = 值  — 带+检索框:填关键词→选结果' },
  wait: { args: 'num', hint: 'wait 800  — 等待毫秒' },
  waitText: { args: 'text', hint: 'waitText "文本"  — 等到页面出现该文本' }
}

interface DslLine { n: number; raw: string; comment?: boolean; blank?: boolean; op?: string; arg?: string; value?: string; param?: string; error?: string }

function parseDslLine(raw: string, n: number): DslLine {
  const line = raw.trim()
  if (!line) return { n, raw, blank: true }
  if (line.startsWith('#')) return { n, raw, comment: true }
  let m: RegExpMatchArray | null
  if ((m = line.match(/^wait\s+(\d+)\s*$/i))) return { n, raw, op: 'wait', value: m[1] }
  if (/^wait\b/i.test(line)) return { n, raw, op: 'wait', error: 'wait 后需要一个毫秒数，如 wait 800' }
  if ((m = line.match(/^waitText\s+"([^"]*)"\s*$/i))) return { n, raw, op: 'waitText', arg: m[1] }
  m = line.match(/^(\w+)\s+"([^"]*)"\s*(?:=\s*(.+))?$/)
  if (!m) return { n, raw, op: (line.match(/^(\w+)/) || [])[1], error: '无法解析：应为  动词 "参数" [= 值]' }
  const op = m[1], arg = m[2], valueExpr = (m[3] || '').trim()
  if (!DSL_VERBS[op]) return { n, raw, op, arg, error: `未知动词「${op}」` }
  const spec = DSL_VERBS[op]
  let param: string | undefined
  const pm = valueExpr.match(/^\{\{\s*([\w.]+)\s*\}\}$/)
  if (pm) param = pm[1]
  if (spec.args === 'labelVal' && !valueExpr) return { n, raw, op, arg, error: `${op} 需要赋值，如 ${op} "${arg}" = {{字段}} 或 = "字面量"` }
  if (!arg) return { n, raw, op, error: `${op} 需要一个 "参数"` }
  return { n, raw, op, arg, value: valueExpr, param }
}

function validateDsl(code: string, fieldNames: string[]) {
  const lines = (code || '').split('\n').map((r, i) => parseDslLine(r, i + 1))
  const steps = lines.filter(l => l.op && !l.error)
  const errors = lines.filter(l => l.error)
  const usedParams = Array.from(new Set(lines.filter(l => l.param).map(l => l.param as string)))
  const undefinedParams = usedParams.filter(p => !fieldNames.includes(p))
  return { lines, steps, errors, usedParams, undefinedParams }
}

interface ExpertRef { id: string; title: string; skills?: { id: string }[] }
interface SystemRef { id: string; type: string; name: string; baseUrl: string; status: string }

const BLANK: Skill = {
  id: '', name: '', type: 'playwright', category: '办公自动化', status: 'DRAFT', version: '1.0.0',
  description: '', triggerKeywords: [], allowedRoles: [], sopContent: '', code: '', source: 'preset', targetSystemId: ''
}

// 执行引擎：图标 / 名称 / 配色
const ENGINES: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  'playwright': { label: '浏览器自动化', icon: <Globe size={20} />, color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
  'python-sandbox': { label: 'Python 数据处理', icon: <Code2 size={20} />, color: '#1F9E69', bg: 'var(--mint-50)' },
  'nut-js': { label: '桌面自动化', icon: <MousePointer2 size={20} />, color: '#D97706', bg: 'rgba(245,158,11,0.14)' },
  'onnx-bge': { label: '本地向量模型', icon: <Brain size={20} />, color: '#7C3AED', bg: 'rgba(139,92,246,0.12)' }
}
const engineOf = (t: string) => ENGINES[t] || { label: t || '通用', icon: <Boxes size={20} />, color: '#6B7280', bg: 'var(--bg-subtle)' }

const PRESET_CATEGORIES = ['办公自动化', '财务税务', '知识管理', '数据处理', '通用工具']

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PUBLISHED: { label: '已上架', cls: 'badge-green' },
  DRAFT: { label: '草稿', cls: 'badge-yellow' },
  DISABLED: { label: '已下架', cls: 'badge-red' }
}
const statusOf = (s: string) => STATUS_META[s] || STATUS_META.PUBLISHED

// 运行时上下文约定：
//   ctx.system        绑定的业务系统连接 { id, type, baseUrl }（由管理端"业务系统连接"定义地址）
//   ctx.storageState  员工在客户端配置的个人登录会话（无需在技能里写账号密码）
//   ctx.params        本次任务参数
const CODE_TEMPLATES: Record<string, string> = {
  'playwright': `// 浏览器自动化技能：操作绑定的业务系统并执行 SOP
const { chromium } = require('playwright')
module.exports = async function run(ctx) {
  const browser = await chromium.launch({ headless: true })
  // 复用员工在客户端登录好的会话，直接进入系统（无需在此填账号密码）
  const page = await browser.newContext({ storageState: ctx.storageState }).then(c => c.newPage())

  // ① 打开业务系统（地址来自"业务系统连接"，不要写死）
  await page.goto(ctx.system.baseUrl)

  // ② 找到"统一待办"入口
  await page.getByText('统一待办').first().click()
  await page.waitForLoadState('networkidle')

  // ③ 抓取待办列表
  const todos = await page.locator('.todo-list .todo-item').allInnerTexts()

  await browser.close()
  // ④ 返回结构化结果，交给分身整理成反馈
  return { ok: true, count: todos.length, items: todos }
}`,
  'python-sandbox': `# Python 数据处理技能
def run(ctx):
    # ctx.system.baseUrl / ctx.params 可用
    return { "ok": True }`,
  'nut-js': `// 桌面自动化技能
module.exports = async function run(ctx) {
  // 通过 nut-js 驱动本机桌面客户端
  return { ok: true }
}`,
  'onnx-bge': `// 本地向量检索技能
module.exports = async function run(ctx) {
  return { ok: true }
}`
}
const codeTemplate = (engine: string) => CODE_TEMPLATES[engine] || CODE_TEMPLATES['playwright']

export default function SkillsHub() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [experts, setExperts] = useState<ExpertRef[]>([])
  const [systems, setSystems] = useState<SystemRef[]>([])
  const [loading, setLoading] = useState(true)

  // 过滤
  const [query, setQuery] = useState('')
  const [fCategory, setFCategory] = useState('全部')
  const [fStatus, setFStatus] = useState('全部')

  // 编辑抽屉
  const [selected, setSelected] = useState<Skill | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [testInput, setTestInput] = useState('')
  const [generating, setGenerating] = useState(false)

  const generateFields = async () => {
    if (!selected) return
    if (!selected.name.trim() && !selected.description.trim()) { alert('请先填写技能名称或描述'); return }
    setGenerating(true)
    try {
      const res = await fetch('/api/v1/skills/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name, description: selected.description, type: selected.type, category: selected.category })
      })
      if (res.ok) {
        const d = await res.json()
        setSelected(s => s ? { ...s, triggerKeywords: Array.isArray(d.triggerKeywords) ? d.triggerKeywords : s.triggerKeywords, sopContent: d.sop || s.sopContent } : s)
        if (d.source === 'fallback') alert('已按模板生成（企业模型中转站未返回有效结果，请确认中转站已配置可用上游模型）。')
      } else { alert('生成失败') }
    } catch (e) { alert('生成失败：' + e) }
    setGenerating(false)
  }

  const fetchAll = async () => {
    setLoading(true)
    try {
      const [sk, ex, sys] = await Promise.all([
        fetch('/api/v1/skills'), fetch('/api/v1/experts'), fetch('/api/v1/integrations')
      ])
      if (sk.ok) setSkills(await sk.json())
      if (ex.ok) setExperts(await ex.json())
      if (sys.ok) setSystems(await sys.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { fetchAll() }, [])

  const systemOf = (id: string) => systems.find(s => s.id === id)
  // 被多少个岗位引用（绑定关系在"岗位专家"侧维护）
  const usedByCount = (skillId: string) => experts.filter(e => (e.skills || []).some(sk => sk.id === skillId)).length

  const categories = ['全部', ...Array.from(new Set([...PRESET_CATEGORIES, ...skills.map(s => s.category).filter(Boolean)]))]

  const visible = skills.filter(s => {
    if (fCategory !== '全部' && (s.category || '未分类') !== fCategory) return false
    if (fStatus !== '全部' && (s.status || 'PUBLISHED') !== fStatus) return false
    if (query.trim()) {
      const q = query.toLowerCase()
      const hay = `${s.name} ${s.description} ${(s.triggerKeywords || []).join(' ')}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const counts = {
    total: skills.length,
    published: skills.filter(s => (s.status || 'PUBLISHED') === 'PUBLISHED').length,
    draft: skills.filter(s => s.status === 'DRAFT').length,
    engines: new Set(skills.map(s => s.type)).size
  }

  const openEdit = (s: Skill) => { setSelected({ ...s, code: s.code || codeTemplate(s.type) }); setLogs([]); setTestInput('') }
  // ── 技能包:导出 / GitHub·本地包安装(导入前强制安全检查,参考 AI-Infra-Guard 风险模型) ──
  const [showInstall, setShowInstall] = useState(false)
  const [giUrl, setGiUrl] = useState('')
  const [giBusy, setGiBusy] = useState(false)
  const [giError, setGiError] = useState('')
  const [giPreview, setGiPreview] = useState<any>(null)     // 预检报告
  const [giFile, setGiFile] = useState<File | null>(null)   // 本地包模式

  const downloadJson = (data: any, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const exportOne = async (id: string, name: string) => {
    const r = await fetch(`/api/v1/skills/${id}/export`)
    if (r.ok) downloadJson(await r.json(), `skill-${name || id}.json`)
    else alert('导出失败')
  }
  const exportAll = async () => {
    const r = await fetch('/api/v1/skills/export/all')
    if (r.ok) downloadJson(await r.json(), `iml-skills-${new Date().toISOString().slice(0, 10)}.json`)
    else alert('导出失败')
  }
  const installRequest = async (confirm: boolean) => {
    setGiBusy(true); setGiError('')
    try {
      let res: Response
      if (giFile) {
        const fd = new FormData(); fd.append('file', giFile)
        res = await fetch(`/api/v1/skills/import-file?confirm=${confirm}`, { method: 'POST', body: fd })
      } else {
        res = await fetch('/api/v1/skills/import-github', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: giUrl.trim(), confirm })
        })
      }
      const d: any = await res.json().catch(() => ({}))
      if (!res.ok) { setGiError(d?.error || d?.message || `请求失败 (HTTP ${res.status})`); setGiBusy(false); return }
      if (!confirm) { setGiPreview(d) }
      else if (d?.success) {
        setShowInstall(false); setGiPreview(null); setGiUrl(''); setGiFile(null)
        alert(`已安装 ${d.installed?.length || 0} 个技能(状态:草稿)。请人工复核后上架。`)
        fetchAll()
      } else { setGiError(d?.error || '安装被阻断'); setGiPreview(d) }
    } catch (e: any) { setGiError(`请求失败:${e?.message || e}`) }
    setGiBusy(false)
  }
  const riskBadge = (risk: string) => {
    const map: Record<string, string> = { HIGH: 'badge-red', MEDIUM: 'badge-yellow', LOW: 'badge-blue', SAFE: 'badge-green' }
    const label: Record<string, string> = { HIGH: '高危·阻断', MEDIUM: '中危·告警', LOW: '低危·提示', SAFE: '未见风险' }
    return <span className={`badge ${map[risk] || 'badge-gray'}`}>{label[risk] || risk}</span>
  }

  const openNew = () => { setSelected({ ...BLANK, code: codeTemplate(BLANK.type) }); setLogs([]); setTestInput('') }

  const save = async () => {
    if (!selected) return
    if (!selected.name.trim()) { alert('请填写技能名称'); return }
    const isNew = !selected.id
    const res = await fetch(isNew ? '/api/v1/skills' : `/api/v1/skills/${selected.id}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selected)
    })
    if (res.ok) { setSelected(null); fetchAll() } else { alert('保存失败') }
  }

  const remove = async (id: string) => {
    const sk = skills.find(s => s.id === id)
    if (sk && (sk.status || 'PUBLISHED') === 'PUBLISHED') { alert('该技能已上架，请先「下架」后再删除（下架会脱离岗位绑定）。'); return }
    if (!confirm('确认删除该技能？此操作不可恢复。')) return
    const res = await fetch(`/api/v1/skills/${id}`, { method: 'DELETE' })
    if (res.ok) { if (selected?.id === id) setSelected(null); fetchAll() }
    else { const d = await res.json().catch(() => null); alert((d && d.error) || '删除失败') }
  }

  const changeStatus = async (id: string, status: string) => {
    if (status === 'DISABLED' && !confirm('下架该技能？下架后将脱离所有岗位绑定，分身不再可调用。')) return
    const res = await fetch(`/api/v1/skills/${id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    })
    if (res.ok) fetchAll()
  }

  const runTest = async () => {
    if (!selected?.id) { alert('请先保存技能后再进行测试'); return }
    setLogs(['[控制台] 提交测试请求...'])
    const res = await fetch(`/api/v1/skills/${selected.id}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: testInput })
    })
    if (res.ok) { const data = await res.json(); setLogs(data.logs || []) } else { setLogs(['[错误] 测试执行失败']) }
  }

  // 解析该技能 actionScript 里定义的字段名（{{参数}} 的可用集合）
  const dslFieldNames = (s: Skill): string[] => {
    try { const a = JSON.parse(s.actionScript || '{}'); return Array.isArray(a.fields) ? a.fields.map((f: any) => f.name) : [] } catch { return [] }
  }

  // 试运行：静态校验脚本 + 给出执行预演（真正对业务系统的执行在客户端用员工登录态进行）。
  const dryRunDsl = () => {
    if (!selected) return
    const names = dslFieldNames(selected)
    const { lines, steps, errors, usedParams, undefinedParams } = validateDsl(selected.code, names)
    const out: string[] = []
    out.push(`[试运行] 解析脚本：共 ${steps.length} 个有效步骤，${errors.length} 处错误。`)
    if (errors.length) { out.push('— 错误 —'); errors.forEach(e => out.push(`  第${e.n}行: ${e.error}  «${e.raw.trim()}»`)) }
    out.push(`— 需要确认的参数（${usedParams.length}）— ${usedParams.map(p => '{{' + p + '}}').join(' ') || '无'}`)
    if (undefinedParams.length) out.push(`  ⚠ 未在录制字段中定义：${undefinedParams.map(p => '{{' + p + '}}').join(' ')}（执行时会作为空白文本字段让用户填写）`)
    out.push('— 执行计划（客户端将按此解释执行）—')
    lines.filter(l => l.op && !l.error).forEach((l, i) => {
      const v = l.param ? `← 用户参数 {{${l.param}}}` : (l.value ? `= ${l.value}` : '')
      out.push(`  ${String(i + 1).padStart(2, ' ')}. ${l.op}${l.arg ? ` 「${l.arg}」` : ''} ${v}`)
    })
    out.push(errors.length ? '✗ 校验未通过，请修正后再保存下发。' : '✓ 校验通过。真实执行在客户端进行（需员工已在该业务系统登录）。')
    setLogs(out)
  }

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch('/api/v1/skills/upload', { method: 'POST', body: fd })
    if (res.ok) {
      const data = await res.json()
      alert(`技能包解析归档成功：${data.name}（已置为草稿，待发布）`)
      fetchAll()
    } else { alert('上传解析失败') }
    e.target.value = ''
  }

  const stat = (label: string, value: React.ReactNode, icon: React.ReactNode, color: string) => (
    <div className="glass-panel" style={{ flex: 1, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ color }}>{icon}</div>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 顶部说明 + 操作 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 640 }}>
          企业内部技能中心：集中沉淀、分类与发布可复用的自动化技能，供各岗位工作分身按权限调用。技能以 SKILL.md（说明 + 触发词 + 标准流程 + 代码）形式管理。
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={fetchAll}><RefreshCw size={14} /><span>刷新</span></button>
          <a className="btn-secondary" href="/api/v1/tools/recorder/download" style={{ textDecoration: 'none' }}
            title="下载 FDE 工作台（技能构建工具）：录制目标系统操作→生成语义脚本→可见浏览器试运行→确认后同步回技能中心">
            <Download size={14} /><span>FDE 工作台</span>
          </a>
          <label className="btn-secondary" style={{ cursor: 'pointer' }}>
            <Upload size={14} /><span>上传技能包</span>
            <input type="file" accept=".md,.zip" hidden onChange={onUpload} />
          </label>
          <button className="btn-secondary" title="从 GitHub 地址或本地导出包安装技能(安装前强制安全检查)"
            onClick={() => { setShowInstall(true); setGiPreview(null); setGiError(''); setGiUrl(''); setGiFile(null) }}>
            <PackagePlus size={14} /><span>安装技能包</span>
          </button>
          <button className="btn-secondary" title="导出全部技能为便携包(可在其它环境安装)" onClick={exportAll}>
            <Download size={14} /><span>导出全部</span>
          </button>
          <button className="btn-primary" onClick={openNew}><Plus size={14} /><span>新建技能</span></button>
        </div>
      </div>

      {/* 概览 */}
      <div style={{ display: 'flex', gap: 14 }}>
        {stat('技能总数', counts.total, <Boxes size={20} />, 'var(--brand-primary)')}
        {stat('已上架', counts.published, <CheckCircle2 size={20} />, 'var(--accent-green)')}
        {stat('草稿待审', counts.draft, <FileEdit size={20} />, 'var(--accent-yellow)')}
        {stat('执行引擎种类', counts.engines, <Tag size={20} />, 'var(--brand-secondary)')}
      </div>

      {/* 过滤条 */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
            <input className="form-input" placeholder="搜索技能名称 / 描述 / 触发词" value={query}
              onChange={e => setQuery(e.target.value)} style={{ paddingLeft: 32 }} />
            <Search size={14} style={{ position: 'absolute', left: 10, top: 12, color: 'var(--text-muted)' }} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {['全部', 'PUBLISHED', 'DRAFT', 'DISABLED'].map(s => (
              <button key={s} className={`filter-chip ${fStatus === s ? 'active' : ''}`} onClick={() => setFStatus(s)}>
                {s === '全部' ? '全部状态' : statusOf(s).label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {categories.map(c => (
            <button key={c} className={`filter-chip ${fCategory === c ? 'active' : ''}`} onClick={() => setFCategory(c)}>{c}</button>
          ))}
        </div>
      </div>

      {/* 技能卡片网格 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>正在加载技能目录...</div>
      ) : visible.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          没有符合条件的技能。点击「新建技能」或「上传技能包」开始。
        </div>
      ) : (
        <div className="skill-grid">
          {visible.map(s => {
            const eng = engineOf(s.type)
            const st = statusOf(s.status || 'PUBLISHED')
            return (
              <div key={s.id} className={`skill-card ${s.status === 'DISABLED' ? 'disabled' : ''}`} onClick={() => openEdit(s)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div className="skill-ic" style={{ background: eng.bg, color: eng.color }}>{eng.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="skill-name">{s.name}</span>
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                    </div>
                    <div className="skill-id">v{s.version || '1.0.0'} · {s.id}</div>
                  </div>
                </div>

                <div className="skill-desc">{s.description || '（暂无描述）'}</div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-blue">{eng.label}</span>
                  {s.category && <span className="badge badge-purple">{s.category}</span>}
                  {s.targetSystemId && systemOf(s.targetSystemId) && (
                    <span className="badge" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Plug size={10} />{systemOf(s.targetSystemId)!.name}
                    </span>
                  )}
                </div>

                {(s.triggerKeywords || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {s.triggerKeywords.slice(0, 4).map((k, i) => <span key={i} className="kw-chip">{k}</span>)}
                    {s.triggerKeywords.length > 4 && <span className="kw-chip">+{s.triggerKeywords.length - 4}</span>}
                  </div>
                )}

                <div className="skill-card-foot">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    被 {usedByCount(s.id)} 个岗位引用
                  </span>
                  <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                    {s.status === 'PUBLISHED'
                      ? <button className="icon-btn" title="下架（脱离岗位绑定）" onClick={() => changeStatus(s.id, 'DISABLED')}><PauseCircle size={14} /></button>
                      : <button className="icon-btn" title="上架" onClick={() => changeStatus(s.id, 'PUBLISHED')}><Send size={14} /></button>}
                    <button className="icon-btn" title="导出为技能包" onClick={() => exportOne(s.id, s.name)}><Download size={14} /></button>
                    <button className="icon-btn" title="编辑" onClick={() => openEdit(s)}><FileEdit size={14} /></button>
                    <button className="icon-btn danger" title={s.status === 'PUBLISHED' ? '请先下架再删除' : '删除'} disabled={s.status === 'PUBLISHED'} onClick={() => remove(s.id)}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 编辑抽屉 */}
      {selected && (
        <div className="skill-drawer-overlay" onClick={() => setSelected(null)}>
          <div className="skill-drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>{selected.id ? '编辑技能' : '新建技能'}</h3>
              <button className="icon-btn" onClick={() => setSelected(null)}><X size={16} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">技能名称</label>
                <input className="form-input" value={selected.name} onChange={e => setSelected({ ...selected, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">执行引擎</label>
                <select className="form-select" value={selected.type} onChange={e => setSelected({ ...selected, type: e.target.value })}>
                  <option value="playwright">浏览器自动化</option>
                  <option value="python-sandbox">Python 数据处理</option>
                  <option value="nut-js">桌面自动化</option>
                  <option value="onnx-bge">本地向量模型</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">业务分类</label>
                <select className="form-select" value={selected.category} onChange={e => setSelected({ ...selected, category: e.target.value })}>
                  {PRESET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">版本号</label>
                  <input className="form-input" value={selected.version} onChange={e => setSelected({ ...selected, version: e.target.value })} placeholder="1.0.0" />
                </div>
                <div className="form-group">
                  <label className="form-label">状态</label>
                  <select className="form-select" value={selected.status} onChange={e => setSelected({ ...selected, status: e.target.value })}>
                    <option value="PUBLISHED">已上架</option>
                    <option value="DRAFT">草稿</option>
                    <option value="DISABLED">已下架</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">目标业务系统</label>
              <select className="form-select" value={selected.targetSystemId || ''}
                onChange={e => setSelected({ ...selected, targetSystemId: e.target.value })}>
                <option value="">无 · 通用技能（不依赖特定业务系统）</option>
                {systems.map(sys => (
                  <option key={sys.id} value={sys.id}>{sys.type} · {sys.name}</option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {selected.targetSystemId
                  ? `运行时系统地址：${systemOf(selected.targetSystemId)?.baseUrl || '（连接已删除）'}，员工登录会话由客户端注入，代码中用 ctx.system.baseUrl 引用。`
                  : '若该技能要操作 OA / CRM 等系统，请在此绑定"业务系统连接"中已定义的系统。'}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">技能描述（供大模型语义匹配）</label>
              <input className="form-input" value={selected.description} onChange={e => setSelected({ ...selected, description: e.target.value })} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-active)', border: '1px solid var(--mint-200)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
              <span style={{ fontSize: 12, color: 'var(--mint-700)' }}>
                <Sparkles size={13} style={{ verticalAlign: -2, marginRight: 4 }} />根据名称与描述，用大模型自动生成「触发关键词」与「SOP」（经企业模型中转站）
              </span>
              <button type="button" className="btn-primary" style={{ padding: '6px 14px' }} onClick={generateFields} disabled={generating}>
                {generating ? '生成中…' : 'AI 生成'}
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">触发关键词（逗号分隔）</label>
              <input className="form-input" value={selected.triggerKeywords.join(', ')}
                onChange={e => setSelected({ ...selected, triggerKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                技能不在此指定岗位；由「岗位专家管理」按岗位挑选要装配的技能。
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">标准作业流程 SOP</label>
              <textarea className="form-textarea" value={selected.sopContent || ''} rows={4}
                onChange={e => setSelected({ ...selected, sopContent: e.target.value })}
                placeholder="描述该技能的执行步骤与规则，会注入到分身的上下文中..." style={{ resize: 'vertical' }} />
            </div>

            {(() => {
              const isDsl = selected.source === 'recorded' || /^(click|fill|select|dropdown|searchSelect|wait|waitText)\b/m.test(selected.code || '')
              const names = dslFieldNames(selected)
              const rep = isDsl ? validateDsl(selected.code, names) : null
              return (
                <div className="form-group">
                  <label className="form-label">{isDsl ? '技能脚本（语义 DSL · 可编辑）' : '技能代码'}</label>
                  {isDsl && (
                    <div className="dsl-hints">
                      {Object.entries(DSL_VERBS).map(([v, s]) => <span key={v} className="dsl-verb-chip" title={s.hint}>{v}</span>)}
                      <span style={{ color: 'var(--text-muted)' }}>· 用 <code>{'{{字段}}'}</code> 表示执行时让用户确认的参数</span>
                    </div>
                  )}
                  <textarea className="code-editor" spellCheck={false} value={selected.code}
                    onChange={e => setSelected({ ...selected, code: e.target.value })} />
                  {isDsl && rep && (
                    <div className="dsl-preview">
                      <div className="dsl-preview-head">
                        解析预览：{rep.steps.length} 步
                        {rep.errors.length > 0 ? <span className="dsl-bad">· {rep.errors.length} 处错误</span> : <span className="dsl-ok">· 语法 OK</span>}
                        {rep.undefinedParams.length > 0 && <span className="dsl-warn">· {rep.undefinedParams.length} 个未定义参数</span>}
                      </div>
                      {rep.lines.filter(l => !l.blank).map(l => (
                        <div key={l.n} className={`dsl-row ${l.error ? 'err' : ''}`}>
                          <span className="dsl-ln">{l.n}</span>
                          {l.comment ? <span className="dsl-cmt">{l.raw.trim()}</span> : l.error ? <span className="dsl-bad">✗ {l.error}</span> : (
                            <>
                              <span className="dsl-op">{l.op}</span>
                              {l.arg && <span className="dsl-arg">"{l.arg}"</span>}
                              {l.param ? <span className="dsl-param">{`{{${l.param}}}`}</span> : l.value && <span className="dsl-val">= {l.value}</span>}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn-primary" onClick={save}><Save size={14} /><span>保存技能</span></button>
              <div style={{ flex: 1 }} />
              {(selected.source === 'recorded' || /^(click|fill|select|dropdown|searchSelect|wait|waitText)\b/m.test(selected.code || '')) ? (
                <button className="btn-secondary" onClick={dryRunDsl}><Play size={14} /><span>试运行（校验+预演）</span></button>
              ) : (
                <>
                  <input className="form-input" placeholder="测试参数（如网址）" value={testInput}
                    onChange={e => setTestInput(e.target.value)} style={{ maxWidth: 200 }} />
                  <button className="btn-secondary" onClick={runTest}><Play size={14} /><span>单步测试</span></button>
                </>
              )}
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                <Terminal size={13} /><span>测试控制台</span>
              </div>
              <pre className="test-console">{logs.length ? logs.join('\n') : '// 单步测试输出将在此打印'}</pre>
            </div>
          </div>
        </div>
      )}

      {/* 安装技能包:GitHub / 本地文件 + 导入前安全检查报告 */}
      {showInstall && (
        <div className="skill-drawer-overlay" onClick={() => setShowInstall(false)}>
          <div className="skill-drawer" style={{ width: 620 }} onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <PackagePlus size={16} />安装技能包
                </h3>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  安装前多维安全扫描(威胁模型参考 Tencent AI-Infra-Guard,后端 Java 引擎)·装入即「草稿」,复核后再上架
                </div>
              </div>
              <button className="icon-btn" onClick={() => setShowInstall(false)}><X size={16} /></button>
            </div>

            <div className="form-group">
              <label className="form-label">GitHub 地址(raw 或 blob 链接,仅限 github 域名)</label>
              <input className="form-input" placeholder="https://github.com/owner/repo/blob/main/skills.json"
                value={giUrl} onChange={e => { setGiUrl(e.target.value); setGiFile(null); setGiPreview(null) }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>或</span>
              <label className="btn-secondary" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Upload size={13} />{giFile ? giFile.name : '选择本地技能包(.json)'}
                <input type="file" accept=".json" hidden onChange={e => { setGiFile(e.target.files?.[0] || null); setGiUrl(''); setGiPreview(null) }} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" disabled={giBusy || (!giUrl.trim() && !giFile)}
                onClick={() => installRequest(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ShieldCheck size={14} />{giBusy ? '检查中…' : '安全预检'}
              </button>
              <button className="btn-primary" disabled={giBusy || !giPreview || giPreview.blocked}
                title={giPreview?.blocked ? '存在 HIGH 级风险,已阻断' : ''}
                onClick={() => installRequest(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <PackagePlus size={14} />确认安装(草稿)
              </button>
            </div>
            {giError && <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>{giError}</div>}

            {giPreview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
                {giPreview.blocked && (
                  <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={14} />检测到 HIGH 级安全风险,安装已阻断。
                  </div>
                )}
                {(giPreview.skills || []).map((sk: any, i: number) => (
                  <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{sk.name}</span>
                      {riskBadge(sk.security?.risk || 'SAFE')}
                      {typeof sk.security?.riskScore === 'number' && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>风险分 {sk.security.riskScore}/100</span>
                      )}
                    </div>
                    {sk.description && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sk.description}</div>}
                    {(sk.security?.findings || []).map((f: any, j: number) => (
                      <div key={j} style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        {riskBadge(f.severity)}
                        <span style={{ color: 'var(--text-secondary)' }}>
                          <b>{f.type}</b>：{f.detail}
                          {f.evidence && <code style={{ marginLeft: 4, padding: '0 4px', borderRadius: 3, background: 'var(--bg-subtle)', color: 'var(--accent-red, #dc2626)', fontSize: 10 }}>{f.evidence}</code>}
                        </span>
                      </div>
                    ))}
                    {(sk.security?.findings || []).length === 0 && (
                      <div style={{ fontSize: 11, color: 'var(--accent-green, #16a34a)' }}>未发现安全风险。</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
