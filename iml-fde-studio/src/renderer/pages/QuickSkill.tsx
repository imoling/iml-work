import React, { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Admin, Browser, SkillCenter, Connections, getBaseUrl, modelChat } from '../services/api'
import { PageHeader, Tag, Pager } from '../components/ui'
import Icon from '../components/Icon'
import { setDraft, getDraft } from '../lib/draftStore'
import { stepsToSop } from '../lib/sop'

// 快速建技能：录制 → 命名 → 试运行 → 提交技能中心，一步到位（不强制走完整场景生产线）
const ACT_LABEL = { click: '点击', fill: '填写', select: '选择', search: '搜索选择', pickOption: '选项', hover: '悬停', fxPick: '选择', press: '按键', choose: '勾选', upload: '上传', agent: 'AI指令', openTab: '新窗口', extract: '提取' }
const WRITE_ACTS = ['fill', 'select', 'search', 'pickOption', 'fxPick', 'choose', 'upload']
// 可填字段动作（运行时可由用户参数注入；pickOption 通常是 search 的子步，不单独成字段）
const FILL_ACTS = ['fill', 'select', 'search', 'fxPick', 'choose', 'upload']
const actToType = (a) => a === 'select' || a === 'choose' ? 'select' : a === 'search' ? 'search' : a === 'upload' ? 'file' : 'text'
// AI 指令步上限（成本红线：每步回放烧一次模型会话）
const MAX_AGENT_STEPS = 3
// 保存卡口:值长得像业务数据(日期/单号/金额/手机/邮箱)却没参数化 → 提交前列出请显式确认
const BIZ_VALUE_RES = [/^\d{4}[-/年]\d{1,2}[-/月]?\d{0,2}/, /^1[3-9]\d{9}$/, /^[\w.+-]+@[\w-]+\.[\w.]+$/, /^[A-Z]{2,6}[-_]?\d{4,}$/, /^[¥$]?\d+(,\d{3})*(\.\d+)?(元|万|万元)?$/]
// 读取类/写入类、导航直达路由：从步骤派生（删除/编辑步骤后自动重算）
const deriveKind = (steps) => (steps || []).some(s => WRITE_ACTS.includes(s.act)) ? 'write' : 'read'
const deriveNav = (steps) => { const c = (steps || []).find(s => s.act === 'click' && s.nav); return c ? c.nav : '' }
// 字段 schema：从「标记为参数」的填写/选择/搜索步骤派生（step.param 为运行时字段键，label 为语义名）
const deriveFields = (steps) => {
  const out = []
  for (const s of (steps || [])) {
    if (s.param && !out.find(f => f.name === s.param)) out.push({ name: s.param, label: s.label || s.param, type: actToType(s.act) })
  }
  return out
}

// 技能卡片：从 actionScript 读参数个数
function skillFieldCount(sk) { try { const as = JSON.parse(sk.actionScript || 'null'); return as && Array.isArray(as.fields) ? as.fields.length : 0 } catch (_) { return 0 } }
// 技能生命周期状态：已上架 / 草稿 / 已下架
const SKILL_STATUS = { PUBLISHED: { label: '已上架', kind: 'green' }, DRAFT: { label: '草稿', kind: 'gray' }, DISABLED: { label: '已下架', kind: 'amber' } }
const statusOf = (s) => SKILL_STATUS[s || 'PUBLISHED'] || SKILL_STATUS.PUBLISHED

// 可读脚本：标记为参数的步骤输出 {{语义名}} 占位（供后端按 schema 生成 SOP），常量步骤输出录制值
function readable(steps) {
  return (steps || []).map(s => {
    // 参数化的 click（单据行点击治本）：目标就是参数本身，且不带 @sel——录制选择器指向旧目标行，换目标必点错
    if ((s.act === 'click' || s.act === 'tap') && s.param) return `click "{{${s.param}}}"`
    if (s.act === 'agent') return `agent "${String(s.value || s.label || '').replace(/"/g, '')}"`
    if (s.act === 'openTab') return `openTab ""`
    const v = s.param ? ` = {{${s.label || s.param}}}` : (s.value ? ` = "${String(s.value).replace(/"/g, '')}"` : '')
    // 带上录制的精确选择器（@sel）：回放据此直达控件，避免只靠 label 匹配退化到错控件。跳过 body/form 这类过宽的。
    const sel = s.fp && s.fp.sel && !/^(body|html|form)$/i.test(String(s.fp.sel).trim()) ? ` @sel=${s.fp.sel}` : ''
    // iframe 步骤带 @frame=<url>：客户端回放据此切入对应子 frame 执行（泛微门户"表单嵌 iframe"场景）
    const fr = s.inIframe && s.frameUrl ? ` @frame=${String(s.frameUrl).split('#')[0]}` : ''
    // 动词映射:录制 IR 的 search 在客户端 DSL 语义里叫 searchSelect(检索并选中),别让客户端吃到不认识的动词
    const act = s.act === 'search' ? 'searchSelect' : s.act
    return `${act} "${s.label || ''}"${v}${sel}${fr}`
  }).join('\n')
}

export default function QuickSkill() {
  // 挂载时从持久化草稿读回，返回页面不丢（避免空白覆盖）
  const d0 = getDraft() || {}
  const [searchParams, setSearchParams] = useSearchParams()
  const [systems, setSystems] = useState([])
  const [skills, setSkills] = useState([])        // 已上架技能（列表/编辑/删除）
  const [editId, setEditId] = useState('')        // 非空=编辑既有技能，提交走 update
  const [systemId, setSystemId] = useState(d0.systemId || '')
  const [recording, setRecording] = useState(false)
  const [recDiag, setRecDiag] = useState(null)   // 录制诊断（frame 分布/空标签/窗口数）
  const [recCount, setRecCount] = useState(0)
  const [steps, setSteps] = useState(Array.isArray(d0.steps) ? d0.steps : [])
  const [name, setName] = useState(d0.name && d0.name !== '草稿技能' ? d0.name : '')
  const [desc, setDesc] = useState(d0.description || '')   // 技能描述（供大模型语义匹配）
  const [descBusy, setDescBusy] = useState(false)
  const [keywords, setKeywords] = useState((d0.triggerKeywords || []).join(', '))
  const [sop, setSop] = useState(d0.sop || '')
  const [directNav, setDirectNav] = useState(d0.navHash || '')
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [skillId, setSkillId] = useState('')
  // 内嵌技能测试状态
  const [testPara, setTestPara] = useState('')
  const [testLines, setTestLines] = useState([])
  const [testBusy, setTestBusy] = useState(false)
  const [testVerdict, setTestVerdict] = useState(null)
  const [testErr, setTestErr] = useState('')
  const [headless, setHeadless] = useState(false)  // 无头浏览器：开=后台不弹窗
  const [showMd, setShowMd] = useState(false)       // SKILL.md 落盘预览面板
  const [kindOverride, setKindOverride] = useState(d0.skillKind || '')  // 读/写显式覆盖：''=按步骤自动派生
  // 字段元数据（必填/默认/选项/说明），按字段名侧存，合并进派生 fields。派生字段只给 name/label/type，
  // 这些运行时表单细节由作者在「字段映射」里补。
  const [fieldMeta, setFieldMeta] = useState(d0.fieldMeta || {})
  const setFieldMetaFor = (nm, patch) => setFieldMeta(prev => ({ ...prev, [nm]: { ...(prev[nm] || {}), ...patch } }))
  // 验收用例：把「一句话测试」存下来，编辑后一键回归回放。随技能存 actionScript.acceptanceCases。
  const [cases, setCases] = useState(Array.isArray(d0.acceptanceCases) ? d0.acceptanceCases : [])
  const [caseResults, setCaseResults] = useState({})   // 瞬态：idx → {pass, reason}，不落库
  const [regBusy, setRegBusy] = useState(false)
  // bundle 技能（agentic/知识型：SKILL.md+scripts 整目录）编辑态。非空=正在编辑 bundle 技能，切文件树编辑器。
  const [bundleFiles, setBundleFiles] = useState(null)   // {相对路径: 文本内容} | null
  const [bundleActive, setBundleActive] = useState('')   // 当前选中文件路径
  const [editType, setEditType] = useState('')           // 编辑中技能的原始 type（提交时保留，不覆盖成 playwright）
  const isBundle = !!bundleFiles
  const patchBundleFile = (p, c) => setBundleFiles(prev => ({ ...prev, [p]: c }))
  const [collapsedDirs, setCollapsedDirs] = useState({})   // bundle 文件树：目录 → 是否折叠（大目录默认折叠）
  // 主视图（技能管理）：抽屉开关 + 搜索/筛选
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filterSys, setFilterSys] = useState('')
  const [filterKind, setFilterKind] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(12)
  const stepUnsub = useRef(null), lineUnsub = useRef(null), testUnsub = useRef(null)
  // SOP / 描述 是否被人工改过：改过就不再自动覆盖（草稿里已有视为已定）
  const sopDirty = useRef(!!(d0.sop && d0.sop.trim()))
  const descDirty = useRef(!!(d0.description && d0.description.trim()))
  // 读/写判定：显式覆盖优先，否则按步骤自动派生（含写动作即 write）。
  // 显式覆盖是安全相关——纯抓取类若被作者标 write，客户端就按写操作强制人工确认，宁严勿漏。
  const skillKind = kindOverride || deriveKind(steps)
  // 直达路由作为技能常量：手填优先，否则用录制派生
  const navHash = directNav.trim() || deriveNav(steps)
  // SOP 里引用的 {{占位}}；参数清单 = 录制标注参数 ∪ SOP 占位，再叠加字段元数据（单一来源，buildDraft 复用）
  const sopParamNames = Array.from(new Set((sop.match(/\{\{\s*([^}]+?)\s*\}\}/g) || []).map(m => m.replace(/[{}]/g, '').trim()).filter(Boolean)))
  const fields = (() => {
    const all = deriveFields(steps)
    sopParamNames.forEach((p, i) => { if (!all.find(f => (f.label || f.name) === p)) all.push({ name: 'sp' + i, label: p, type: 'text' }) })
    // 合并元数据；options 在 fieldMeta 里存逗号串便于编辑，落 fields 时转成数组（客户端要 string[]）
    return all.map(f => {
      const m = fieldMeta[f.name]
      if (!m) return f
      const merged = { ...f, ...m }
      if (typeof m.options === 'string') merged.options = m.options.split(/[，,]/).map(x => x.trim()).filter(Boolean)
      return merged
    })
  })()
  const fillSteps = steps.filter(s => FILL_ACTS.includes(s.act))
  const warnings = []
  if (steps.length) {
    if (skillKind === 'read' && !navHash) warnings.push('未录到「直达路由」：回放时将退回抓取系统首页。请确认录制时点到了真正的菜单项（避免占位/纯 JS 菜单）。')
    if (fillSteps.length && fields.length === 0) warnings.push(`录到 ${fillSteps.length} 个可填字段，但没有任何字段标记为「参数」。这样回放会原样重填录制时的值（如「${fillSteps[0].value || ''}」），换一条数据就失效——请把每次要变的字段切到「参数」。`)
    const unnamed = fields.filter(f => !f.label || !f.label.trim()).length
    if (unnamed) warnings.push(`有 ${unnamed} 个参数还没填「语义名」。请补全（如 拜访纪要、下一步计划），运行时会按它提炼用户的话并弹表单确认。`)
    // SOP 占位 ↔ 参数字段一致性：参数没在 SOP 里以 {{名}} 引用 → 回放时该参数无处落笔
    const notInSop = fields.filter(f => f.name.startsWith('sp') ? false : !sopParamNames.includes(f.label || f.name)).map(f => f.label || f.name)
    if (sop.trim() && notInSop.length) warnings.push(`参数「${notInSop.join('、')}」未在 SOP 中以 {{${notInSop[0]}}} 形式引用——回放时提炼到值也无处落笔。请在 SOP 对应位置插入占位，或用下方「字段映射」核对。`)
    const hovers = steps.filter(s => s.act === 'hover').length
    if (hovers) warnings.push(`含 ${hovers} 个「悬停」步骤（多为展开菜单的手势），可删除以精简、提升回放稳定性。`)
    const agentN = steps.filter(s => s.act === 'agent').length
    if (agentN > MAX_AGENT_STEPS) warnings.push(`AI 指令步有 ${agentN} 个，超过上限 ${MAX_AGENT_STEPS}——每步回放都要一次模型会话，请把多余的改回确定性步骤或合并。`)
    const hintN = steps.filter(s => s._hint && !s.param).length
    if (hintN) warnings.push(`有 ${hintN} 步被识别为「疑似业务数据」（步骤上有黄色角标）——不参数化会把录制值焊死。请逐项点「建议参数·采纳」或确认保持固定。`)
    if (steps.length === 1) warnings.push('仅录到 1 步，请确认操作是否完整。')
  }
  const deleteStep = (i) => setSteps(prev => prev.filter((_, idx) => idx !== i))
  const patchStep = (i, patch) => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  // 重排：与相邻步互换（录漏顺序/补录后调位置，不必重录）
  const moveStep = (i, dir) => setSteps(prev => {
    const j = i + dir
    if (j < 0 || j >= prev.length) return prev
    const next = prev.slice(); const t = next[i]; next[i] = next[j]; next[j] = t; return next
  })
  // 手动补一步：新步无录制指纹(fp)，回放靠语义/标签匹配，故须填清楚 label
  const addStep = () => setSteps(prev => [...prev, { act: 'click', label: '', value: '', manual: true }])
  // 切换「参数 ↔ 常量」：标为参数时分配稳定字段键 p1/p2…（runAgentic 据此用 fieldValues[param] 注入）
  // 参数键用字段真实标签（与 SOP {{标签}} / 运行时提炼一致）
  const toggleParam = (i) => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, param: s.param ? '' : ((s._hint && s._hint.name) || s.label || ('p' + idx)) } : s))
  const buildDraft = () => {
    const s = systems.find(x => x.id === systemId)
    return {
      name: name.trim() || (s ? s.name + ' 操作技能' : '草稿技能'),
      description: desc.trim(),
      systemId, baseUrl: s ? s.baseUrl : '', sysName: s ? s.name : '',
      sop, fields, fieldMeta, navHash: navHash || directNav.trim(), skillKind,   // fields 已合并 SOP占位+元数据
      triggerKeywords: keywords.split(/[，,、；;\s]+/).map(x => x.trim()).filter(Boolean),
      acceptanceCases: cases,
      steps, stepCount: steps.length
    }
  }
  // 技能描述（供大模型语义匹配）：根据名称 + 操作脚本，用模型中转站生成一句话场景描述
  async function genDesc(stepsArg, nameArg) {
    const st = stepsArg || steps
    if (!st.length) return
    setDescBusy(true)
    try {
      const kind = deriveKind(st)
      const prompt = `为一个企业自动化「岗位分身技能」写一句简洁的技能描述，用于大模型语义匹配（说明这个技能在什么场景触发、对哪个系统、做什么事）。\n` +
        `技能名称：${(nameArg || name || '').trim() || '(未命名)'}\n` +
        `类型：${kind === 'read' ? '读取/查询类' : '写入/操作类'}\n` +
        `业务系统：${sys() ? sys().name : '(未指定)'}\n` +
        `操作脚本（每行一个动作）：\n${readable(st) || '(无)'}\n\n` +
        `只输出一句话描述（30-60字，中文，不要引号、不要任何前缀）。例如：当用户要查看或处理 OA 待办、待审批事项时，登录企业 OA 抓取统一待办列表并汇总反馈。`
      const out = await modelChat(prompt)
      const d = (out || '').trim().replace(/^["“「]+|["”」]+$/g, '').split('\n')[0].trim()
      if (d) { setDesc(d); descDirty.current = false }
    } catch (e) { /* 生成失败不阻断，可手填 */ }
    finally { setDescBusy(false) }
  }
  // 草稿实时自动同步到共享存储（持久化），「技能测试」页随时可测
  useEffect(() => { setDraft(buildDraft()) }, [name, desc, keywords, systemId, sop, steps, directNav, systems, kindOverride, fieldMeta, cases])
  // 录制信息 → 自动生成 SOP（无需手点 AI）；人工改过 SOP 后不再覆盖
  useEffect(() => { if (steps.length && !sopDirty.current) setSop(stepsToSop(steps, name || (sys() ? sys().name + ' 操作技能' : '录制技能'))) }, [steps, name])
  // 搜索/筛选/每页数变化 → 回到第 1 页
  useEffect(() => { setPage(1) }, [query, filterSys, filterKind, pageSize])

  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const saveDraft = () => { setDraft(buildDraft()); note('已保存草稿 → 去左侧「技能测试」发一段话测链路（无需发布）') }
  const reloadSkills = () => SkillCenter.list().then(s => setSkills(Array.isArray(s) ? s : [])).catch(() => {})
  // 把已上架技能读回表单进入编辑态（保留其 SOP，不被录制自动覆盖）
  function loadSkill(sk) {
    let st = [], fm = {}, cs = []
    try {
      const as = JSON.parse(sk.actionScript || 'null')
      if (as && Array.isArray(as.rawSteps)) st = as.rawSteps
      // 还原字段元数据（必填/默认/选项/说明），按名回填 fieldMeta
      if (as && Array.isArray(as.fields)) as.fields.forEach(f => { if (f && f.name) fm[f.name] = { type: f.type, required: f.required, default: f.default, options: Array.isArray(f.options) ? f.options.join(', ') : (f.options || ''), desc: f.desc } })
      if (as && Array.isArray(as.acceptanceCases)) cs = as.acceptanceCases
    } catch (_) {}
    // bundle 技能（agentic/知识型）：解析整目录 JSON，进文件树编辑模式
    let bundle = null
    try { if (sk.bundle && sk.bundle.trim()) { const b = JSON.parse(sk.bundle); if (b && typeof b === 'object' && Object.keys(b).length) bundle = b } } catch (_) {}
    setBundleFiles(bundle)
    setBundleActive(bundle ? (Object.keys(bundle).find(k => /SKILL\.md$/i.test(k)) || Object.keys(bundle)[0]) : '')
    setEditType(sk.type || '')
    setFieldMeta(fm); setCases(cs); setCaseResults({})
    setEditId(sk.id)
    setName(sk.name || '')
    setDesc(sk.description || ''); descDirty.current = true
    setKeywords((sk.triggerKeywords || []).join(', '))
    setSop(sk.sopContent || ''); sopDirty.current = true
    setDirectNav(sk.navHash || '')
    setSystemId(sk.targetSystemId || '')
    setSteps(st)
    setKindOverride(sk.skillKind || '')   // 载入编辑：沿用已存的读/写判定（作者可再改回「自动」）
    setSkillId(''); setErr(''); setMsg('')
    setTestPara(''); setTestVerdict(null); setTestLines([]); setLines([])
    note(`已载入「${sk.name}」，改完点「保存并上架」；或点「新建技能」从头建`)
  }
  // 退出编辑 / 清空表单，回到新建态
  function newSkill() {
    setEditId(''); setSteps([]); setName(''); setDesc(''); descDirty.current = false; setKeywords(''); setSop(''); setDirectNav(''); setKindOverride(''); setFieldMeta({}); setCases([]); setCaseResults({}); setBundleFiles(null); setBundleActive(''); setEditType('')
    setTestPara(''); setTestVerdict(null); setTestLines([]); setLines([]); setSkillId(''); setErr(''); setMsg('')
    sopDirty.current = false
    try { localStorage.removeItem('iml-fde-draft-skill') } catch (_) {}
    if (searchParams.get('edit')) setSearchParams({}, { replace: true })
  }
  // 下架/上架；下架会脱离所有岗位绑定（后端处理）
  async function setSkillStatus(sk, status) {
    const verb = status === 'DISABLED' ? '下架' : '上架'
    if (status === 'DISABLED' && !confirm(`下架「${sk.name}」？下架后将脱离所有岗位绑定，客户端不再可调用。`)) return
    try { await SkillCenter.setStatus(sk.id, status); await reloadSkills(); note(`已${verb}「${sk.name}」${status === 'DISABLED' ? '（已脱离岗位绑定）' : ''}`) }
    catch (e) { fail(e) }
  }
  async function delSkill(sk) {
    if ((sk.status || 'PUBLISHED') === 'PUBLISHED') { fail(`「${sk.name}」已上架，请先「下架」再删除（下架会脱离岗位绑定）。`); return }
    if (!confirm(`删除技能「${sk.name}」？此操作不可恢复。`)) return
    try { await SkillCenter.remove(sk.id); setSkills(prev => prev.filter(s => s.id !== sk.id)); if (editId === sk.id) newSkill(); note(`已删除「${sk.name}」`) }
    catch (e) { fail(e) }
  }
  const sysName = (id) => { const s = systems.find(x => x.id === id); return s ? s.name : '通用' }
  const openNew = () => { newSkill(); setDrawerOpen(true) }
  const openEdit = (sk) => { loadSkill(sk); setDrawerOpen(true) }
  const closeDrawer = () => setDrawerOpen(false)
  // 按录制重新生成：把可从录制派生的都刷新 —— SOP + 直达路由 + 名称建议（触发词是用户自定义，不动）
  const regenSop = () => {
    if (!steps.length) return fail('当前没有录制步骤，无法按录制生成')
    sopDirty.current = false
    const recNav = deriveNav(steps); if (recNav) setDirectNav(recNav)
    const nm = name.trim() || (sys() ? sys().name + (skillKind === 'read' ? ' 查看技能' : ' 操作技能') : '录制技能')
    if (!name.trim() && sys()) setName(nm)
    setSop(stepsToSop(steps, nm))
    if (!descDirty.current) genDesc(steps, nm)
    note('已按录制重新生成：SOP + 技能描述' + (recNav ? ' + 直达路由' : '') + (!name.trim() ? ' + 技能名称' : ''))
  }
  async function runTest() {
    const d = buildDraft()
    if (!Browser.available()) return setTestErr('技能测试需在桌面端运行')
    if (!d.baseUrl) return setTestErr('该技能未绑定可访问的业务系统地址，无法测试')
    if (!testPara.trim()) return setTestErr('请输入一段话（模拟用户对分身说的需求）')
    setTestBusy(true); setTestErr(''); setTestLines([]); setTestVerdict(null)
    try {
      if (testUnsub.current) testUnsub.current()
      testUnsub.current = Browser.onLine(l => setTestLines(prev => [...prev, l]))
      const r = await Browser.testSkill({ systemId: d.systemId, baseUrl: d.baseUrl, sop: d.sop, fields: d.fields, navHash: d.navHash, steps: (d.steps || []).map(({ _hint, ...s }) => s), paragraph: testPara, adminBaseUrl: getBaseUrl(), headless })
      if (testUnsub.current) { testUnsub.current(); testUnsub.current = null }
      // 自愈成果固化：把智能体定位成功用过的选择器写回步骤指纹（保存后下次回放零模型）
      if (r && r.healed && r.healed.length) setSteps(prev => prev.map((s, i) => { const h = r.healed.find(x => x.index === i); return h ? { ...s, fp: { ...(s.fp || {}), sel: h.sel } } : s }))
      if (!r || r.ok === false) setTestErr((r && r.error) || '测试出错')
      else if (r.loggedIn === false) setTestVerdict({ info: headless ? '无头模式拿不到登录态：请先关掉「无头浏览器」、在弹出窗口登录一次（登录态本地保留），之后再开无头测试。' : '窗口未登录，请在弹出的浏览器登录后重试。' })
      else setTestVerdict({ passed: r.passed, reason: r.reason, fieldValues: r.fieldValues || {}, needInput: r.needInput, result: r.result })
    } catch (e) { setTestErr(e.message || '测试出错') } finally { setTestBusy(false); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }
  // 验收用例：把当前「一句话测试」存为用例，编辑技能后一键回归回放，防改坏
  const addCase = () => { if (!testPara.trim()) return setTestErr('请先在下方输入一段话，再存为验收用例'); setCases(prev => [...prev, { paragraph: testPara.trim() }]); note('已存为验收用例，编辑后可「回归全部」重跑') }
  const removeCase = (i) => { setCases(prev => prev.filter((_, j) => j !== i)); setCaseResults(prev => { const n = { ...prev }; delete n[i]; return n }) }
  async function runRegression() {
    const d = buildDraft()
    if (!Browser.available()) return setTestErr('回归需在桌面端运行')
    if (!d.baseUrl) return setTestErr('该技能未绑定可访问的业务系统地址，无法回归')
    if (!cases.length) return setTestErr('还没有保存的验收用例')
    setRegBusy(true); setTestErr(''); setCaseResults({})
    for (let i = 0; i < cases.length; i++) {
      setCaseResults(prev => ({ ...prev, [i]: { running: true } }))
      try {
        const r = await Browser.testSkill({ systemId: d.systemId, baseUrl: d.baseUrl, sop: d.sop, fields: d.fields, navHash: d.navHash, steps: d.steps, paragraph: cases[i].paragraph, adminBaseUrl: getBaseUrl(), headless })
        const pass = !!(r && r.ok !== false && r.loggedIn !== false && r.passed)
        const reason = r ? (r.loggedIn === false ? '未登录' : (r.needInput ? '需补参数：' + r.needInput.join('、') : (r.reason || ''))) : '无返回'
        setCaseResults(prev => ({ ...prev, [i]: { pass, reason } }))
      } catch (e) { setCaseResults(prev => ({ ...prev, [i]: { pass: false, reason: e.message || '出错' } })) }
    }
    setRegBusy(false)
    if (Browser.available()) Browser.dryRunClose().catch(() => {})
  }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))
  const sys = () => systems.find(s => s.id === systemId)

  useEffect(() => {
    // 只允许在已验证连接的系统上录制（连接器/SKILL 文档 §7.5 预检）
    Promise.all([Admin.integrations(), Connections.list(), SkillCenter.list()]).then(([s, c, sk]) => {
      const verified = new Set((c || []).filter(x => x.status === 'verified' && x.ownerUserId === 'fde-local').map(x => x.systemId))
      const avail = (s || []).filter(x => verified.has(x.id))
      // 若持久化草稿里的 systemId 已不在可用列表（旧系统/已删连接），回退到第一个可用系统，
      // 否则下拉会“显示”首项但实际选中值仍是失效 id，导致录制预检 sys() 找不到系统。
      setSystems(avail); setSystemId(prev => (avail.some(a => a.id === prev) ? prev : (avail[0] ? avail[0].id : '')))
      const list = Array.isArray(sk) ? sk : []
      setSkills(list)
      // 从「系统连接」带 ?edit=ID 跳来 → 直接载入编辑
      const eid = searchParams.get('edit')
      if (eid) { const target = list.find(x => x.id === eid); if (target) { loadSkill(target); setDrawerOpen(true) } }
    }).catch(() => {})
    return () => { if (stepUnsub.current) stepUnsub.current(); if (lineUnsub.current) lineUnsub.current() }
  }, [])

  async function startRec() {
    const s = sys(); if (!s) return fail('请先选择目标业务系统（管理端「业务系统连接」中配置）')
    if (!Browser.available()) return fail('录制需在桌面端运行')
    setBusy('rec'); setErr(''); setRecCount(0); setSkillId('')
    try {
      if (stepUnsub.current) stepUnsub.current()
      stepUnsub.current = Browser.onStep(() => setRecCount(c => c + 1))
      const r = await Browser.recorderStart({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name })
      if (!r || !r.ok) throw new Error((r && r.error) || '无法启动录制（需已装 Chrome）')
      setRecording(true); setSteps([])
      note('录制已开始：在弹出的 Chrome 中登录并完整操作一遍，然后回来点「结束录制」')
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function stopRec() {
    setBusy('rec')
    try {
      const r = await Browser.recorderStop()
      if (stepUnsub.current) { stepUnsub.current(); stepUnsub.current = null }
      setRecording(false)
      // 文本/检索/上传字段默认设为参数（不把录制的测试值焊死）；下拉默认保留录制选中的有效值。
      // 叠加录后「候选参数识别」（结构+规则信号）：高置信(≥0.8,如点击列表行业务数据)自动标参数,
      // 其余挂 _hint 在步骤上出建议角标,由 FDE 逐项定夺——识别只建议,人来定稿。
      const hints = (r && r.paramHints) || []
      const st = ((r && r.steps) || []).map((s, idx) => {
        const wantParam = s.act === 'fill' || s.act === 'search' || s.act === 'upload' || (s.act === 'fxPick' && s.kind === 'object_reference')
        if (wantParam && (s.label || s.value)) {
          // 参数名只用语义标签,**绝不用录制值**(检索词是人名时值会变成参数名/SOP 占位——"昕宇"事故);
          // 检索框的标签常是"高级搜索"这类控件名,换成语义名「检索对象」。
          const searchish = s.act === 'search' || (s.act === 'fxPick' && s.kind === 'object_reference')
          let pn = s.label || ''
          if (!pn || (searchish && /(高级)?(搜索|检索|查询)/.test(pn))) pn = searchish ? '检索对象' : ('字段' + (idx + 1))
          return { ...s, param: pn }
        }
        const h = hints.find(x => x.index === idx)
        if (h && !s.param) {
          // 点击类的参数化(点谁)误伤代价高(泛微菜单曾被误标),一律只出建议角标、由 FDE 采纳
          if (h.confidence >= 0.8 && s.act !== 'click' && s.act !== 'pickOption') return { ...s, param: h.name, _hint: h }
          return { ...s, _hint: h }
        }
        return s
      })
      sopDirty.current = false   // 新录制 → 允许自动重新生成 SOP
      setKindOverride('')        // 新录制 → 读/写回到自动派生
      const recNav = deriveNav(st); if (recNav) setDirectNav(recNav)   // 录到直达路由就回填到常量字段
      setSteps(st)
      const kind = (r && r.skillKind) || deriveKind(st)
      const nm = name || (sys() ? sys().name + (kind === 'read' ? ' 查看技能' : ' 操作技能') : '')
      if (!name && sys()) setName(nm)
      descDirty.current = false   // 新录制 → 允许自动重新生成描述
      if (st.length) genDesc(st, nm)   // 录制结束自动生成「技能描述（供大模型语义匹配）」
      setRecDiag(r?.diag || null)
      note(`录制完成，捕获 ${st.length} 步（${kind === 'read' ? '读取类' : '写入类'}），正在生成技能描述…`)
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function cancelRec() { try { await Browser.recorderCancel() } catch (_) {} if (stepUnsub.current) { stepUnsub.current(); stepUnsub.current = null } setRecording(false) }

  // AI 识别参数（LLM 建议层，与录后结构/规则信号互补）：只建议不定稿，命中步骤挂角标由 FDE 采纳
  async function suggestParams() {
    if (!steps.length) return fail('请先录制')
    setBusy('hint'); setErr('')
    try {
      const r = await Browser.suggestParams({ steps: steps.map(({ _hint, ...s }) => s), sop, adminBaseUrl: getBaseUrl() })
      if (!r || !r.ok) throw new Error((r && r.error) || '识别失败')
      const sugg = r.suggestions || []
      if (!sugg.length) { note('AI 没有发现新的可参数化项'); return }
      setSteps(prev => prev.map((s, i) => {
        const g = sugg.find(x => Number(x.index) === i)
        if (g && !s.param && !s._hint) return { ...s, _hint: { name: String(g.name).slice(0, 16), reason: g.reason || 'AI 判定为业务数据', confidence: 0.7, default: g.default || s.value || '' } }
        return s
      }))
      note(`AI 建议 ${sugg.length} 项参数化，已在对应步骤标出黄色角标，逐项点「采纳」确认`)
    } catch (e) { fail('参数识别失败：' + (e.message || e)) } finally { setBusy('') }
  }

  async function genSop() {
    if (!steps.length) return fail('请先录制')
    setBusy('sop'); setErr('')
    try {
      const r = await Browser.genSop({ adminBaseUrl: getBaseUrl(), name: name || '录制技能', script: readable(steps), fields, engine: 'browser' })
      if (!r || !r.ok) throw new Error((r && r.error) || 'SOP 生成失败')
      sopDirty.current = true   // AI 版 SOP 视为已定，避免被录制自动覆盖
      setSop(r.sop || ''); note('已用 AI 生成 SOP，可编辑')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  // 触发词 AI 建议：据名称/描述/操作脚本让模型给一组精炼触发词（用户说到即命中该技能）
  async function genKeywords() {
    setBusy('kw'); setErr('')
    try {
      const prompt = `为一个企业「岗位分身技能」推荐触发词——用户对分身说到这些词时应命中该技能。\n` +
        `技能名称：${(name || '').trim() || '(未命名)'}\n描述：${(desc || '').trim() || '(无)'}\n` +
        `业务系统：${sys() ? sys().name : '(未指定)'}\n操作脚本：\n${readable(steps) || '(无)'}\n\n` +
        `输出 4-8 个精炼触发词，中文优先，英文逗号分隔，只输出词本身、不要编号/解释/引号。例：客户拜访,拜访录入,拜访反馈,记录拜访`
      const out = await modelChat(prompt)
      const kws = Array.from(new Set((out || '').replace(/[\n、；;]/g, ',').split(/[，,]+/).map(x => x.trim()).filter(Boolean))).slice(0, 10)
      if (kws.length) { setKeywords(kws.join(', ')); note('已生成触发词建议，可编辑增删') }
      else fail('没生成到触发词，可手填')
    } catch (e) { fail('触发词生成失败，可手填') } finally { setBusy('') }
  }

  // SKILL.md 落盘预览：复刻客户端 writeSkillFile 的 frontmatter 格式（name=slug/描述/触发词/角色 + SOP 正文），
  // 让作者上架前看到技能同步到客户端后本地文件长啥样。注意：actionScript/skillKind 等不落盘、运行时现拉。
  function skillMdText() {
    const d = buildDraft()
    const kws = (d.triggerKeywords || []).map(k => `  - ${k}`).join('\n')
    return ['---', `name: ${editId || '（上架后由后端分配 skill-id）'}`, `description: ${d.description || ''}`,
      'trigger_keywords:', kws, 'allowed_roles:', '---', '', d.sop || '（暂无 SOP）'].filter(x => x !== undefined).join('\n')
  }

  async function probe(mode, key, doneMsg) {
    const s = sys(); if (!s) return fail('请先选择目标业务系统')
    setBusy(key); setErr(''); setLines([])
    try {
      if (lineUnsub.current) lineUnsub.current()
      lineUnsub.current = Browser.onLine(l => setLines(prev => [...prev, l]))
      const useNav = steps.length ? navHash : directNav.trim()
      const r = await Browser.dryRun({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name, steps: [], fieldValues: {}, sop: '', adminBaseUrl: getBaseUrl(), mode, navHash: useNav, headless })
      if (lineUnsub.current) { lineUnsub.current(); lineUnsub.current = null }
      if (r && r.loggedIn === false) note('窗口未登录，请在弹出的浏览器登录后重试')
      else note(doneMsg)
    } catch (e) { fail(e) } finally { setBusy(''); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }
  const ariaProbe = () => probe('aria-probe', 'probe', 'ARIA 体检完成，请把日志贴给我')
  const actuateProbe = () => probe('actuate-probe', 'aprobe', '操作体检完成，请把 ①②③ 结果贴给我')
  const schemaProbe = () => probe('schema-probe', 'sprobe', '字段&选项读取完成，照"可选"锁定 SOP 取值')

  async function dryRun(mode, safe = false) {
    const agent = mode === 'agentic-sop'
    if (!agent && !steps.length) return fail('请先录制')
    if (agent && !steps.length && !sop.trim()) return fail('SOP·Agent 直跑：请在 SOP 框粘贴可执行的 SOP（含具体值），并填直达路由')
    const s = sys(); if (!s) return fail('请先选择目标业务系统')
    setBusy(agent ? 'dryAgent' : 'dry'); setErr(''); setLines([])
    try {
      if (lineUnsub.current) lineUnsub.current()
      lineUnsub.current = Browser.onLine(l => setLines(prev => [...prev, l]))
      // 回放引擎按 param 键取值；SOP-Agent 引擎按字段语义名取值（SOP 里用的是 {{语义名}}）
      const fieldValues = {}
      steps.forEach(s2 => { if (s2.param) fieldValues[agent ? (s2.label || s2.param) : s2.param] = s2.value || '' })
      // 有录制步骤用派生 navHash；直跑(无步骤)用手填的直达路由
      const useNav = steps.length ? navHash : directNav.trim()
      const r = await Browser.dryRun({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name, steps: steps.map(({ _hint, ...s2 }) => s2), fieldValues, sop, adminBaseUrl: getBaseUrl(), mode: agent ? 'agentic-sop' : undefined, navHash: useNav, dryRun: safe })
      if (lineUnsub.current) { lineUnsub.current(); lineUnsub.current = null }
      // 自愈成果固化：智能体定位成功用过的选择器写回步骤指纹，下次回放零模型
      if (r && r.healed && r.healed.length) {
        setSteps(prev => prev.map((s2, i) => { const h = r.healed.find(x => x.index === i); return h ? { ...s2, fp: { ...(s2.fp || {}), sel: h.sel } } : s2 }))
      }
      if (r && r.loggedIn === false) note('试运行窗口未登录，请登录后重试')
      else if (!r || r.failedAt >= 0) fail(agent ? `SOP·Agent 未走通：${(r && (r.failLabel || r.error)) || '未完成'}` : `试运行中断于第 ${(r?.failedAt ?? 0) + 1} 步：${(r && (r.failLabel || r.error)) || '未完成'}`)
      else note((safe ? `安全试回放通过：定位验证 ${r.done}/${r.total} 步（写入未执行${r.dryStopAt >= 0 ? '，到提交步自动停' : ''}）` : agent ? `SOP·Agent 走通：模型完成 ${r.done} 步操作` : `试运行通过：${r.done}/${r.total} 步`) + (r.healed && r.healed.length ? `；已固化 ${r.healed.length} 处自愈定位，记得保存` : ''))
    } catch (e) { fail(e) } finally { setBusy(''); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }

  async function submit(publish = true) {
    if (!editId && !steps.length) return fail('请先录制')
    if (!name.trim()) return fail('请填写技能名称')
    if (editId && !isBundle && !steps.length && !sop.trim()) return fail('编辑的技能既无步骤也无 SOP，请先录制或补写 SOP')
    const kws = keywords.split(/[，,\s]+/).map(s => s.trim()).filter(Boolean)
    if (publish && !kws.length) return fail('发布前请填写至少一个触发词——客户端靠它匹配技能，留空会导致技能无法被对话框调用。')
    if (!isBundle && fields.some(f => !f.label || !f.label.trim())) return fail('有参数未填语义名，请在步骤列表中补全后再提交。')
    // AI 指令步上限(成本红线):每步回放烧一次模型会话
    const agentN = steps.filter(s => s.act === 'agent').length
    if (agentN > MAX_AGENT_STEPS) return fail(`AI 指令步 ${agentN} 个，超过上限 ${MAX_AGENT_STEPS}。请把多余的改回确定性步骤或合并后再提交。`)
    if (!isBundle && steps.some(s => s.act === 'agent' && !(s.value || s.label || '').trim())) return fail('有 AI 指令步没写任务描述，请补全（如：在结果列表选择 {{客户名}}）。')
    // 保存卡口(警告+显式确认,不硬阻断):值长得像业务数据却没参数化 → 会被焊死,列出请作者定夺
    if (!isBundle) {
      const unresolved = steps.map((s, i) => ({ s, i })).filter(({ s }) =>
        !s.param && ['fill', 'search'].includes(s.act) && BIZ_VALUE_RES.some(re => re.test(String(s.value || '').trim())))
      if (unresolved.length && !confirm(
        `以下步骤的值看起来是业务数据，当前是「常量」，会被焊死进技能（每次回放原样使用）：\n\n` +
        unresolved.map(({ s, i }) => `第 ${i + 1} 步「${s.label || s.act}」= ${s.value}`).join('\n') +
        `\n\n确定保持固定值提交吗？（取消返回，把它们切成「参数」）`)) return
    }
    const cleanSteps = steps.map(({ _hint, ...rest }) => rest)   // 建议角标是审阅期瞬态,不落库
    const skillName = name.trim()
    const status = publish ? 'PUBLISHED' : 'DRAFT'
    setBusy(publish ? 'submit' : 'draft'); setErr(''); setMsg(''); setSkillId('')
    try {
      if (editId) {
        // 编辑既有技能：走 update（保留 ID，客户端引用不变）。
        // bundle 技能(agentic/知识型)：保留原 type，发 bundle+元数据，绝不碰 actionScript/steps（否则会把它降级成录制型）。
        await SkillCenter.update(editId, isBundle
          ? { name: skillName, description: desc.trim(), triggerKeywords: kws, targetSystemId: systemId,
              type: editType || 'python-sandbox', status, sopContent: sop, skillKind, bundle: JSON.stringify(bundleFiles) }
          : { name: skillName, description: desc.trim(), triggerKeywords: kws, targetSystemId: systemId,
              type: 'playwright', status, sopContent: sop, code: readable(cleanSteps),
              skillKind, navHash, actionScript: JSON.stringify({ version: 2, fields, rawSteps: cleanSteps, acceptanceCases: cases }) })
        await reloadSkills()
        setSkillId(editId)
        setDrawerOpen(false)
        setErr(''); setMsg(`✅ 「${skillName}」已${publish ? '保存并上架' : '存为草稿（未上线）'}（技能 ${editId}）。`)
      } else {
        const res = await SkillCenter.fromRecording({
          name: skillName, description: desc.trim(),
          triggerKeywords: kws,
          targetSystemId: systemId, steps: cleanSteps, fields, engine: 'browser', sop, script: readable(cleanSteps),
          skillKind, navHash, status, acceptanceCases: cases
        })
        const id = res?.id || res?.skill?.id || ''
        // 成功 → 清空表单与草稿，便于继续建下一个；用持久成功提示（不 3 秒消失）
        setSteps([]); setName(''); setDesc(''); descDirty.current = false; setKeywords(''); setSop(''); setDirectNav(''); setKindOverride(''); setFieldMeta({}); setCases([]); setCaseResults({})
        setTestPara(''); setTestVerdict(null); setTestLines([]); setLines([])
        sopDirty.current = false
        try { localStorage.removeItem('iml-fde-draft-skill') } catch (_) {}
        await reloadSkills()
        setSkillId(id)
        setDrawerOpen(false)
        setErr(''); setMsg(`✅ 「${skillName}」已${publish ? '上架到企业技能中心' : '存为草稿（未上线，可在技能列表继续编辑/上架）'}${id ? `（技能 ${id}）` : ''}。`)
      }
    } catch (e) { fail((editId ? '保存失败：' : '提交失败：') + (e.message || e)) } finally { setBusy('') }
  }

  // 主视图统计 + 筛选
  const stat = {
    total: skills.length,
    read: skills.filter(s => s.skillKind === 'read').length,
    write: skills.filter(s => s.skillKind === 'write').length,
    sys: new Set(skills.map(s => s.targetSystemId).filter(Boolean)).size
  }
  const q = query.trim().toLowerCase()
  const filtered = skills.filter(s => {
    if (filterSys && s.targetSystemId !== filterSys) return false
    if (filterKind && (s.skillKind || '') !== filterKind) return false
    if (q) { const hay = (s.name + ' ' + (s.description || '') + ' ' + (s.triggerKeywords || []).join(' ')).toLowerCase(); if (!hay.includes(q)) return false }
    return true
  })
  const pagedSkills = filtered.slice((page - 1) * pageSize, page * pageSize)

  return (
    <>
      <PageHeader title="快速建技能" desc="录制业务操作，炼成可复用的岗位分身技能" actions={<>
        <button onClick={reloadSkills} disabled={!!busy}>刷新</button>
        <button className="primary" onClick={openNew}>＋ 新建技能</button>
      </>} />
      <div className="content grid" style={{ gap: 16 }}>
        {systems.length === 0 && <div className="hint" style={{ background: '#FEF3E2', borderColor: '#FCD9A8', color: '#B45309' }}>没有已验证连接的业务系统。请先到「系统连接」完成本地登录验证，再来录制。</div>}
        {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

        {/* 统计 */}
        <div className="stat-grid">
          <div className="stat"><div className="stat-ic"><Icon name="package" size={18} /></div><div><div className="n">{stat.total}</div><div className="l">技能总数</div></div></div>
          <div className="stat"><div className="stat-ic"><Icon name="check" size={18} /></div><div><div className="n">{stat.read}</div><div className="l">读取类</div></div></div>
          <div className="stat"><div className="stat-ic"><Icon name="spark" size={18} /></div><div><div className="n">{stat.write}</div><div className="l">写入类</div></div></div>
          <div className="stat"><div className="stat-ic"><Icon name="link" size={18} /></div><div><div className="n">{stat.sys}</div><div className="l">关联业务系统</div></div></div>
        </div>

        {/* 搜索 + 筛选 */}
        <div className="card grid" style={{ gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索技能名称 / 描述 / 触发词" style={{ flex: 1, minWidth: 220 }} />
            <div style={{ display: 'flex', gap: 6 }}>
              {[['', '全部类型'], ['read', '读取类'], ['write', '写入类']].map(([k, l]) => (
                <button key={k || 'all'} className={filterKind === k ? 'primary' : ''} style={{ height: 30 }} onClick={() => setFilterKind(k)}>{l}</button>
              ))}
            </div>
          </div>
          {(systems.length > 0 || filterSys) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className={!filterSys ? 'primary' : ''} style={{ height: 28 }} onClick={() => setFilterSys('')}>全部系统</button>
              {systems.map(s => <button key={s.id} className={filterSys === s.id ? 'primary' : ''} style={{ height: 28 }} onClick={() => setFilterSys(s.id)}>{s.name}</button>)}
            </div>
          )}
        </div>

        {/* 技能卡片网格 */}
        {filtered.length === 0
          ? <div className="card"><div className="empty">{skills.length === 0 ? '还没有技能。点右上角「＋ 新建技能」录制并上架第一条。' : '没有匹配的技能，换个搜索/筛选条件试试。'}</div></div>
          : (<>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 14 }}>
              {pagedSkills.map(s => {
                const fc = skillFieldCount(s)
                const kws = s.triggerKeywords || []
                return (
                  <div key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="stat-ic" style={{ width: 34, height: 34 }}><Icon name={s.skillKind === 'read' ? 'check' : 'spark'} size={16} /></div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                        <div className="sec" style={{ fontSize: 11.5 }}>v{s.version || '1.0.0'} · {s.id}</div>
                      </div>
                      <Tag kind={statusOf(s.status).kind}>{statusOf(s.status).label}</Tag>
                      <Tag kind={s.skillKind === 'read' ? 'blue' : 'amber'}>{s.skillKind === 'read' ? '读取' : s.skillKind === 'write' ? '写入' : '操作'}</Tag>
                    </div>
                    {s.description && <div className="sec" style={{ fontSize: 12.5, lineHeight: 1.6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.description}</div>}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Tag kind="gray">{sysName(s.targetSystemId)}</Tag>
                      {s.navHash && <Tag kind="green">直达</Tag>}
                      {kws.slice(0, 3).map(k => <Tag key={k} kind="gray">{k}</Tag>)}
                      {kws.length > 3 && <span className="sec" style={{ fontSize: 12 }}>+{kws.length - 3}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                      <span className="sec" style={{ fontSize: 12, marginRight: 'auto' }}>{fc > 0 ? fc + ' 个参数' : '无参数'}</span>
                      {(s.status || 'PUBLISHED') === 'PUBLISHED'
                        ? <button style={{ height: 28 }} title="下架后脱离岗位绑定、客户端不再可调用" onClick={() => setSkillStatus(s, 'DISABLED')}>下架</button>
                        : <button style={{ height: 28 }} title="重新上架供分身调用（需到岗位专家管理重新装配）" onClick={() => setSkillStatus(s, 'PUBLISHED')}>上架</button>}
                      <button style={{ height: 28 }} onClick={() => openEdit(s)}>编辑</button>
                      <button className="ghost danger" style={{ height: 28 }} disabled={(s.status || 'PUBLISHED') === 'PUBLISHED'} title={(s.status || 'PUBLISHED') === 'PUBLISHED' ? '请先下架再删除' : '删除'} onClick={() => delSkill(s)}>删除</button>
                    </div>
                  </div>
                )
              })}
            </div>
            {filtered.length > 0 && <Pager total={filtered.length} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} unit="个技能" sizes={[12, 24, 48]} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)' }} />}
          </>)}

        {!Browser.available() && <div className="hint">当前为浏览器预览，录制/试运行需在桌面端运行。</div>}
      </div>

      {/* 新建/编辑技能：右侧抽屉 */}
      {drawerOpen && <div className="qs-drawer-mask" onClick={closeDrawer} />}
      <div className={'qs-drawer' + (drawerOpen ? ' open' : '')}>
        <div className="qs-drawer-head">
          <b>{editId ? '编辑技能' : '新建技能'}</b>
          <button className="ghost" onClick={closeDrawer} style={{ fontSize: 18, lineHeight: 1, padding: '2px 8px' }}>×</button>
        </div>
        <div className="qs-drawer-body">
        {editId && <div className="hint" style={{ background: '#EFF6FF', borderColor: '#BFDBFE', color: '#1D4ED8' }}>正在编辑「{name || '（未命名）'}」（ID {editId}）——改完点底部「保存并上架」原地更新并发布，技能 ID/客户端引用不变。</div>}

        {/* bundle 技能（agentic/知识型）：脚本目录编辑器，替代录制 */}
        {isBundle && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <b>脚本目录编辑（{editType === 'knowledge' ? '知识/指南型' : 'agentic'} 技能 · SKILL.md + scripts）</b>
              <Tag kind="gray">{Object.keys(bundleFiles).length} 个文件</Tag>
              <span style={{ flex: 1 }} />
              <button onClick={() => {
                const p = prompt('新文件相对路径（如 scripts/run.py）'); if (!p || !p.trim()) return
                const path = p.trim(); if (bundleFiles[path] != null) return note('该文件已存在')
                setBundleFiles(prev => ({ ...prev, [path]: '' })); setBundleActive(path)
              }}>＋新增文件</button>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ width: 240, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 400 }}>
                {(() => {
                  // 按目录分组、文件只显示 basename，大目录(如 canvas-fonts 几十个字体)默认折叠，避免长同前缀路径淹没 SKILL.md/scripts
                  const groups = {}
                  for (const p of Object.keys(bundleFiles)) { const i = p.lastIndexOf('/'); const dir = i >= 0 ? p.slice(0, i) : ''; (groups[dir] = groups[dir] || []).push(p) }
                  const row = (p, base, indent) => (
                    <div key={p} onClick={() => setBundleActive(p)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', paddingLeft: indent ? 22 : 8, cursor: 'pointer', fontSize: 12, background: p === bundleActive ? 'var(--mint-50,#dcefe7)' : 'transparent', borderLeft: p === bundleActive ? '3px solid #2f9e77' : '3px solid transparent', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{base}</span>
                      <button type="button" className="qs-step-del" title="删除文件" onClick={(e) => { e.stopPropagation(); if (!confirm('删除 ' + p + '？')) return; setBundleFiles(prev => { const n = { ...prev }; delete n[p]; return n }); if (bundleActive === p) setBundleActive('') }}>×</button>
                    </div>
                  )
                  return (<>
                    {(groups[''] || []).sort().map(p => row(p, p, false))}
                    {Object.keys(groups).filter(d => d).sort().map(dir => {
                      const files = groups[dir].sort()
                      const coll = collapsedDirs[dir] ?? (files.length > 6)
                      return (
                        <div key={dir}>
                          <div onClick={() => setCollapsedDirs(prev => ({ ...prev, [dir]: !coll }))} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--sec)', background: 'rgba(0,0,0,0.04)', borderBottom: '1px solid var(--border)' }}>
                            <span style={{ fontSize: 10 }}>{coll ? '▶' : '▼'}</span>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir}>{dir}/</span>
                            <span className="muted" style={{ fontWeight: 400 }}>{files.length}</span>
                          </div>
                          {!coll && files.map(p => row(p, p.slice(dir.length + 1), true))}
                        </div>
                      )
                    })}
                  </>)
                })()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {bundleActive ? (<>
                  <div style={{ fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--sec)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={bundleActive}>📄 {bundleActive}</div>
                  <textarea value={bundleFiles[bundleActive] || ''} onChange={e => patchBundleFile(bundleActive, e.target.value)} spellCheck={false} style={{ width: '100%', height: 340, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.6 }} />
                </>) : <div className="muted" style={{ padding: 20, fontSize: 13 }}>选左侧文件编辑。SKILL.md 是技能手册，scripts/ 下是可执行脚本；字体/素材等大目录已折叠。保存后经安全扫描，HIGH 风险会被拒。</div>}
              </div>
            </div>
          </div>
        )}

        {/* 1. 录制（bundle 技能走上方脚本目录编辑器，不录制） */}
        {!isBundle && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <b style={{ whiteSpace: 'nowrap' }}>1 · 录制操作</b>
            <Tag kind={steps.length ? 'green' : 'gray'}>{steps.length ? `已录制 ${steps.length} 步` : '未录制'}</Tag>
            {steps.length > 0 && <Tag kind={skillKind === 'read' ? 'blue' : 'amber'}>{skillKind === 'read' ? '读取类（打开+抓取，更稳）' : '写入类（确认+回放）'}</Tag>}
            {steps.length > 0 && navHash && <Tag kind="gray">直达 {navHash}</Tag>}
            {fields.length > 0 && <Tag kind="green">{fields.length} 个参数</Tag>}
          </div>
          {/* 录制诊断：门户类（iframe 聚合 / 新窗口打开子系统）操作分散时，直接告诉用户"缺在哪" */}
          {recDiag && (recDiag.iframeSteps > 0 || recDiag.blankLabel > 0 || recDiag.pages > 1) && (
            <div className="hint" style={{ background: '#FFF7ED', borderColor: '#FED7AA', color: '#9A3412', marginBottom: 10 }}>
              录制诊断：捕获原始 {recDiag.rawSteps} 步 → 保留 {recDiag.keptSteps} 步，覆盖 {recDiag.frames} 个页面框架、{recDiag.pages} 个窗口。
              {recDiag.iframeSteps > 0 && <> 其中 <b>{recDiag.iframeSteps} 步来自 iframe 内嵌页面</b>（门户常把子系统嵌在 iframe，这些步骤回放需切入对应框架）。</>}
              {recDiag.blankLabel > 0 && <> 有 <b>{recDiag.blankLabel} 步是无文字的图标/图片元素</b>（已尝试用图标名/alt 兜底命名，若仍为空请在下方步骤里手工补名或改用「连接器动作·API」）。</>}
              {recDiag.pages > 1 && <> 录制期间打开了多个窗口——门户点应用若在<b>新标签页/新窗口</b>打开子系统，请确认关键操作都已在同一浏览器窗口内完成。</>}
            </div>
          )}
          {steps.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, marginBottom: 4 }}>
              <span className="sec">读/写判定</span>
              {[['', '自动'], ['read', '读取'], ['write', '写入']].map(([val, lab]) => (
                <button key={val || 'auto'} type="button" onClick={() => setKindOverride(val)}
                  className={kindOverride === val ? 'primary' : ''} style={{ fontSize: 12, padding: '2px 10px' }}>
                  {lab}{val === '' ? `（现为${deriveKind(steps) === 'read' ? '读取' : '写入'}）` : ''}
                </button>
              ))}
              {skillKind === 'write' && <span className="sec" style={{ fontSize: 11 }}>· 写入类回放前客户端会强制人工确认+签名</span>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="fl" style={{ margin: 0 }}>目标系统</label>
            <select style={{ flex: 1, minWidth: 160 }} value={systemId} onChange={e => setSystemId(e.target.value)} disabled={recording}>
              {systems.length === 0 && <option value="">（无已验证连接的系统）</option>}
              {systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {!recording
              ? <button className="primary" disabled={!!busy} onClick={startRec}>开始录制（真实 Chrome）</button>
              : <>
                <span style={{ color: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#dc2626', display: 'inline-block' }} />录制中 · {recCount} 步</span>
                <button className="primary" disabled={!!busy} onClick={stopRec}>结束录制</button>
                <button disabled={!!busy} onClick={cancelRec}>取消</button>
              </>}
          </div>
          {steps.length > 0 && (
            <div style={{ marginTop: 12, maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 6 }}>
              {steps.map((s, i) => {
                const isFill = FILL_ACTS.includes(s.act)
                const isAgent = s.act === 'agent'
                // 点击类步骤命中"业务数据"信号(列表行/建议角标/已参数化) → 也给参数开关(点谁由运行时参数决定)
                const clickParamable = (s.act === 'click' || s.act === 'pickOption') && (s.repeat || s._hint || s.param)
                const acts = Object.keys(ACT_LABEL).concat(ACT_LABEL[s.act] ? [] : [s.act])
                return (
                  <div key={i} className="qs-step" style={s._hint && !s.param ? { background: '#FFFBEB' } : undefined}>
                    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1 }}>
                      <button type="button" title="上移" disabled={i === 0} onClick={() => moveStep(i, -1)} style={{ border: 'none', background: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? 'var(--border)' : 'var(--sec)', fontSize: 9, padding: 0 }}>▲</button>
                      <button type="button" title="下移" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} style={{ border: 'none', background: 'none', cursor: i === steps.length - 1 ? 'default' : 'pointer', color: i === steps.length - 1 ? 'var(--border)' : 'var(--sec)', fontSize: 9, padding: 0 }}>▼</button>
                    </span>
                    <span className="muted" style={{ width: 16, textAlign: 'right' }}>{i + 1}</span>
                    <select value={s.act} onChange={e => patchStep(i, { act: e.target.value })} title="动作类型" style={{ width: 78, flexShrink: 0, fontSize: 12, padding: '2px 4px' }}>
                      {acts.map(a => <option key={a} value={a}>{ACT_LABEL[a] || a}</option>)}
                    </select>
                    {isAgent ? (
                      // AI 指令步:自然语言任务(可含 {{参数}}),回放时 AI 现场读页面只完成这一步(90s 超时)
                      <input className="qs-field-name" style={{ flex: 1 }} value={s.value || ''} onChange={e => patchStep(i, { value: e.target.value })}
                        placeholder="用一句话描述这步要做什么，如：在结果列表选择 {{客户名}}" title="AI 指令步：回放时 AI 现场读页面完成这一步（只做这一步），适合动态列表/日历等录不稳的交互" />
                    ) : (
                      <input className="qs-field-name" value={s.label || ''} onChange={e => patchStep(i, { label: e.target.value })}
                        placeholder={isFill ? '字段语义名，如 拜访纪要' : '元素文本/标签，如 提交'}
                        title={isFill ? '这个字段叫什么（运行时按它提炼用户的话并弹表单确认）' : '要点/操作的元素文本，回放靠它定位'} />
                    )}
                    {(isFill || clickParamable) && !isAgent ? (
                      <>
                        <button type="button" className={'qs-param-toggle' + (s.param ? ' on' : '')}
                          title={s.param ? '参数：运行时由用户填写' : '常量：回放时原样使用录制值'} onClick={() => toggleParam(i)}>{s.param ? '参数' : '常量'}</button>
                        {s.param
                          ? <span className="sec qs-step-val">运行时填</span>
                          : <input value={s.value || ''} onChange={e => patchStep(i, { value: e.target.value })} placeholder="常量值" style={{ width: 96, flexShrink: 0, fontSize: 12, padding: '2px 6px' }} />}
                      </>
                    ) : !isAgent ? (
                      <input value={s.value || ''} onChange={e => patchStep(i, { value: e.target.value })} placeholder="值（可选）" style={{ width: 96, flexShrink: 0, fontSize: 12, padding: '2px 6px' }} />
                    ) : null}
                    {s._hint && !s.param && (
                      <button type="button" className="tag amber" style={{ cursor: 'pointer', border: '1px solid #FCD9A8' }}
                        title={`建议参数化：${s._hint.reason}。点击采纳（参数名 ${s._hint.name}）`}
                        onClick={() => patchStep(i, { param: s._hint.name })}>建议参数·采纳</button>
                    )}
                    {s.repeat && <span className="tag gray" title={`点击了列表第 ${s.repeat.idx}/${s.repeat.n} 行`}>列表行</span>}
                    {s.inIframe && <span className="tag gray" title={'录自 iframe：' + (s.frameUrl || '')}>iframe</span>}
                    {s.manual && <span className="tag gray" title="手动补的步骤，回放靠语义/标签匹配，请把标签填清楚">手动</span>}
                    {s.nav && <span className="tag green" title={'直达 ' + s.nav}>直达</span>}
                    {!isAgent && s.act !== 'openTab' && (
                      <button type="button" className="qs-step-del" title="改为 AI 指令步：录不稳/录不到的交互降级成一句自然语言，回放时 AI 现场完成（每技能最多 3 步）" style={{ color: '#7C3AED' }}
                        onClick={() => patchStep(i, { act: 'agent', value: `${ACT_LABEL[s.act] || s.act}「${s.label || ''}」${s.param ? `，目标是 {{${s.param}}}` : (s.value ? `，值为「${s.value}」` : '')}`.trim() })}>AI</button>
                    )}
                    <button type="button" className="qs-step-del" title="删除此步" onClick={() => deleteStep(i)}>×</button>
                  </div>
                )
              })}
            </div>
          )}
          {steps.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="ghost" onClick={addStep} title="手动补一步（无录制指纹，回放靠语义匹配，请填清楚标签）">＋ 添加步骤</button>
              <button className="ghost" disabled={busy === 'hint' || !Browser.available()} title="让模型判断哪些录制值是业务数据该参数化（只建议不定稿，逐项采纳）" onClick={suggestParams}>{busy === 'hint' ? '识别中…' : 'AI 识别参数'}</button>
              <button className="ghost" disabled={!!busy || !Browser.available()} title="安全试回放：写入动作只定位验证不执行，走到提交步自动停（录完即验）" onClick={() => dryRun(undefined, true)}>{busy === 'dry' ? '试回放中…' : '安全试回放'}</button>
            </div>
          )}
          {warnings.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {warnings.map((w, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: '#B45309', background: '#FEF3E2', border: '1px solid #FCD9A8', borderRadius: 8, padding: '7px 10px' }}>
                  <span>⚠️</span><span style={{ flex: 1 }}>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        {/* 2. 命名 + SOP */}
        <div className="card grid" style={{ gap: 4 }}>
          <b style={{ marginBottom: 8 }}>2 · 技能信息</b>
          <div className="row" style={{ flexDirection: 'column', gap: 10 }}>
            <div><label className="fl">技能名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="如：客户拜访录入 / 待办查询 / 报销提交" /></div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label className="fl" style={{ margin: 0 }}>触发词（逗号分隔）</label>
                <button className="ghost" disabled={busy === 'kw'} title="据名称/描述/操作让模型推荐触发词" onClick={genKeywords}>{busy === 'kw' ? '生成中…' : 'AI 建议'}</button>
              </div>
              <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="如：客户拜访, 录入（用户说到就触发）" />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label className="fl" style={{ margin: 0 }}>技能描述（供大模型语义匹配 · 录制后自动生成，可编辑）</label>
              <button className="ghost" disabled={descBusy || !steps.length} onClick={() => genDesc(steps, name)}>{descBusy ? '生成中…' : 'AI 生成'}</button>
            </div>
            <textarea rows={2} value={desc} onChange={e => { descDirty.current = true; setDesc(e.target.value) }} placeholder="一句话说明：什么场景触发、对哪个系统、做什么（分身据此语义匹配该技能）" style={{ fontSize: 13 }} />
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="fl">直达路由（技能常量 · 运行时直跳操作页，绕开折叠菜单）{deriveNav(steps) && directNav.trim() === deriveNav(steps).trim() ? '　·　已从录制回填' : ''}</label>
            <input value={directNav} onChange={e => setDirectNav(e.target.value)} placeholder="如 #模块/列表 的路由片段（录制会自动回填，可手改/留空）" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label className="fl" style={{ margin: 0 }}>SOP（录制后自动生成，可编辑；标了参数会同步更新）</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="ghost" disabled={!!(busy || !steps.length)} onClick={regenSop}>按录制重新生成</button>
                <button className="ghost" disabled={!!(busy || !Browser.available() || !steps.length)} title={Browser.available() ? '用模型把操作脚本翻译成业务语言 SOP' : 'AI SOP 需桌面端运行'} onClick={genSop}>{busy === 'sop' ? '生成中…' : 'AI 生成 SOP'}</button>
              </div>
            </div>
            <textarea rows={6} value={sop} onChange={e => { sopDirty.current = true; setSop(e.target.value) }} placeholder="录制后这里会自动生成 SOP；也可手动编辑" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
          </div>
          {fields.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <label className="fl">字段映射（每个参数运行时怎么弹表单收集 / 校验）</label>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 76px 40px 1fr 1.3fr', gap: 6, padding: '6px 8px', fontSize: 11, color: 'var(--sec)', background: 'var(--mint-50,#f6f8f7)' }}>
                  <span>参数（语义名）</span><span>类型</span><span>必填</span><span>默认 / 选项</span><span>说明（提示用户）</span>
                </div>
                {fields.map(f => {
                  const m = fieldMeta[f.name] || {}
                  const type = m.type || f.type || 'text'
                  return (
                    <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '1.1fr 76px 40px 1fr 1.3fr', gap: 6, padding: '5px 8px', alignItems: 'center', borderTop: '1px solid var(--border)', fontSize: 12 }}>
                      <span title={'字段键 ' + f.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label || f.name}</span>
                      <select value={type} onChange={e => setFieldMetaFor(f.name, { type: e.target.value })} style={{ fontSize: 12, padding: '2px 4px' }}>
                        {/* 类型决定客户端确认卡弹什么控件：业务系统里是日期选择器，问用户时也该给日期选择器，
                            而不是让人手敲 2026-07-13。date/number 与原生 <input type> 同名，客户端直接透传。 */}
                        <option value="text">文本</option><option value="textarea">多行文本</option>
                        <option value="date">日期</option><option value="datetime-local">日期时间</option>
                        <option value="number">数字</option>
                        <option value="select">下拉</option><option value="search">检索选择</option>
                      </select>
                      <input type="checkbox" checked={m.required !== false} onChange={e => setFieldMetaFor(f.name, { required: e.target.checked })} style={{ width: 'auto', margin: '0 auto' }} title="是否必填（默认必填）" />
                      <input value={type === 'select' ? (m.options || '') : (m.default || '')} onChange={e => setFieldMetaFor(f.name, type === 'select' ? { options: e.target.value } : { default: e.target.value })} placeholder={type === 'select' ? '选项，逗号分隔' : '默认值（可空）'} style={{ fontSize: 12, padding: '2px 6px' }} />
                      <input value={m.desc || ''} onChange={e => setFieldMetaFor(f.name, { desc: e.target.value })} placeholder="向用户解释这个字段" style={{ fontSize: 12, padding: '2px 6px' }} />
                    </div>
                  )
                })}
              </div>
              <div className="sec" style={{ fontSize: 11, marginTop: 4 }}>参数名与语义名在「1·录制」的步骤里改；此处设运行时表单行为。参数须在 SOP 里以 {'{{名}}'} 引用才会被填。</div>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => setShowMd(v => !v)}>{showMd ? '收起 SKILL.md 预览' : '预览 SKILL.md（同步到客户端后的本地文件）'}</button>
            {showMd && (
              <pre style={{ marginTop: 8, background: 'var(--mint-50, #f6f8f7)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>{skillMdText()}</pre>
            )}
          </div>
        </div>

        {/* 3. 调试与上架 */}
        <div className="card grid" style={{ gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>3 · 调试与上架</b>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--sec)', cursor: 'pointer', marginRight: 4 }} title="开=后台运行不弹浏览器窗口；调试时建议关闭以便观察">
                <input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} style={{ width: 'auto' }} />无头浏览器
              </label>
              <button disabled={!!busy} title="读出表单字段类型 + 下拉真实可选项，照它锁定 SOP 取值" onClick={schemaProbe}>{busy === 'sprobe' ? '读取中…' : '读字段选项'}</button>
              <button disabled={!!(busy || (!steps.length && !sop.trim()))} title="把当前调试中的技能存到本地草稿（不提交后端，「技能测试」页可测）" onClick={saveDraft}>本地暂存</button>
              <button disabled={!!(busy || (!steps.length && !editId))} title="提交到技能中心但设为草稿(DRAFT)——不上线，可稍后在列表上架" onClick={() => submit(false)}>{busy === 'draft' ? '存草稿中…' : '存为草稿'}</button>
              <button className="primary" disabled={!!(busy || (!steps.length && !editId))} onClick={() => submit(true)}>{busy === 'submit' ? (editId ? '保存中…' : '提交中…') : (editId ? '保存并上架' : '提交上架')}</button>
            </div>
          </div>

          {/* 内嵌技能测试：用一段话测整条链路（bundle 技能不走浏览器回放测试，隐藏） */}
          {!isBundle && (
          <div className="qs-test-box">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
              <b style={{ fontSize: 13 }}>用一段话测整条链路</b>
              <span className="muted">提炼字段 → 真实执行 → 通过/失败</span>
              <span style={{ flex: 1 }} />
              <Tag kind={skillKind === 'read' ? 'blue' : 'amber'}>{skillKind === 'read' ? '读取类' : '写入类'}</Tag>
              {(navHash || directNav.trim()) ? <Tag kind="green">直达</Tag> : <Tag kind="gray">无直达</Tag>}
              <Tag kind="gray">{fields.length} 个参数</Tag>
            </div>
            {fields.length > 0 && <div className="sec" style={{ fontSize: 12 }}>参数：{fields.map(f => f.label || f.name).join('、')}</div>}
            {!sop.trim() && <div className="err" style={{ fontSize: 12 }}>当前还没有 SOP，agent 没有执行依据。请先录制或写 SOP。</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea rows={2} value={testPara} onChange={e => setTestPara(e.target.value)} placeholder="像用户那样说一句要分身办的事，例：帮我记一条今天和XX客户的沟通，聊了合作方案，约定下周再回访。" style={{ fontSize: 13, flex: 1, minWidth: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button className="primary" disabled={testBusy} style={{ whiteSpace: 'nowrap' }} onClick={runTest}>{testBusy ? '测试中…' : '发送并测试'}</button>
                <button disabled={testBusy || !testPara.trim()} style={{ whiteSpace: 'nowrap' }} title="把这句话存为验收用例，编辑技能后可一键回归重跑" onClick={addCase}>＋存为用例</button>
              </div>
            </div>
            {cases.length > 0 && (
              <div style={{ marginTop: 4, border: '1px solid var(--border)', borderRadius: 8, padding: '6px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <b style={{ fontSize: 12 }}>验收用例（{cases.length}）</b>
                  <span className="muted" style={{ fontSize: 11 }}>编辑后一键重跑，防改坏</span>
                  <span style={{ flex: 1 }} />
                  <button disabled={regBusy || !Browser.available()} onClick={runRegression}>{regBusy ? '回归中…' : '回归全部'}</button>
                </div>
                {cases.map((c, i) => {
                  const r = caseResults[i]
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ width: 46, flexShrink: 0 }}>{r?.running ? <span className="muted">跑…</span> : r ? (r.pass ? <span className="ok">✅通过</span> : <span className="err">❌失败</span>) : <span className="muted">未跑</span>}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.paragraph + (r?.reason ? '｜' + r.reason : '')}>{c.paragraph}</span>
                      <button type="button" className="qs-step-del" title="删除用例" onClick={() => removeCase(i)}>×</button>
                    </div>
                  )
                })}
              </div>
            )}
            {testErr && <div className="err">{testErr}</div>}
            {testVerdict && (testVerdict.info
              ? <div className="hint">{testVerdict.info}</div>
              : testVerdict.needInput
                ? <div style={{ fontSize: 13, fontWeight: 600, color: '#B45309', background: '#FEF3E2', border: '1px solid #FCD9A8', borderRadius: 8, padding: '8px 12px' }}>🟡 需补充参数：{testVerdict.needInput.join('、')}（已暂停，未操作业务系统）</div>
                : <div className={testVerdict.passed ? 'ok' : 'err'} style={{ fontSize: 13, fontWeight: 600 }}>{testVerdict.passed ? '✅ 链路测试通过' : `❌ 未通过：${testVerdict.reason || '未完成'}`}</div>
            )}
            {testVerdict && testVerdict.fieldValues && Object.keys(testVerdict.fieldValues).length > 0 && (
              <div style={{ fontSize: 12 }}>
                <span className="sec">提炼到的字段：</span>{Object.entries(testVerdict.fieldValues).map(([k, v]) => `${k}=${v || '空'}`).join('｜')}
              </div>
            )}
            {testVerdict && testVerdict.result && (
              <div style={{ fontSize: 12.5, background: 'var(--mint-50)', border: '1px solid var(--mint-100)', borderRadius: 8, padding: '10px 12px', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                <div className="sec" style={{ marginBottom: 4, fontWeight: 600 }}>📋 实际结果</div>{testVerdict.result}
              </div>
            )}
            {testLines.length > 0 && (
              <div style={{ maxHeight: 280, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.75, color: 'var(--sec)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {testLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </div>
          )}

          {lines.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.8, color: 'var(--sec)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              {lines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          {skillId && <div className="ok">✓ 已上架，技能中心 ID：{skillId}</div>}
        </div>
        {!Browser.available() && <div className="hint">当前为浏览器预览，录制/试运行需在桌面端运行。</div>}
        </div>{/* qs-drawer-body */}
      </div>{/* qs-drawer */}
    </>
  )
}
