import { useState, useEffect } from 'react'
import {
  Search, Upload, Play, Save, Plus, RefreshCw, Trash2, X, Terminal,
  Globe, Code2, MousePointer2, Brain, Boxes, CheckCircle2, FileEdit, PauseCircle, Send, Tag, Plug, Sparkles, Download, ShieldCheck, PackagePlus, Loader2, Circle, ShieldAlert, BookOpen
} from 'lucide-react'

// 安装前安全扫描覆盖的检测维度（用于展示检查范围 + 预检时的动态过程）
const SCAN_DIMENSIONS = [
  '提示注入 / 越权指令',
  '确认绕过 / 权限提升',
  '凭证 / 数据外传',
  '脚本执行 / 沙箱逃逸',
  '供应链 / 命令投递',
  '外部域名外发面',
  '虚构数据倾向',
  '混淆 / 编码规避',
]

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
  focusMapJson?: string   // 画像沉淀映射 [{field,objectType}]；空=自动匹配，objectType 空串=不沉淀
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
  // 参数键含中文（目标对象/合同名称…），\w 匹配不到——曾因此预览里参数计数恒为 0
  const pm = valueExpr.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
  if (pm) param = pm[1]
  // arg 位参数（click "{{目标对象}}"）：录制治本产物——单据行点击不写死，目标由用户点名
  if (!param) { const apm = (arg || '').match(/^\{\{\s*([^{}]+?)\s*\}\}$/); if (apm) param = apm[1] }
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
  'onnx-bge': { label: '本地向量模型', icon: <Brain size={20} />, color: '#7C3AED', bg: 'rgba(139,92,246,0.12)' },
  'knowledge': { label: '知识/指南型', icon: <BookOpen size={20} />, color: '#0891B2', bg: 'rgba(6,182,212,0.12)' }
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
}`,
  'knowledge': ''   // 知识/指南型无需代码：能力来自「技能说明/SOP」，由模型按其规范应用
}
const codeTemplate = (engine: string) => CODE_TEMPLATES[engine] ?? CODE_TEMPLATES['playwright']

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
  const [scanning, setScanning] = useState(false)           // 正在安全预检（驱动维度动态过程）
  const [scanStep, setScanStep] = useState(0)               // 当前"正在检查"到第几个维度
  const [installing, setInstalling] = useState(false)       // 正在确认安装（拉包 + 落库，可能 20~40s）

  // 预检进行中：逐维度滚动展示"正在检查 xxx"，让用户看到扫描在推进（后端为单次请求，此为体验层动画）
  useEffect(() => {
    if (!scanning) return
    setScanStep(0)
    const t = setInterval(() => setScanStep(s => Math.min(s + 1, SCAN_DIMENSIONS.length - 1)), 260)
    return () => clearInterval(t)
  }, [scanning])

  const downloadJson = (data: any, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }
  // 导出**技能包 zip**（真实目录：SKILL.md + scripts/ + iml-skill.json），与 zip 导入互逆。
  // 以前导出 .json：即便内容全了，拿到手也是个 166KB 的 blob——脚本读不了、改不了、给不了别人。
  const exportOne = async (id: string, name: string) => {
    const r = await fetch(`/api/v1/skills/${id}/export.zip`)
    if (!r.ok) { alert('导出失败'); return }
    const blob = await r.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(name || id).replace(/[\\/:*?"<>|\s]+/g, '-')}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const exportAll = async () => {
    const r = await fetch('/api/v1/skills/export/all')
    if (r.ok) downloadJson(await r.json(), `iml-skills-${new Date().toISOString().slice(0, 10)}.json`)
    else alert('导出失败')
  }
  // force=true：管理员已人工审核安全报告，接受 HIGH 风险强制安装（仍落草稿，需人工上架）
  const installRequest = async (confirm: boolean, force = false) => {
    setGiBusy(true); setGiError('')
    if (!confirm) setScanning(true)   // 安全预检 → 启动维度动态过程
    else setInstalling(true)          // 确认安装 → 拉包+落库进行中
    try {
      let res: Response
      if (giFile) {
        const fd = new FormData(); fd.append('file', giFile)
        res = await fetch(`/api/v1/skills/import-file?confirm=${confirm}&force=${force}`, { method: 'POST', body: fd })
      } else {
        res = await fetch('/api/v1/skills/import-github', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: giUrl.trim(), confirm, force })
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
    setGiBusy(false); setScanning(false); setInstalling(false)
  }
  const riskBadge = (risk: string) => {
    const map: Record<string, string> = { HIGH: 'badge-red', MEDIUM: 'badge-yellow', LOW: 'badge-blue', SAFE: 'badge-green' }
    const label: Record<string, string> = { HIGH: '高危·阻断', MEDIUM: '中危·告警', LOW: '低危·提示', SAFE: '未见风险' }
    return <span className={`badge ${map[risk] || 'badge-gray'}`}>{label[risk] || risk}</span>
  }

  // 本体类型目录（画像沉淀映射的选项池；一次拉取，抽屉里复用）
  const [ontoTypes, setOntoTypes] = useState<{ typeKey: string; label: string; domain?: string }[]>([])
  useEffect(() => {
    fetch('/api/v1/ontology/types').then(x => x.ok ? x.json() : []).then((list: any[]) => {
      const seen = new Set<string>()
      setOntoTypes((Array.isArray(list) ? list : []).filter(t => t.typeKey && t.label && !seen.has(t.typeKey) && (seen.add(t.typeKey), true))
        .map(t => ({ typeKey: t.typeKey, label: t.label, domain: t.domain })))
    }).catch(() => setOntoTypes([]))
  }, [])

  // 技能确认字段（label 清单，来自 actionScript.fields）
  const skillFieldLabels = (s2: Skill): string[] => {
    try { const a = JSON.parse(s2.actionScript || '{}'); return Array.isArray(a.fields) ? a.fields.map((f: any) => String(f.label || '')).filter(Boolean) : [] } catch { return [] }
  }
  // 自动建议：本体类型中文标签整体出现在字段标签里（取最长命中）——与客户端 matchFieldsToTypes 同一规则。
  // 通用词排除同构自客户端 focus-core：「预计商机金额」虽含"商机"，但值是数字，沉出来是垃圾对象。
  const NON_OBJECT_FIELD = /金额|日期|时间|数量|次数|电话|手机|邮箱|编号|单号|备注|说明|纪要|描述|内容|原因|计划/
  const suggestType = (fieldLabel: string): string => {
    if (NON_OBJECT_FIELD.test(fieldLabel)) return ''
    let best = ''
    let bestLen = 0
    for (const t of ontoTypes) { if (t.label.length >= 2 && fieldLabel.includes(t.label) && t.label.length > bestLen) { best = t.typeKey; bestLen = t.label.length } }
    return best
  }
  // 当前映射（显式配置优先；无配置按自动建议展示）
  const focusRows = (s2: Skill): { field: string; objectType: string }[] => {
    const labels = skillFieldLabels(s2)
    let explicit: { field: string; objectType: string }[] = []
    try { const j = JSON.parse(s2.focusMapJson || '[]'); if (Array.isArray(j)) explicit = j } catch { /* 按空 */ }
    return labels.map(l => {
      const e = explicit.find(x => x.field === l)
      return { field: l, objectType: e ? e.objectType : suggestType(l) }
    })
  }
  const setFocusRow = (field: string, objectType: string) => {
    if (!selected) return
    const rows = focusRows(selected).map(r => r.field === field ? { field, objectType } : r)
    setSelected({ ...selected, focusMapJson: JSON.stringify(rows) })
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

  // 静态试运行：一段话 → 后端经模型网关按字段清单提炼 → 附沉淀预览。
  // 管理端是 Web 应用、没有本地浏览器引擎——真实执行（回放/填表）在 FDE 工作台或客户端做。
  const [dryText, setDryText] = useState('')
  const [drying, setDrying] = useState(false)
  const dryRunExtract = async () => {
    if (!selected?.id) { alert('请先保存技能'); return }
    if (!dryText.trim()) { alert('输入一段测试话术'); return }
    setDrying(true)
    setLogs([`[静态试运行] 提炼字段中…（真实执行请在 FDE 工作台 / 客户端）`])
    try {
      const res = await fetch(`/api/v1/skills/${selected.id}/dry-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: dryText })
      })
      const d = await res.json()
      if (!res.ok || !d.success) { setLogs([`[错误] ${d.error || d.message || '提炼失败'}`]); setDrying(false); return }
      const out: string[] = [`[静态试运行] 话术：「${dryText}」`, '— 提炼到的字段 —']
      const rows: { label: string; value: string }[] = d.fields || []
      rows.forEach(r => out.push(`  ${r.label} = ${r.value || '（空·话里没说，不编造）'}`))
      const map = focusRows(selected)
      const sink = rows.filter(r => r.value).map(r => ({ r, m: map.find(x => x.field === r.label) }))
        .filter(x => x.m && x.m.objectType)
      out.push('— 画像沉淀预览（执行成功后将沉入员工本地「我的关注」）—')
      if (sink.length) sink.forEach(x => out.push(`  「${x.r.value}」 → ${ontoTypes.find(t => t.typeKey === x.m!.objectType)?.label || x.m!.objectType}`))
      else out.push('  （无字段命中沉淀映射）')
      out.push('✓ 字段与沉淀设计核验完成。真实执行需员工登录态，请在 FDE 工作台「测整条链路」或客户端验证。')
      setLogs(out)
    } catch (e: any) { setLogs([`[错误] ${e?.message || e}`]) }
    setDrying(false)
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
      <div className="page-header">
        <div className="page-intro">
          沉淀与发布可复用的自动化技能，供各岗位分身按需调用。
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={fetchAll}><RefreshCw size={14} /><span>刷新</span></button>
          <a className="btn-secondary" href="/api/v1/tools/recorder/download" style={{ textDecoration: 'none' }}
            title="下载 FDE 工作台（技能构建工具）：录制目标系统操作→生成语义脚本→可见浏览器试运行→确认后同步回技能中心">
            <Download size={14} /><span>FDE 工作台</span>
          </a>
          {/* 「上传技能包」曾是第二个入口，且**绕过安全扫描**——同一件事两条路、一条有闸一条没闸，等于没闸。
              已并入「安装技能包」：它支持 .zip / .json / .md / GitHub 目录，且强制安全预检。 */}
          <button className="btn-secondary" title="安装技能包（.zip / .json / .md / GitHub 目录）——安装前强制安全扫描，装入即草稿"
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
                  <div className="foot-actions" onClick={e => e.stopPropagation()}>
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
                  <option value="knowledge">知识/指南型（无沙箱）</option>
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

            {/* 画像沉淀映射：执行成功后哪些字段沉入员工本地「我的关注」。显式可见可改——
                曾经全靠隐式自动匹配，管理员完全看不到"这个技能会沉淀什么"。 */}
            {skillFieldLabels(selected).length > 0 && (
              <div className="form-group">
                <label className="form-label">画像沉淀（执行成功后沉入员工本地「我的关注」）</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border-color)', borderRadius: 8, padding: 10 }}>
                  {focusRows(selected).map(r => (
                    <div key={r.field} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12.5, width: 140, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.field}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>→</span>
                      <select className="form-select" style={{ width: 220 }} value={r.objectType}
                        onChange={e => setFocusRow(r.field, e.target.value)}>
                        <option value="">不沉淀</option>
                        {ontoTypes.map(t => <option key={t.typeKey} value={t.typeKey}>{t.label}（{t.domain ? t.domain + '.' : ''}{t.typeKey}）</option>)}
                      </select>
                      {suggestType(r.field) === r.objectType && r.objectType && <span style={{ fontSize: 10, color: 'var(--accent-green)' }}>自动建议</span>}
                    </div>
                  ))}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    数据只存员工本机（按账号分库，不上传）；建议值按「字段标签包含本体类型标签」自动推导，可改可关。
                  </span>
                </div>
              </div>
            )}

            {(() => {
              // 录制步骤预览：录制技能的真实步骤在 actionScript.steps，code 常为空——
              // 只显示"# 录制为空"的黑框等于什么都看不到（FDE 端能看步骤，管理端也该能）。
              let recSteps: any[] = []
              try { const a = JSON.parse(selected.actionScript || '{}'); recSteps = Array.isArray(a.steps) ? a.steps : (Array.isArray(a.rawSteps) ? a.rawSteps : []) } catch { recSteps = [] }
              const codeEmpty = !(selected.code || '').replace(/#[^\n]*/g, '').trim()
              if (recSteps.length && codeEmpty) {
                return (
                  <div className="form-group">
                    <label className="form-label">录制步骤（{recSteps.length} 步 · 只读，重录请在 FDE 工作台）</label>
                    <div className="dsl-preview" style={{ maxHeight: 220, overflowY: 'auto' }}>
                      {recSteps.map((st: any, i: number) => {
                        const act = st.action || st.act || '?'
                        const label = st.label || st.text || st.selector || st.sel || ''
                        const val = st.param || st.fieldName ? `{{${st.param || st.fieldName}}}` : (st.value ? `= ${String(st.value).slice(0, 40)}` : '')
                        return (
                          <div key={i} className="dsl-row">
                            <span className="dsl-ln">{i + 1}</span>
                            <span className="dsl-op">{act}</span>
                            {label && <span className="dsl-arg">"{String(label).slice(0, 48)}"</span>}
                            {val && <span className="dsl-param">{val}</span>}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              }
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

            {/* 静态试运行：话→字段提炼（经模型网关）+ 沉淀预览。真实执行在 FDE/客户端（需员工登录态）。 */}
            {selected.id && skillFieldLabels(selected).length > 0 && (
              <div className="form-group">
                <label className="form-label">静态试运行（一段话 → 字段提炼 + 沉淀预览）</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-input" style={{ flex: 1 }} placeholder="例：我今天拜访华东电网项目的李主任，沟通了项目最新建设情况"
                    value={dryText} onChange={e => setDryText(e.target.value)} />
                  <button className="btn-secondary" style={{ flexShrink: 0 }} onClick={dryRunExtract} disabled={drying}>
                    {drying ? '提炼中…' : '试提炼'}
                  </button>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>只验证「话→字段」与沉淀设计；真实执行（回放/填表）需员工登录态，请在 FDE 工作台「测整条链路」或客户端做。</span>
              </div>
            )}

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
                  支持 <b>.zip</b> 技能包（SKILL.md + scripts/，即本平台「导出」的格式）、<b>.json</b> 信封、<b>.md</b> 裸 SKILL.md，或 GitHub 目录
                  <br />安装前多维安全扫描 · 装入即「草稿」，复核后上架
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                  <ShieldCheck size={12} style={{ color: 'var(--brand-primary)' }} />
                  <span style={{ color: 'var(--text-muted)' }}>检查维度：</span>
                  {SCAN_DIMENSIONS.map((d, i) => (
                    <span key={i} style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--bg-subtle)', border: '1px solid var(--border-color)' }}>{d}</span>
                  ))}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setShowInstall(false)}><X size={16} /></button>
            </div>

            <div className="form-group">
              <label className="form-label">GitHub 地址(raw 或 blob 链接,仅限 github 域名)</label>
              <input className="form-input" placeholder="https://github.com/owner/repo/tree/main/skills/pptx"
                value={giUrl} onChange={e => { setGiUrl(e.target.value); setGiFile(null); setGiPreview(null) }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>或</span>
              <label className="btn-secondary" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Upload size={13} />{giFile ? giFile.name : '选择本地技能包（.zip / .json / .md）'}
                {/* zip = 真实技能包（SKILL.md + scripts/，也是本平台导出的格式）；json = iML 信封；md = 裸 SKILL.md。
                    accept 少写一个 .zip，用户在文件选择框里就**根本选不到** zip —— 后端认了也白认。 */}
                <input type="file" accept=".zip,.json,.md" hidden onChange={e => { setGiFile(e.target.files?.[0] || null); setGiUrl(''); setGiPreview(null) }} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* 步骤①：安全预检（未预检前为主操作） */}
              <button className={giPreview ? 'btn-secondary' : 'btn-primary'} disabled={giBusy || (!giUrl.trim() && !giFile)}
                onClick={() => installRequest(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {scanning ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                {scanning ? '安全预检中…' : giPreview ? '重新预检' : '① 安全预检'}
              </button>
              {/* 步骤②：确认安装（必须先通过预检且未被阻断） */}
              <button className="btn-primary" disabled={giBusy || !giPreview || giPreview.blocked}
                title={!giPreview ? '请先点「安全预检」' : giPreview.blocked ? '存在 HIGH 级风险，已阻断（审核后可强制安装）' : ''}
                onClick={() => installRequest(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!giPreview || giPreview.blocked) ? 0.55 : 1 }}>
                {installing ? <Loader2 size={14} className="spin" /> : <PackagePlus size={14} />}
                {installing ? '安装中…' : '② 确认安装（草稿）'}
              </button>
              {!giPreview && !scanning && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>请先安全预检，通过后才能安装</span>
              )}
            </div>

            {/* 预检动态过程：逐维度滚动展示，让用户看到扫描在推进 */}
            {scanning && (
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, background: 'var(--bg-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Loader2 size={13} className="spin" style={{ color: 'var(--brand-primary)' }} />正在安全预检 · 逐维度扫描技能包与脚本
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {SCAN_DIMENSIONS.map((d, i) => {
                    const done = i < scanStep, cur = i === scanStep
                    return (
                      <div key={i} style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 7, color: done ? 'var(--accent-green, #16a34a)' : cur ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {done ? <CheckCircle2 size={13} /> : cur ? <Loader2 size={13} className="spin" /> : <Circle size={13} style={{ opacity: 0.4 }} />}
                        {cur ? `正在检查：${d}…` : d}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 安装进行中：拉包 + 落库可能 20~40s，给出明确进度反馈 */}
            {installing && (
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg-subtle)', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Loader2 size={14} className="spin" style={{ color: 'var(--brand-primary)' }} />
                正在安装 · 从来源拉取整目录并落库（可能需 20~40 秒，请勿关闭）…
              </div>
            )}

            {giError && <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>{giError}</div>}

            {giPreview && !scanning && !installing && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
                {/* 总体结论横幅 */}
                {giPreview.blocked ? (
                  <div style={{ border: '1px solid rgba(220,38,38,0.35)', background: 'rgba(220,38,38,0.06)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-red, #dc2626)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ShieldAlert size={15} />预检发现 HIGH 级风险 · 已默认阻断安装
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      请逐条审核下方发现。若均为可信来源（如官方技能包脚本）的合法用途（如 subprocess 调用 soffice/pandoc 转换文档），可人工确认后强制安装；否则请勿安装。
                    </div>
                    <button className="btn-danger" disabled={giBusy} style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={() => { if (window.confirm('确认已人工审核全部 HIGH 级安全发现，并接受风险安装？（仍落草稿，需人工上架）')) installRequest(true, true) }}>
                      {installing ? <Loader2 size={13} className="spin" /> : null}
                      {installing ? '安装中…' : '已审核，接受风险强制安装'}
                    </button>
                  </div>
                ) : (
                  <div style={{ border: '1px solid rgba(22,163,74,0.3)', background: 'rgba(22,163,74,0.06)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-green, #16a34a)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ShieldCheck size={15} />预检通过 · 未发现 HIGH 级风险，可点击「② 确认安装」
                  </div>
                )}

                {/* 每个技能一张卡：概览 + 按严重度分组的发现 */}
                {(giPreview.skills || []).map((sk: any, i: number) => {
                  const findings: any[] = sk.security?.findings || []
                  const bySev = (sev: string) => findings.filter(f => f.severity === sev)
                  const groups = [
                    { sev: 'HIGH', label: '高危', color: 'var(--accent-red, #dc2626)', items: bySev('HIGH') },
                    { sev: 'MEDIUM', label: '中危', color: '#d97706', items: bySev('MEDIUM') },
                    { sev: 'LOW', label: '低危', color: '#2563eb', items: bySev('LOW') },
                  ].filter(g => g.items.length)
                  return (
                  <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* 概览行 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{sk.name}</span>
                      {riskBadge(sk.security?.risk || 'SAFE')}
                      {typeof sk.security?.riskScore === 'number' && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>风险分 {sk.security.riskScore}/100</span>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                        共 {findings.length} 项发现{Array.isArray(sk.bundleFiles) ? ` · 扫描 ${sk.bundleFiles.length} 个文件` : ''}
                      </span>
                    </div>
                    {sk.description && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6, maxHeight: 60, overflow: 'hidden' }}>{sk.description}</div>}

                    {/* 按严重度分组 */}
                    {groups.map(g => (
                      <div key={g.sev} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: g.color, display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.color }} />{g.label}（{g.items.length}）
                        </div>
                        {g.items.map((f: any, j: number) => (
                          <div key={j} style={{ fontSize: 11.5, display: 'flex', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-subtle)', borderLeft: `2px solid ${g.color}` }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{f.type}</div>
                              <div style={{ color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>{f.detail}</div>
                              {f.evidence && (
                                <div style={{ marginTop: 3 }}>
                                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>命中：</span>
                                  <code style={{ padding: '1px 5px', borderRadius: 3, background: 'rgba(220,38,38,0.08)', color: g.color, fontSize: 10.5 }}>{f.evidence}</code>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                    {findings.length === 0 && (
                      <div style={{ fontSize: 11.5, color: 'var(--accent-green, #16a34a)', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <CheckCircle2 size={13} />八个维度均未发现风险
                      </div>
                    )}

                    {/* bundle 文件清单（折行小字，放最后不抢视线） */}
                    {Array.isArray(sk.bundleFiles) && sk.bundleFiles.length > 0 && (
                      <details style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        <summary style={{ cursor: 'pointer' }}>已抓取整目录 {sk.bundleFiles.length} 个文件</summary>
                        <div style={{ marginTop: 4, lineHeight: 1.6 }}>{sk.bundleFiles.join('、')}</div>
                      </details>
                    )}
                  </div>
                )})}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
