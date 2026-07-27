// 技能执行层：Docker 沙箱代码执行、agentic bundle 执行（LLM 现场编脚本 + 自修复重试）、
// 语义意图路由与写技能判定。纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import fs from 'fs'
import path from 'path'
import { getAdminBaseUrl, afetch } from './http'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { workspaceDir, collectSessionInputFiles } from './workspace-files'
import { uniqueArtifactName, registerArtifact } from './artifact-index'
import { type SkillDefinition, skillDisplayName } from './skill-store'
import { formatCatalog, buildRouterPrompt, parseRouterOutput } from './skill-router-core'
import type { AgentTaskData } from './agent-types'
import { type SendLog } from './types'

// 「写意图」按钮文案：点击这类按钮会改变业务状态（审批/提交/删除…），须按写操作处理（拦截或确认）。
// 写意图按钮/动作词表（领域语料，随实测补齐）：click 命中即判该技能为「写」，只读模式据此拦截、防无确认写入。
// 打卡/签到类是最易漏判的写——按钮字面「上班打卡」不含"提交/保存"，曾致只读模式下"看考勤"误触打卡技能真打了卡。
export const WRITE_INTENT_LABEL = /同意|通过|批准|审批|核准|提交|确认|确定|保存|删除|移除|清除|新增|添加|录入|创建|发布|上架|下架|归档|驳回|拒绝|退回|撤回|撤销|作废|付款|转账|下单|支付|签收|收货|盖章|签字|生效|发送|发起|打卡|签到|签退|上班卡|下班卡|补卡|外出登记/

// 自定义技能真实执行：解析绑定业务系统// 自定义技能真实执行：解析绑定业务系统 → 语义脚本(DSL)/录制回放/CRM拜访录入/读取抓取/联网检索/知识推理。
// 命中确定路径→AgentResult 早返回;否则把 skillResult/skillPromptHint 回填到 out、返回 null 交后续 LLM 整理。
// 从技能 SOP/代码里解析沙箱需装的纯 Python 包：识别 `packages:`/`pip:`/`# packages:` 行。
export function extractSandboxPackages(text: string): string[] {
  const set = new Set<string>()
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*(?:#|\/\/)?\s*(?:packages|pip|deps|requirements)\s*[:=]\s*(.+)$/i)
    if (m) for (const p of m[1].split(/[,\s]+/)) { const n = p.trim().replace(/^['"]|['"]$/g, ''); if (/^[A-Za-z0-9_.-]{2,40}$/.test(n)) set.add(n) }
  }
  return [...set].slice(0, 10)   // 上限防滥装
}

// 代码执行结果（后端 Docker 沙箱与本地 WASM 沙箱统一形状；engine 标明真实执行平面）。
export interface CodeExecResult { ok: boolean; stdout: string; stderr: string; error?: string; files: { name: string; base64: string }[]; engine: string }

// 走后端 Docker 容器沙箱执行代码型技能：不可信代码在服务器/远程隔离容器里跑，永不落到员工机器，
// 也接触不到凭证/宿主文件。afetch 自动带登录 token。返回 null 表示后端沙箱不可达（无本地降级，如实报错）。
// files：可选，agentic 技能 bundle（相对路径 → base64），后端 tar 上传铺进容器 /work。
export async function execViaBackendSandbox(code: string, packages: string[], files?: Record<string, string>): Promise<CodeExecResult | null> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/sandbox/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, packages, ...(files && Object.keys(files).length ? { files } : {}) }),
      timeoutMs: 240000,   // 必须晚于后端沙箱硬超时（默认 180s，pip 安装计入其窗口）+ 容器创建/产物回传开销，否则后端还在跑、客户端已判死
    })
    if (!r.ok) { swallow(new Error(`sandbox exec HTTP ${r.status}`), 'sandbox-exec'); return null }
    const j: any = await r.json()
    return {
      ok: !!j.ok, stdout: String(j.stdout || ''), stderr: String(j.stderr || ''), error: j.error,
      files: Array.isArray(j.files) ? j.files : [], engine: 'Docker 容器',
    }
  } catch (e) { swallow(e, 'sandbox-exec'); return null }
}

// 代码执行型技能（type=python-sandbox）：只走公司级后端 Docker 容器沙箱（不可信代码永不在员工机器上跑）。
// 后端沙箱不可达时如实报错、绝不降级本地。产物 base64 落工作空间；结果回填 out 交 LLM 如实汇报。
// 零扩展名产物按内容魔数补型：模型偶发 save 时忘带 .pptx（真实事故：产物叫「2026-07-17」，
// 文件卡识别不了类型、双击也打不开）。提示词只能降低概率，落盘兜底才叫治好。
function ensureFileExt(name: string, buf: Buffer): string {
  if (/\.[A-Za-z0-9]{2,5}$/.test(name)) return name
  const head = buf.subarray(0, 8).toString('latin1')
  if (head.startsWith('%PDF')) return name + '.pdf'
  if (head.startsWith('PK')) {   // OOXML 全家都是 zip：按内部目录名分型
    if (buf.includes(Buffer.from('ppt/'))) return name + '.pptx'
    if (buf.includes(Buffer.from('word/'))) return name + '.docx'
    if (buf.includes(Buffer.from('xl/'))) return name + '.xlsx'
    return name + '.zip'
  }
  if (head.charCodeAt(0) === 0x89 && head.slice(1, 4) === 'PNG') return name + '.png'
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return name + '.jpg'
  return name
}

// 把沙箱回传的 base64 产物落到工作空间，返回 {name,sizeBytes}[]（供文件卡展示 + 汇报文案）。
export function saveSandboxFiles(files: { name: string; base64: string }[], source?: string): { name: string; sizeBytes: number }[] {
  const saved: { name: string; sizeBytes: number }[] = []
  for (const f of files) {
    try {
      const buf = Buffer.from(f.base64, 'base64')
      const dir = workspaceDir()
      // 重名防覆盖（两个任务都产 output.docx 时后者不再吃掉前者）+ 产物登记（任务→文件出处索引）
      const name = uniqueArtifactName(dir, ensureFileExt(f.name, buf))
      const absPath = path.join(dir, name)
      fs.writeFileSync(absPath, buf)
      registerArtifact({ name, absPath, sizeBytes: buf.length, source })
      saved.push({ name, sizeBytes: buf.length })
    } catch (e) { swallow(e) }
  }
  return saved
}

// 深度调研引擎技能标记：SKILL.md/SOP 里含此行 → skill-custom 分流到客户端内置调研引擎（deep-research.ts）。
// 定义在本模块（叶子层）供 skill-custom / isSelfFetchingSkill / deep-research 共用，避免环形依赖。
export const DEEP_RESEARCH_MARKER = /IML-ENGINE:\s*deep-research/

// ```chart 图表卡协议说明（renderer 端 dialogue/chart.tsx 本地 ECharts 渲染）。
// 单一来源：取数技能 hint 与联网检索 hint 共用，改协议只改这里。
export const CHART_PROTOCOL_HINT = `最能说明问题的 1-3 组趋势/对比/占比数据，可在正文相应位置用图表呈现：输出 \`\`\`chart 围栏包一个 JSON，形如 {"type":"bar|line|area|pie","title":"标题","x":["类目",...],"series":[{"name":"系列名","data":[数值,...]}],"unit":"单位"}（pie 改用 "data":[{"name":"...","value":数值},...]，不写 x/series）。一张图只用一个量纲（营收与增速这类量纲不同的数据分成两张图，不做双轴）`

// 执行成功后的汇报指令（合成层用），按技能形态分叉：
// - 交付物类：一两句话即可（文件卡自会展示文件名/大小，罗列是噪音）；
// - 自取数分析类（声明了 packages、脚本联网取数）：必须基于 stdout 真实数据产出结构化深度分析。
// 曾把「一两句话简洁汇报」统一套在取数类上，最终回复只剩「一句汇报+文件卡」零分析（603308 实锤）。
export function buildExecReportHint(skl: string, stdout: string, fileLine: string, dataSkill: boolean): string {
  const body = stdout || '(无输出)'
  if (dataSkill) {
    return `【技能 "${skl}" 真实执行结果（联网取数）】\n标准输出（脚本真实取到的数据，是分析的唯一事实来源）：\n"""\n${body.slice(0, 12000)}\n"""\n${fileLine}\n\n本次是**取数分析类**任务，只汇报"已生成文件"等于没干活。请基于上述真实数据写一份**结构化深度分析**：\n- 结论先行：开头先给出最重要的综合判断/发现；\n- 分维度展开：按数据实际覆盖的维度（如行情/财务/估值/资金/风险等，以真实取到的为准）逐层解读，充分引用具体数字；\n- 结构化数字用 markdown 表格呈现；\n- ${CHART_PROTOCOL_HINT}。图表数值必须取 stdout 原值；\n- 判断与展望必须能从上述数据推得，并显式表述为推断；涉及投资/医疗/法律等领域时结尾注明"以上为数据陈述与框架推演，不构成专业建议"；\n- stdout 里标注失败/未返回/缺失的数据项，如实说明未取到，绝不用记忆或常识补数；stdout 中不存在的数字一个都不许出现。\n文件卡会自动展示产物文件，无需罗列文件名/大小/路径。`
  }
  return `【技能 "${skl}" 真实执行结果】\n标准输出：\n"""\n${body.slice(0, 2000)}\n"""\n${fileLine}\n\n请用**一两句话简洁汇报**已生成了什么即可——文件卡会在下方自动展示文件名、大小与「查看/打开位置」入口，你**无需**罗列文件名、文件大小、保存路径、页数等细节，也不要用编号列表逐个交代。绝不编造未产出的内容。`
}

export async function runCodeSkill(skillCode: string, skillSop: string, skl: string, sendLog: SendLog, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }): Promise<void> {
  const pkgs = extractSandboxPackages(skillSop + '\n' + skillCode)
  if (pkgs.length) sendLog('thinking', `准备依赖：${pkgs.join('、')}`)

  sendLog('acting', '在 Docker 容器沙箱中执行技能脚本…')
  const res = await execViaBackendSandbox(skillCode, pkgs)
  if (!res) {
    // 后端沙箱不可达 → 不降级，如实告知（沙箱是公司级集中资源，由管理员配置/运维）
    sendLog('observing', '后端 Docker 沙箱不可达，未执行。')
    out.skillResult = `⚠️ 代码执行沙箱当前不可用，技能「${skl}」未执行。请联系管理员检查沙箱（管理端「沙箱监控」）。`
    out.skillPromptHint = `【技能 "${skl}" 未执行】原因：公司级后端 Docker 沙箱不可达（网络或沙箱服务异常）。请如实告知用户沙箱暂不可用、本次未执行，并建议联系管理员，绝不编造执行结果或产出文件。`
    return
  }

  const savedFiles = saveSandboxFiles(res.files, skl)
  const saved = savedFiles.map(f => f.name)
  out.skillFiles = savedFiles
  if (!res.ok) {
    sendLog('observing', `沙箱执行失败：${res.error}`)
    out.skillResult = `❌ 沙箱执行失败：${res.error}`
    out.skillPromptHint = `【技能 "${skl}" 沙箱执行失败】错误："${res.error}"。${res.stderr ? '\nstderr:\n' + res.stderr.slice(0, 800) : ''}\n请如实告知用户执行失败与原因，绝不编造结果。`
  } else {
    const fileLine = saved.length ? `已生成文件并保存到工作空间：${saved.join('、')}。` : '脚本执行成功，未产出文件。'
    sendLog('completed', `[Docker 沙箱] ${fileLine}`)
    out.skillResult = `🐍 已在 Docker 容器沙箱执行技能「${skl}」。${fileLine}`
    out.skillPromptHint = `${buildExecReportHint(skl, res.stdout, fileLine, pkgs.length > 0)}\n\n【SOP】\n${skillSop}`
  }
}

// ── 语义意图路由（分层路由的③模型意图层）：把技能目录交给模型，按语义选出【一个或多个】技能 ──
// 像主流智能体的工具选择：覆盖无触发词/口语化/复合请求（如"要 Word 报告 + PPT"→ 同时选两个）。
// 先判「产出形态」wants（file=要交付物文件 / action=要操作业务系统 / answer=要对话里的内容），
// answer 一律不走技能——"梳理个大纲/给点思路"期待的是文字回答，即便句中出现 PPT/文档等字眼。
// 返回选中的 skillId 数组（可空）；模型异常静默返回 []（不阻塞主链路）。
export async function routeSkillsByIntent(userText: string, skills: SkillDefinition[], llmConfig: LlmConfig, recentContext?: string): Promise<string[]> {
  if (!skills.length || !(userText || '').trim()) return []
  const catalog = formatCatalog(skills, skillDisplayName)
  const prompt = buildRouterPrompt(userText, catalog, recentContext)   // prompt 单一来源在 skill-router-core（评测脚本共用，零漂移）
  try {
    const outText = await callLlm(prompt, llmConfig, { temperature: 0 })
    const { wants, picked } = parseRouterOutput(outText, skills.map(s => s.id))
    console.log(`[skill-router] user="${userText.slice(0, 60)}" wants=${wants || '?'} raw="${(outText || '').replace(/\s+/g, ' ').slice(0, 160)}" picked=${JSON.stringify(picked)}`)
    return picked
  } catch (e) { swallow(e, 'skill-router') }
  return []
}

// 拉取并缓存技能类型（分层路由④安全闸：判断是否生成类 python-sandbox，仅生成类才参与多技能批量）。
const skillTypeCache = new Map<string, string>()
export async function getSkillType(id: string): Promise<string> {
  if (skillTypeCache.has(id)) return skillTypeCache.get(id)!
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) { const f: any = await r.json(); const t = String(f.type || ''); skillTypeCache.set(id, t); return t }
  } catch (e) { swallow(e, 'skill-type') }
  return ''
}

// 是否「生成交付物」类技能（备料门禁用）：python-sandbox，或**带 bundle 的知识型**——
// 后者同样进沙箱现场生成（如 ppt-master）。曾只认 python-sandbox，knowledge 型带 bundle 的技能
// 照进沙箱却拿不到联网备料，时效类请求(今天的股市…)必然素材为零 → NO_DATA 拒产出。
const skillGenCache = new Map<string, boolean>()
export async function isGenerativeSkill(id: string): Promise<boolean> {
  if (skillGenCache.has(id)) return skillGenCache.get(id)!
  let gen = false
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) {
      const f: any = await r.json()
      const t = String(f.type || '')
      skillTypeCache.set(id, t)   // 顺手喂类型缓存,省一次详情拉取
      gen = t === 'python-sandbox' || (t === 'knowledge' && !!(f.bundle && String(f.bundle).trim().length > 2))
    }
  } catch (e) { swallow(e, 'skill-gen') }
  skillGenCache.set(id, gen)
  return gen
}

// 技能是否「自带取数能力」（声明了沙箱依赖 packages: → 执行容器放开出网、脚本按手册自行联网取数）。
// 编排器据此跳过外部联网备料：备料是给「网络隔离沙箱里与世隔绝」的生成类技能供数的机制；
// 自取数技能再备料，徒增两轮检索延迟，网页转述的二手数字还会混进大纲、与接口一手数据打架。
const skillSelfFetchCache = new Map<string, boolean>()
export async function isSelfFetchingSkill(id: string): Promise<boolean> {
  if (skillSelfFetchCache.has(id)) return skillSelfFetchCache.get(id)!
  let self = false
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) {
      const f: any = await r.json()
      let md = ''
      try { md = String(JSON.parse(String(f.bundle || '{}'))['SKILL.md'] || '') } catch (e) { swallow(e, 'selffetch-bundle') }
      // 深度调研引擎技能自带整套检索循环，同样不需要编排器备料（备料反而慢且与引擎自查重复）
      self = extractSandboxPackages(md + '\n' + String(f.sopContent || '')).length > 0
        || DEEP_RESEARCH_MARKER.test(md + '\n' + String(f.sopContent || ''))
    }
  } catch (e) { swallow(e, 'selffetch') }
  skillSelfFetchCache.set(id, self)
  return self
}

// 判断技能是否为「写入/操作类」（用于编排前置权限闸的预判）：skillKind=write，或动作里含 fill/select，
// 或点击了「同意/提交/删除…」等写意图按钮。与 runCustomSkill 的运行时判定同源，避免只读下静默半执行。
const skillWriteCache = new Map<string, boolean>()
// 技能绑定的目标业务系统 id（供「正确系统的读技能优先于 browse」路由判定）。缓存，读不到返回 ''。
const skillSystemCache = new Map<string, string>()
export async function skillTargetSystem(id: string): Promise<string> {
  if (skillSystemCache.has(id)) return skillSystemCache.get(id)!
  let sys = ''
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) { const f: any = await r.json(); sys = String(f.targetSystemId || '') }
  } catch (e) { swallow(e, 'skill-target-system') }
  skillSystemCache.set(id, sys)
  return sys
}

export async function isWriteSkill(id: string): Promise<boolean> {
  if (skillWriteCache.has(id)) return skillWriteCache.get(id)!
  let isWrite = false
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) {
      const f: any = await r.json()
      if (String(f.skillKind || '') === 'write') isWrite = true
      else if (String(f.skillKind || '') !== 'read') {
        // 无明确标注时按动作推断（与运行时一致）
        const code = String(f.code || '')
        if (/(^|\n)\s*(fill|select|searchSelect|dropdown)\b/i.test(code)) isWrite = true
        else try {
          const p = JSON.parse(String(f.actionScript || '{}'))
          const st: any[] = Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : [])
          isWrite = st.some((s: any) => {
            const a = s && (s.action || s.act)
            if (a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || a === 'agent' || (s && s.fieldName)) return true
            return (a === 'click' || a === 'tap' || a === 'button') && WRITE_INTENT_LABEL.test(String((s && (s.label || s.text)) || ''))
          }) || (Array.isArray(p.fields) && p.fields.length > 0)
        } catch (e) { swallow(e, 'iswrite-parse') }
      }
    }
  } catch (e) { swallow(e, 'iswrite') }
  skillWriteCache.set(id, isWrite)
  return isWrite
}

// ── agentic bundle 技能执行：LLM 读 SKILL.md 生成驱动脚本 → 沙箱执行 → 失败自修复一轮 ──
// 适配 Anthropic 风格技能包（SKILL.md 指导手册 + scripts/**）：没有直接可执行的 code，
// 由模型按手册+用户请求现场编写 Python 驱动脚本，与 bundle 一起送公司级 Docker 沙箱执行。
// 产物写 /out 回传落工作空间；首轮失败把 stderr 喂回模型修复重试一次（轻量 agentic loop）。
const AGENTIC_PRELOADED_PKGS = 'python-docx、openpyxl、pandas、pillow、python-pptx、PyPDF2、matplotlib'

// 取数脚本 stdout 里的「局部取数失败」信号（数据充分性反馈用）。guarded 脚本换源成功的行
// 也可能带这些词（如"东财异常，已走新浪成功"）——宁可多触发一次换源重试（有 sufficiencyRetried
// 单次上限兜底），也不放过「带着缺口交差」。
const PARTIAL_FAIL = /(接口异常|获取失败|请求失败|拉取失败|抓取失败|未能获取|未返回|返回为空|风控|反爬|被封|访问受限|HTTP\s*[45]\d\d|status(?:_code)?\D{0,3}[45]\d\d|Traceback \(most recent call last\)|(?:Connection|Timeout|HTTP|SSL)Error)/

// 超长技能手册「按需选节」（渐进披露）：SKILL.md 超过注入上限时，先按标题切节、让模型按本次
// 请求挑相关章节，再以「导语＋选中章节」拼出节选。此前是硬截前 12k 字符——像 a-stock-data 这类
// 十万字符级手册，截出来基本全是版本日志，端点代码根本进不了提示词，技能等于装了也跑不通。
// 选节失败/切不出节时回退旧行为（硬截前 MD_INJECT_LIMIT 字符）。
const MD_INJECT_LIMIT = 12000
const MD_EXCERPT_LIMIT = 48000   // 选节后的注入上限（导语 + 选中章节）
const MD_EXCERPT_FLOOR = 8000    // 选节结果下限：低于它说明选少/选偏了，按文档顺序补前部章节

export async function selectManualExcerpt(skillMd: string, userText: string, llmConfig: LlmConfig): Promise<string> {
  if (skillMd.length <= MD_INJECT_LIMIT) return skillMd
  type Sec = { title: string; body: string[] }
  const secs: Sec[] = []
  const preamble: string[] = []   // 首个标题前的导语（frontmatter/总览），恒保留
  let cur: Sec | null = null
  let fence = false               // ``` 围栏状态：代码块内的 `# 注释` 不是标题
  for (const ln of skillMd.split('\n')) {
    if (ln.trimStart().startsWith('```')) fence = !fence
    // ⚠️ 必须跳过代码块内的行——曾把 Python 注释 `# === K线数据 ===` 当标题，
    // 手册被切成 208 个碎片、正文代码全从章节里切走，选节只凑得出 2k 空壳。
    if (!fence && /^#{1,3}\s+\S/.test(ln)) { cur = { title: ln.replace(/^#+\s*/, '').trim(), body: [ln] }; secs.push(cur) }
    else if (cur) cur.body.push(ln)
    else preamble.push(ln)
  }
  if (secs.length < 4) return skillMd.slice(0, MD_INJECT_LIMIT)
  let picked: number[] = []
  try {
    const resp = await callLlm(
      `技能手册过长，只能注入与本次请求相关的章节。请从章节目录中选出完成该请求所需的章节序号（包含所需函数/代码所在章节，以及它们依赖的通用工具/客户端/速查章节；宁多选不漏选，最多 10 个）。只输出 JSON 数组，如 [0,3,5]，不要任何解释。\n\n【用户请求】\n${userText.slice(0, 500)}\n\n【章节目录】\n${secs.map((s, i) => `${i}. ${s.title}`).join('\n')}`,
      llmConfig, { temperature: 0 })
    const m = resp.match(/\[[\d,\s]*\]/)
    if (m) picked = [...new Set((JSON.parse(m[0]) as number[]).filter(n => Number.isInteger(n) && n >= 0 && n < secs.length))]
  } catch (e) { swallow(e, 'manual-excerpt') }
  // 组装：导语 + 选中章节。不足下限（选少/选偏/模型失败）→ 按文档顺序补前部章节兜底
  //（技能手册的总览/速查表/通用工具函数按惯例在前部，是最保值的补充内容）。
  const preText = preamble.join('\n').trim().slice(0, 8000)
  const lens = secs.map(s => s.body.join('\n').trim().length + 2)
  const chosen = new Set(picked)
  let total = preText.length + picked.reduce((a, i) => a + lens[i], 0)
  for (let i = 0; i < secs.length && total < MD_EXCERPT_FLOOR; i++) {
    if (!chosen.has(i)) { chosen.add(i); total += lens[i] }
  }
  let excerpt = preText
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const sec = '\n\n' + secs[i].body.join('\n').trim()
    if (excerpt.length + sec.length > MD_EXCERPT_LIMIT) break
    excerpt += sec
  }
  return excerpt
}

function buildAgenticPrompt(skillMd: string, fileList: string[], userText: string, lastError?: string, focusHint?: string, inputFiles?: string[], materials?: string, outline?: string, netPkgs?: string[]): string {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  // 技能声明了沙箱依赖（frontmatter `packages:` 行）→ 本次执行已放开出网并安装这些包：
  // 提示词必须与真实环境一致，否则模型会照「无网络」话术拒写联网取数代码（装了也白装）。
  const envLine = netPkgs && netPkgs.length
    ? `已预装：${AGENTIC_PRELOADED_PKGS}；本次已按技能声明额外安装：${netPkgs.join('、')}，可直接 import。**本次容器可访问公网**：技能手册中的联网取数代码（requests/urllib/socket 直连数据源）可直接运行；除已装依赖外仍禁止调用 pip/subprocess 装别的东西。若任务是取数/查询类：把关键结果用 print 输出成可读摘要（stdout 会回填到答复），并把完整数据落成 /out/ 下的 csv/xlsx 交付物。**本技能自身具备联网取数能力**：【已备素材】为空或与请求不符时，不要按 NO_DATA 放弃，而是按手册写代码直接取数。**取数代码必须严格照抄手册对应端点的完整代码（含字段名/列名/JSON 解析层级），不要凭记忆改写**；某数据源抛异常时先 import traceback; traceback.print_exc() 打印完整堆栈再试备用源；只有所有源都连通但确实返回不了该数据时才 NO_DATA——代码异常（KeyError/AttributeError/IndexError）不是 NO_DATA，宁可让异常抛出非零退出，上层会自动修复重试。`
    : `已预装：${AGENTIC_PRELOADED_PKGS}。默认无网络，不要联网、不要调用 pip/subprocess 装东西。`
  return `你是企业工作分身的技能执行引擎。请阅读技能手册与文件清单，为用户请求编写一段可在 Linux Python 3.12 容器内独立运行的 Python 驱动脚本。\n\n【当前日期】${nowStr}。凡涉及年份/季度/日期（如"季度汇报""本年度"）一律以此为准，不要臆测成往年。\n\n【运行环境】\n- 工作目录 /work，技能 bundle 文件已按清单铺好（如 /work/scripts/...）；如需 import 它们，先 sys.path.insert(0, "/work")。\n- ${envLine}\n- **中文字体已装**：用 pillow/matplotlib 渲染任何中文时，必须加载 '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'（pillow: ImageFont.truetype(该路径, 字号)；matplotlib: rcParams['font.sans-serif']=['WenQuanYi Micro Hei']），严禁用默认字体，否则中文会变方框(□)。\n- 手册中依赖 soffice/pandoc/node 的流程在本环境不可用——改用预装的纯 Python 库实现同等效果（如用 python-docx 直接生成/编辑 .docx，python-pptx 生成 .pptx，openpyxl 生成 .xlsx）。\n- **产物必须写入 /out/ 目录（唯一会回传给用户的位置）**：脚本开头 import os; os.makedirs('/out', exist_ok=True)；保存时用绝对路径（如 doc.save('/out/讯飞介绍.docx')）；**结尾必须 print('OUT_FILES:', os.listdir('/out'))** 自证已产出。文件名用有意义的中文名。\n\n【硬性要求】\n- 本技能是**生成交付物类**（文档/表格/演示/PDF/图/海报）——脚本**必须真的把文件写进 /out/**；只 print 内容而不落文件、或写到别的目录、或 /out/ 为空，都算失败。宁可报错也不要静默不产出。\n- **产物命名要一眼可辨**：以输入文件名（去扩展名）或任务主题为基底、追加变体后缀，如「《原文件名》-A4.docx」「《原文件名》-A3双面.docx」；**严禁 output/result/final/input 这类泛名**。\n- **/out/ 只放新产出的交付物**：绝不把输入文件原样复制进 /out/（用户已有原件）；中间临时文件写 /tmp，不要回传。\n- **只产出属于本技能能力范围（见下方 SKILL.md）的交付物**；即便用户请求里还提到别的格式/其它交付物，也一律不要在本脚本中生成——那些由对应的其它技能负责。\n- 只完成用户请求本身；内容必须来自请求、手册与下方【已备素材】，绝不编造业务数据。\n- **有素材就必须用真素材填进文档**：把【已备素材】里的事实（数值/日期/名称/来源）写进正文与表格，不允许产出「待填充」「暂无数据」「请替换为实际数据」这类占位空壳——那等于没干活。
- **数字采信与日期一致**：数字优先取「权威」级信源；「自媒体」级的数字不采信。任务指向具体日期时，与该日期不符的数据（自媒体复盘常滞后一天）要么弃用、要么显式标注真实日期，**严禁冒充任务当日数据**。\n- **素材确实为空、而请求又依赖外部实时数据时**：不要造一个占位模板文档交差。在脚本里 print 一行 NO_DATA: 缺什么数据、为什么拿不到，然后 sys.exit(1)。宁可如实报缺，也不要交空壳。\n- **素材与请求主题明显不符时同样按 NO_DATA 处理**：如请求"股票行情分析"而素材是大学简介/无关网页——检索可能搜偏了，**绝不拿无关素材硬凑成品**（那比没产出更糟：文档看着完成了、内容全错）。\n- 脚本自足、可直接运行；用 print 输出关键进度与结果摘要。
- **bundle 内若提供排版/工具套件（如 scripts/*kit*.py），必须 sys.path.insert(0,"/work") 后 import 复用其现成函数来组织版面与结构，严禁绕开套件徒手重复实现同类排版**；技能手册若有「运行环境适配」章节，其规则优先级最高、覆盖手册其余流程。\n\n【常见运行时陷阱 · 防御写法（务必遵守，多数首轮报错都出在这里）】\n- 表格（python-docx / python-pptx）：先把要填的数据整理成二维列表 rows，再按 len(rows) 建表或逐行 add_row()；**严禁硬编码行列数、严禁假设模板表格行数够用**；写单元格前确保 (row,col) 落在表格现有行列范围内，不够就先 add_row()。尽量少用合并单元格；必须合并时按左上角单元格寻址。\n- 下标与键：任何 list 下标、dict 取值先判越界/存在（如 if i < len(x) / dict.get(k, 默认值)），不要裸写 x[i] / d[k]。\n- 缺失值：字段可能为空或缺失，统一兜底（空串 / 跳过 / 默认值），别让 None 流进 len()/切片/格式化。\n- 解析：数字/日期/金额用 try/except 兜底，失败就保留原值或置 0，不要让单条 ValueError 中断整篇。\n- 写入前先校验数据非空、并对齐"表头列数 == 每行列数"；宁可跳过某条异常数据并 print 警告，也不要让整脚本崩掉。\n${inputFiles && inputFiles.length ? `\n【用户工作空间输入文件（迭代编辑）】\n已铺至容器 /work/input/ 下：\n${inputFiles.map(f => '- /work/input/' + f).join('\n')}\n若用户请求是在这些文件基础上修改/续写/调整（如\"把刚才那份改一下\"\"第三节换个写法\"），必须先读取对应输入文件（如 python-docx 打开 /work/input/xxx.docx），在其现有内容基础上修改后另存到 /out/（可同名，即新版本）；除非用户明确要求重做，不要无视输入文件从零重建。\n` : ''}${focusHint ? `\n【本次协作分工（务必遵守）】\n${focusHint}\n` : ''}${lastError ? `\n【上一轮执行失败，stderr 如下，请修复后重写完整脚本】\n${lastError.slice(0, 1200)}\n` : ''}\n【技能手册 SKILL.md（节选）】\n${skillMd}\n\n【bundle 文件清单】\n${fileList.join('\n')}${materials ? `\n\n【已备素材（管线在执行前真实取到的数据：企业知识库命中 / 联网检索结果）——这就是文档要写的内容来源，请据此填充正文与表格，不要另行臆造】\n${materials}\n` : ''}${outline ? `\n\n【关键事实与内容大纲（已按素材预提炼——章节/页面组织**必须遵循大纲**：每页对应大纲一条、标题一致、不得漏章；正文与图表中的数字**必须取自关键事实清单原值**，绝不另行编造或改写）】\n${outline}\n` : ''}\n\n【用户请求】\n${userText}\n\n只输出一个 Python 代码块（\`\`\`python ... \`\`\`），不要任何解释。`
}

function extractPyBlock(text: string): string {
  const m = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/)
  return (m ? m[1] : text).trim()
}

export async function runAgenticSkill(bundleRaw: string, skillSop: string, data: AgentTaskData, skl: string, sendLog: SendLog, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }, focusHint?: string, materials?: string): Promise<void> {
  // bundle: {相对路径: 文本内容}（管理端整目录导入落库格式）
  let bundle: Record<string, string> = {}
  try { bundle = JSON.parse(bundleRaw || '{}') } catch (e) { swallow(e, 'agentic-bundle') }
  const skillMd = bundle['SKILL.md'] || skillSop || ''
  // 技能声明的沙箱依赖（SKILL.md frontmatter/正文 `packages:` 行）：随执行送沙箱安装；
  // 网络隔离下申报包会放开容器出网（受后端出网白名单管控）——取数类技能（如 A股行情）靠它联网。
  const netPkgs = extractSandboxPackages(skillMd + '\n' + skillSop)
  if (netPkgs.length) sendLog('thinking', `技能声明沙箱依赖：${netPkgs.join('、')}（执行容器将放开出网）`)
  const fileList = Object.keys(bundle).sort()
  const filesB64: Record<string, string> = {}
  for (const [p, content] of Object.entries(bundle)) filesB64[p] = Buffer.from(String(content), 'utf8').toString('base64')

  // 迭代编辑：把本轮引用/近轮产出的工作空间文件铺进沙箱 /work/input/，脚本可读旧改新
  const inputs = collectSessionInputFiles(data.content, data.history)
  const inputNames: string[] = []
  for (const f of inputs) {
    try {
      filesB64['input/' + f.name] = fs.readFileSync(f.path).toString('base64')
      inputNames.push(f.name)
    } catch (e) { swallow(e, 'agentic-input') }
  }
  if (inputNames.length) sendLog('thinking', `已带上工作空间输入文件（可增量修改）：${inputNames.join('、')}`)

  // 生成类两段式：先拟内容大纲、再按大纲写脚本——直接"素材→成稿"容易结构散、素材利用浅；
  // 大纲让模型先决定"讲什么、什么顺序、每节用哪些事实"，交付物结构与素材利用率都明显更好。
  // 大纲失败不阻断（退回一段式）；迭代修改输入文件的请求跳过（结构已在旧文件里）。
  let outline = ''
  if (materials && materials.length > 400 && !inputNames.length) {
    sendLog('thinking', '先按素材拟内容大纲…')
    try {
      const op = `你是资深内容策划。基于下方素材与用户请求，产出两部分（都不写正文）：\n【关键事实】从素材摘出 8-15 条最重要的真实事实，每条一行：数字/日期/名称 ＋ 一句话说明 ＋ (来源站点)。数值保留原值原单位，不得改写或省略。\n【内容大纲】6-10 个章节/页，每条一行：标题 ＋ 2-4 个要点（要点必须引用上面关键事实，标题即结论）。优先覆盖信息量最大的事实，避免"总结展望"这类空泛凑数章节。\n\n【采信红线（血泪教训，必须遵守）】\n- **信源分级**：素材里每个来源标了信源级别（权威＞专业＞一般＞自媒体）。数字类事实**优先从「权威」「专业」级来源取**，「一般」级可用但同一数字最好有第二来源印证；「自媒体」级（知乎/百家号/公众号/雪球等）只可引用观点/情绪面，其数字一律不采信（除非无任何更高级来源，且必须注明"据自媒体"）。\n- **日期一致性**：任务指向具体日期时（如"今天/7月17日"），先核对每条数据自述的日期——自媒体复盘常滞后一天。与任务日期不符的数据（如前一日收盘数）要么弃用，要么显式标注真实日期（"7月16日数据"），**严禁当作任务当日数据**。曾把 7月16日 的指数写进 7月17日 报告，整份产物作废。\n- **硬数字须有当日正文出处**：指数点位/涨跌幅/成交额/价格这类硬数字，只准取自带【页面发布时间：任务日期(或前后一天)】标注的细读正文；检索结果的**摘要片段里的数字一律不得**用作关键事实（摘要常是旧文缓存）。同一指标多处冲突时，取「页面发布时间＝任务日」的权威正文值并注明数据时点；若没有任何当日正文提供该数字，就在清单里写"未获当日数据"，**宁可缺席，绝不用旧值/摘要值充数**。\n只输出【关键事实】【内容大纲】两个小节，不要任何解释。\n\n【用户请求】\n${data.content.slice(0, 600)}\n\n【素材】\n${materials.slice(0, 9000)}`
      outline = (await callLlm(op, data.llmConfig, { temperature: 0 })).trim().slice(0, 3200)
      if (outline) sendLog('thinking', `📋 内容大纲已拟好：\n${outline}`)
    } catch (e) { swallow(e, 'agentic-outline') }
  }

  // 超长手册先按本次请求选节（渐进披露），避免硬截后只剩开头的版本日志
  const manual = await selectManualExcerpt(skillMd, data.content, data.llmConfig)
  if (manual.length < skillMd.length) sendLog('thinking', `技能手册较长（约 ${Math.round(skillMd.length / 1000)}k 字符），已按本次请求选取相关章节注入（约 ${Math.round(manual.length / 1000)}k）`)

  sendLog('thinking', `已加载技能手册与 ${fileList.length} 个 bundle 文件，正在按手册为本次请求编写执行脚本…`)
  const MAX_ATTEMPTS = 4
  let lastError = ''
  let sufficiencyRetried = false   // 「数据充分性」换源重取只给一次机会：数据源真挂了，重试烧不出数据
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let driver = ''
    try { driver = extractPyBlock(await callLlm(buildAgenticPrompt(manual, fileList, data.content, lastError || undefined, focusHint, inputNames, materials, outline, netPkgs), data.llmConfig, { temperature: 0, longRunning: true })) }
    catch (e) { swallow(e, 'agentic-gen') }
    if (!driver) {
      out.skillResult = `❌ 技能「${skl}」执行失败：模型未能生成有效的执行脚本。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：模型生成驱动脚本失败。请如实告知用户，绝不编造结果。`
      return
    }
    sendLog('acting', attempt === 1 ? '在 Docker 容器沙箱中执行技能脚本…' : '按上一轮问题修复脚本后重试执行…')
    const res = await execViaBackendSandbox(driver, netPkgs, filesB64)
    if (!res) {
      out.skillResult = `⚠️ 代码执行沙箱当前不可用，技能「${skl}」未执行。请联系管理员检查沙箱（管理端「沙箱监控」）。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：公司级后端 Docker 沙箱不可达。请如实告知用户，绝不编造执行结果。`
      return
    }
    // 数据充分性反馈（取数类专属）：脚本跑通 ≠ 数据取全。stdout 出现「接口异常/未返回/风控」等
    // 局部失败信号时，旧逻辑照样按成功收工交差（实锤：EPS/ROE 未返回、资金流向接口异常仍出报告）。
    // 给一次「按手册备用源换源重取」的机会；已重试过或到末轮则带缺口如实交付（汇报指令会要求标注缺失）。
    // 放在落盘之前：半截数据的产物不落工作空间，免得重取成功后留下一对重名副本。
    if (res.ok && netPkgs.length && !sufficiencyRetried && attempt < MAX_ATTEMPTS && PARTIAL_FAIL.test(res.stdout || '')) {
      sufficiencyRetried = true
      const failLines = (res.stdout || '').split('\n').filter(l => PARTIAL_FAIL.test(l)).slice(0, 8).join('\n')
      lastError = `【上一轮脚本已跑通，但 stdout 显示部分数据项取数失败（线索见下）。请保持已成功的数据项取数方案不变，只对失败项查阅手册「备用源/速查」章节换用备用数据源重取；若某项所有源确实都取不到，保留其余数据并在输出中明确标注该项缺失及原因。\n失败线索：\n${failLines.slice(0, 1000)}】`
      sendLog('observing', `脚本跑通但部分数据项取数失败，按手册备用源换源重取一轮…`)
      continue
    }
    const savedFiles = saveSandboxFiles(res.files, skl)
    const saved = savedFiles.map(f => f.name)
    // 素材缺失（脚本主动 print NO_DATA 并退出）→ 这不是脚本 bug，重试多少轮都没用（数据本来就没取到）。
    // 立刻停止自修复循环，如实汇报缺什么数据，绝不交一个「待填充」占位空壳文档。
    const noData = /(^|\n)\s*NO_DATA[:：]/.test(res.stdout || '') || /(^|\n)\s*NO_DATA[:：]/.test(res.stderr || '')
    if (noData) {
      // 取数类技能（声明了沙箱依赖、自身能联网取数）：NO_DATA 常是脚本解析 bug 伪装的「无数据」
      //（真实事故：mootdx 返回列名取错 → KeyError 被脚本包装成"数据源失败"→ NO_DATA 短路了三轮自修复）。
      // 把输出喂回模型修复重试；末轮仍 NO_DATA 才如实报缺。纯生成类（无依赖声明）维持原短路——素材真缺重试无用。
      if (netPkgs.length && attempt < MAX_ATTEMPTS) {
        lastError = `【上一轮脚本以 NO_DATA 结束，但它可能是代码 bug 伪装的——请逐一核对：字段名/列名/JSON 解析层级是否与手册代码完全一致（严格照抄，不要凭记忆改写）；异常处打印完整 traceback。修复后重试真实取数。上一轮输出：】\n${(((res.stdout || '') + '\n' + (res.stderr || '')).trim()).slice(0, 1200)}`
        sendLog('observing', `第 ${attempt} 轮报「无数据」，疑似脚本解析问题而非真无数据，按手册修复后重试…`)
        continue
      }
      const why = ((res.stdout || '') + '\n' + (res.stderr || '')).split('\n')
        .find(l => /NO_DATA[:：]/.test(l))?.replace(/.*NO_DATA[:：]\s*/, '').trim() || '缺少生成所需的数据'
      sendLog('completed', `[Docker 沙箱·agentic] 素材不足，未生成文件：${why}`)
      out.skillResult = `⚠️ 技能「${skl}」未生成文件：${why}`
      out.skillPromptHint = `【技能 "${skl}" 未产出文件——素材不足】原因：${why}\n请如实告诉用户"没拿到生成所需的数据，所以没有产出文件"，说明缺的是什么、可以怎么补（例如开启联网检索、把数据贴给我、或指定知识库文档）。**绝不能声称已生成文件，也绝不编造业务数据。**`
      return
    }
    // 成功且产出文件 → 收工
    if (res.ok && saved.length > 0) {
      out.skillFiles = savedFiles
      const fileLine = `已生成文件并保存到工作空间：${saved.join('、')}。`
      sendLog('completed', `[Docker 沙箱·agentic] ${fileLine}`)
      out.skillResult = `🤖 已按技能手册「${skl}」现场编写并执行脚本。${fileLine}`
      out.skillPromptHint = buildExecReportHint(skl, res.stdout, fileLine, netPkgs.length > 0)
      return
    }
    // 成功但 /out/ 为空 → 大概率没把产物写到 /out/：当软失败，带纠正提示重试；最后一轮仍空才如实报“未产出”
    if (res.ok && saved.length === 0) {
      if (attempt < MAX_ATTEMPTS) {
        lastError = `【上一轮脚本执行成功(exit 0) 但 /out/ 目录为空——你没有把产物文件真正保存到 /out/】。本技能必须产出文件。请修正：① import os; os.makedirs('/out', exist_ok=True)；② 用绝对路径保存（如 doc.save('/out/xxx.docx') / wb.save('/out/xxx.xlsx') / prs.save('/out/xxx.pptx')），不要保存到 /work 或当前目录；③ 结尾 print('OUT_FILES:', os.listdir('/out')) 自证。上一轮 stdout：\n${(res.stdout || '(无输出)').slice(0, 800)}`
        sendLog('observing', `第 ${attempt} 轮执行成功但未产出文件，补充"必须写入 /out/"后重试…`)
        continue
      }
      sendLog('completed', `[Docker 沙箱·agentic] 多轮执行后仍未产出文件。`)
      out.skillResult = `⚠️ 技能「${skl}」脚本多轮执行成功但始终未产出文件。`
      out.skillPromptHint = `【技能 "${skl}" 未产出文件】脚本执行成功但 /out/ 始终为空（模型未把产物写入 /out/）。请如实告知用户"本次未能生成文件、建议重试或换个说法"，绝不编造已生成的文件。stdout：\n"""\n${(res.stdout || '(无输出)').slice(0, 800)}\n"""`
      return
    }
    // 执行报错 → 带 stderr 重试。完整 stderr 只喂回模型自愈；主执行流不刷整段 traceback（吓人且无信息量），
    // 只报一句简明原因（取 traceback 末行的异常摘要，如 "IndexError: ..."）。
    lastError = res.stderr || res.error || '未知错误'
    const cause = (lastError.trim().split('\n').filter(Boolean).pop() || '未知错误').slice(0, 120)
    if (attempt < MAX_ATTEMPTS) {
      sendLog('acting', attempt === 1
        ? `首轮脚本有个小问题（${cause}），正在按报错自动修正后重试…`
        : `第 ${attempt} 轮仍有小问题（${cause}），继续自动修正…`)
    } else {
      sendLog('observing', `脚本 ${MAX_ATTEMPTS} 轮均未通过：${cause}`)
    }
  }
  out.skillResult = `❌ 技能「${skl}」执行失败（已自动修复重试 ${MAX_ATTEMPTS - 1} 次仍未成功）。`
  out.skillPromptHint = `【技能 "${skl}" 执行失败】${MAX_ATTEMPTS} 轮均失败，最后错误：\n${lastError.slice(0, 800)}\n请如实告知用户失败与原因，绝不编造结果。`
}
