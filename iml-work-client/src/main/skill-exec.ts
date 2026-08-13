// 技能执行层：Docker 沙箱代码执行、agentic bundle 执行（LLM 现场编脚本 + 自修复重试）、
// 语义意图路由与写技能判定。纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import fs from 'fs'
import path from 'path'
import { getAdminBaseUrl, afetch } from './http'
import { getSandboxMode, execViaLocalSandbox } from './sandbox-local'
import { type LlmConfig, callLlm, tierModel, resolvePurposeModel } from './llm'
import { generateWithContinuation } from './gen-continuation'
import { configGet } from './db'
import { swallow } from './util'
import { convArtifactDir, collectSessionInputFiles } from './workspace-files'
import { currentRun } from './automation-runtime'
import { uniqueArtifactName, registerArtifact } from './artifact-index'
import { type SkillDefinition, skillDisplayName } from './skill-store'
import { formatCatalog, buildRouterPrompt, parseRouterOutput } from './skill-router-core'
import type { AgentTaskData, SkillExecOut } from './agent-types'
import { type SendLog } from './types'
import { API } from './api-paths'

// 「写意图」按钮文案：点击这类按钮会改变业务状态（审批/提交/删除…），须按写操作处理（拦截或确认）。
// 词表单一来源已收敛到 write-intent-core.ts（体检 P1-2：曾与 agent-browse 各一份互相漂移）——此处仅转发导出。
export { WRITE_INTENT_LABEL } from './write-intent-core'
import { WRITE_INTENT_LABEL } from './write-intent-core'

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
// 客户端 HTTP 等待上限 = 后端下发的沙箱硬超时 + 60s 余量（容器创建/产物回传开销）。
// 曾是客户端写死 240s 的注释约定——管理端把超时调到 240s+ 即重现"后端还在跑、客户端已判死"（体检 P2-14）。
// status 拉不到时兜底 240s（与后端默认 180s + 余量兼容）；60s 缓存避免每次执行都多打一趟。
let sandboxTimeoutCache: { ms: number; at: number } | null = null
async function sandboxExecTimeoutMs(): Promise<number> {
  const FALLBACK = 240000
  if (sandboxTimeoutCache && Date.now() - sandboxTimeoutCache.at < 60000) return sandboxTimeoutCache.ms
  try {
    const r = await afetch(`${getAdminBaseUrl()}${API.sandbox.execStatus}`, { timeoutMs: 8000 })
    if (r.ok) {
      const j: any = await r.json()
      const sec = Number(j?.timeoutSeconds)
      if (Number.isFinite(sec) && sec > 0) {
        sandboxTimeoutCache = { ms: (sec + 60) * 1000, at: Date.now() }
        return sandboxTimeoutCache.ms
      }
    }
  } catch (e) { swallow(e, 'sandbox-timeout-cfg') }
  return FALLBACK
}

// files：可选，agentic 技能 bundle（相对路径 → base64），后端 tar 上传铺进容器 /work。
// 执行位置由设置「安全沙箱」切换：cloud=公司级后端容器（默认）；local=本机 Docker 跑同一镜像
//（数据不出机、离线可用；镜像/限额/一次性容器语义与云端同构）。本地不可用时自动回落云端。
export async function execViaBackendSandbox(code: string, packages: string[], files?: Record<string, string>): Promise<CodeExecResult | null> {
  if (getSandboxMode() === 'local') {
    const local = await execViaLocalSandbox(code, packages, files)
    if (local) return local
    console.warn('[sandbox] 本地沙箱不可用（Docker 未就绪或镜像缺失），本次回落云端执行')
  }
  try {
    const r = await afetch(`${getAdminBaseUrl()}${API.sandbox.exec}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, packages, ...(files && Object.keys(files).length ? { files } : {}) }),
      timeoutMs: await sandboxExecTimeoutMs(),
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
      // 产物归档到会话子目录（素材仍在根目录，见 convArtifactDir 注释）
      const dir = convArtifactDir(currentRun()?.runId || '')
      // 重名防覆盖（两个任务都产 output.docx 时后者不再吃掉前者）+ 产物登记（任务→文件出处索引）
      const name = uniqueArtifactName(dir, ensureFileExt(f.name, buf))
      const absPath = path.join(dir, name)
      fs.writeFileSync(absPath, buf)
      registerArtifact({ name, absPath, sizeBytes: buf.length, source })
      saved.push({ name, sizeBytes: buf.length })
    } catch (e) { swallow(e, 'save-sandbox-files') }
  }
  return saved
}

// 深度调研引擎技能标记：SKILL.md/SOP 里含此行 → skill-custom 分流到客户端内置调研引擎（deep-research.ts）。
// 定义在本模块（叶子层）供 skill-custom / isSelfFetchingSkill / deep-research 共用，避免环形依赖。
export const DEEP_RESEARCH_MARKER = /IML-ENGINE:\s*deep-research/
// 图片/视频生成引擎的标记定义在 media-gen（引擎所在处），这里转引以便备料判定共用。
import { IMAGE_GEN_MARKER, VIDEO_GEN_MARKER } from './media-gen'

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

export async function runCodeSkill(skillCode: string, skillSop: string, skl: string, sendLog: SendLog, out: SkillExecOut): Promise<void> {
  const pkgs = extractSandboxPackages(skillSop + '\n' + skillCode)
  if (pkgs.length) sendLog('thinking', `准备依赖：${pkgs.join('、')}`)

  sendLog('acting', '在 Docker 容器沙箱中执行技能脚本…')
  const res = await execViaBackendSandbox(skillCode, pkgs)
  if (!res) {
    // 后端沙箱不可达 → 不降级，如实告知（沙箱是公司级集中资源，由管理员配置/运维）
    sendLog('observing', '后端 Docker 沙箱不可达，未执行。')
    out.skillOk = false
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
    out.skillOk = true
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

// 技能的「自带取数」画像（一次详情拉取算出两个判定，共用缓存）：
// - self：自带联网检索/取数/生成能力（备料门禁与"收起公网检索"用——这些技能不需要外部备料。
//   备料是给「网络隔离沙箱里与世隔绝」的生成类技能供数的机制；自取数技能再备料，徒增两轮检索
//   延迟，网页转述的二手数字还会混进大纲、与接口一手数据打架）；
// - data：其中的**数据检索引擎**（声明沙箱依赖的取数技能、深度调研）——「单任务单数据引擎」纪律
//   只管这一类；图片/视频生成虽也算 self（输入是一句提示词，不需要备料），但常作为组合任务的
//   后段（调研完配图），不受该纪律限制。
const skillFetchCache = new Map<string, { self: boolean; data: boolean }>()
async function skillFetchProfile(id: string): Promise<{ self: boolean; data: boolean }> {
  if (skillFetchCache.has(id)) return skillFetchCache.get(id)!
  let out = { self: false, data: false }
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) {
      const f: any = await r.json()
      let md = ''
      try { md = String(JSON.parse(String(f.bundle || '{}'))['SKILL.md'] || '') } catch (e) { swallow(e, 'selffetch-bundle') }
      const text = md + '\n' + String(f.sopContent || '')
      const data = extractSandboxPackages(text).length > 0 || DEEP_RESEARCH_MARKER.test(text)
      out = { self: data || IMAGE_GEN_MARKER.test(text) || VIDEO_GEN_MARKER.test(text), data }
    }
  } catch (e) { swallow(e, 'selffetch') }
  skillFetchCache.set(id, out)
  return out
}
export async function isSelfFetchingSkill(id: string): Promise<boolean> { return (await skillFetchProfile(id)).self }
export async function isDataFetchSkill(id: string): Promise<boolean> { return (await skillFetchProfile(id)).data }

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

/**
 * 驱动脚本生成（含手册选节）的模型档。写脚本的本质是「严格照抄手册代码组装」，不需要深思考——
 * 重思考模型在这一步先思考数万字才吐代码：单轮 4 分钟起、思考还会吃掉输出预算把代码拦腰截断
 * （2026-08-08 a-stock 实锤：4 轮生成烧掉 ~11 分钟，占整次执行 848s 的八成，首轮 249s 且被截断）。
 * 与 summaryCfg/subagentCfg 同一取舍：高频、不吃推理的活下沉快档。
 * 取值：① config 键 `llm-script-model` 显式覆盖（LlmTab 高级设置同类）；② 网关模式发 corp-default
 * 别名（网关按标准档路由，未配通道 fail-open 回默认池，绝不打挂）；③ 自配模式取档位映射 standard
 * （可能是 providerId::model 引用，经 resolvePurposeModel 解析）；④ 都没有：跟随会话模型。
 * 质量兜底：生成后仍有 4 轮沙箱自修复循环，快档写错了会带着报错重写——比慢档一次写对更省墙钟。
 */
export function scriptGenCfg(cfg: LlmConfig): LlmConfig {
  const m = (configGet('llm-script-model') || '').trim()
  if (m && m !== cfg.modelName) return resolvePurposeModel(cfg, m)
  if ((cfg.mode || 'direct') === 'proxy') return { ...cfg, modelName: 'corp-default' }
  const mapped = tierModel('standard')
  return mapped ? resolvePurposeModel(cfg, mapped) : cfg
}

// 取数脚本 stdout 里的「局部取数失败」信号（数据充分性反馈用）。
// 主通道是**结构化前缀** `PARTIAL_FAIL: <项>—<原因>`（与 NO_DATA: 同构，运行时 prompt 统一注入约定，
// 语言无关）；中文词表仅作兜底——曾是唯一判据，英文脚本打 `failed to fetch xxx, skip` 永不触发换源，
// 带着缺口照常交差（体检 P2-12）。兜底词表的触发在使用处收紧为「命中行不含成功字样」：
// guarded 脚本换源成功的行也带兜底词（如"东财异常，已走新浪成功"），那是自愈成功的叙述，
// 曾据此白烧一轮全量重跑（重试轮见 runAgenticSkill 的 SELF_HEALED 剔除）。
const PARTIAL_SIGNAL = /(^|\n)\s*PARTIAL_FAIL[:：]/
const PARTIAL_FAIL = /(^|\n)\s*PARTIAL_FAIL[:：]|(接口异常|获取失败|请求失败|拉取失败|抓取失败|未能获取|未返回|返回为空|风控|反爬|被封|访问受限|HTTP\s*[45]\d\d|status(?:_code)?\D{0,3}[45]\d\d|Traceback \(most recent call last\)|(?:Connection|Timeout|HTTP|SSL)Error|failed to (fetch|get|retrieve|load)|fetch failed|request failed)/i

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
  // 纪律章节**恒选**：作者在标题里标了「必读/重要/防封/铁律…」就是在告诉工具"没有它脚本必挂"，
  // 而按请求相关性选节恰恰会漏掉它们——实测 a-stock 的「东财防封（重要，先读）」「mootdx 客户端（必读）」
  // 双双落选：脚本裸怼被风控的接口 4 轮、mootdx 无初始化取回空数据，两类失败同一个根。
  const MUST_INCLUDE = /必读|重要|铁律|防封|速查|优先级|prerequisites|运行环境适配/i
  secs.forEach((sec, i) => { if (MUST_INCLUDE.test(sec.title)) chosen.add(i) })
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

/**
 * 脚本编写的流式进度快照（执行详情里的默认折叠进度框，约定见 shared/stream-log.ts）。
 * 思考与正文分区展示；只在框里展示，不参与任何解析，纯观感。
 */
function streamBoxText(think: string, code: string): string {
  const parts: string[] = []
  if (think) parts.push(`〔思考〕\n${think}`)
  if (code) parts.push(`〔脚本〕\n${code}`)
  return parts.join('\n\n')
}

function buildAgenticPrompt(skillMd: string, fileList: string[], userText: string, lastError?: string, focusHint?: string, inputFiles?: string[], materials?: string, outline?: string, netPkgs?: string[], guide?: boolean): string {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  // 技能声明了沙箱依赖（frontmatter `packages:` 行）→ 本次执行已放开出网并安装这些包：
  // 提示词必须与真实环境一致，否则模型会照「无网络」话术拒写联网取数代码（装了也白装）。
  const envLine = netPkgs && netPkgs.length
    ? `已预装：${AGENTIC_PRELOADED_PKGS}；本次已按技能声明额外安装：${netPkgs.join('、')}，可直接 import。**本次容器可访问公网**：技能手册中的联网取数代码（requests/urllib/socket 直连数据源）可直接运行；除已装依赖外仍禁止调用 pip/subprocess 装别的东西。若任务是取数/查询类：把关键结果用 print 输出成可读摘要（stdout 会回填到答复），并把完整数据落成 /out/ 下的 csv/xlsx 交付物。**本技能自身具备联网取数能力**：【已备素材】为空或与请求不符时，不要按 NO_DATA 放弃，而是按手册写代码直接取数。**取数代码必须严格照抄手册对应端点的完整代码（含字段名/列名/JSON 解析层级），不要凭记忆改写**；某数据源抛异常时先 import traceback; traceback.print_exc() 打印完整堆栈再试备用源；只有所有源都连通但确实返回不了该数据时才 NO_DATA——代码异常（KeyError/AttributeError/IndexError）不是 NO_DATA，宁可让异常抛出非零退出，上层会自动修复重试。`
    : `已预装：${AGENTIC_PRELOADED_PKGS}。默认无网络，不要联网、不要调用 pip/subprocess 装东西。`
  return `你是企业工作分身的技能执行引擎。请阅读技能手册与文件清单，为用户请求编写一段可在 Linux Python 3.12 容器内独立运行的 Python 驱动脚本。\n\n【当前日期】${nowStr}。凡涉及年份/季度/日期（如"季度汇报""本年度"）一律以此为准，不要臆测成往年。\n\n【运行环境】\n- 工作目录 /work，技能 bundle 文件已按清单铺好（如 /work/scripts/...）；如需 import 它们，先 sys.path.insert(0, "/work")。\n- ${envLine}\n- **中文字体已装**：用 pillow/matplotlib 渲染任何中文时，必须加载 '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'（pillow: ImageFont.truetype(该路径, 字号)；matplotlib: rcParams['font.sans-serif']=['WenQuanYi Micro Hei']），严禁用默认字体，否则中文会变方框(□)。\n- 手册中依赖 soffice/pandoc/node 的流程在本环境不可用——改用预装的纯 Python 库实现同等效果（如用 python-docx 直接生成/编辑 .docx，python-pptx 生成 .pptx，openpyxl 生成 .xlsx）。\n- **产物必须写入 /out/ 目录（唯一会回传给用户的位置）**：脚本开头 import os; os.makedirs('/out', exist_ok=True)；保存时用绝对路径（如 doc.save('/out/讯飞介绍.docx')）；**结尾必须 print('OUT_FILES:', os.listdir('/out'))** 自证已产出。文件名用有意义的中文名。\n\n【硬性要求】\n- 本技能是**生成交付物类**（文档/表格/演示/PDF/图/海报）——脚本**必须真的把文件写进 /out/**；只 print 内容而不落文件、或写到别的目录、或 /out/ 为空，都算失败。宁可报错也不要静默不产出。\n- **产物命名要一眼可辨**：以输入文件名（去扩展名）或任务主题为基底、追加变体后缀，如「《原文件名》-A4.docx」「《原文件名》-A3双面.docx」；**严禁 output/result/final/input 这类泛名**。\n- **/out/ 只放新产出的交付物**：绝不把输入文件原样复制进 /out/（用户已有原件）；中间临时文件写 /tmp，不要回传。\n- **只产出属于本技能能力范围（见下方 SKILL.md）的交付物**；即便用户请求里还提到别的格式/其它交付物，也一律不要在本脚本中生成——那些由对应的其它技能负责。\n- 只完成用户请求本身；内容必须来自请求、手册与下方【已备素材】，绝不编造业务数据。\n- **有素材就必须用真素材填进文档**：把【已备素材】里的事实（数值/日期/名称/来源）写进正文与表格，不允许产出「待填充」「暂无数据」「请替换为实际数据」这类占位空壳——那等于没干活。
- **数字采信与日期一致**：数字优先取「权威」级信源；「自媒体」级的数字不采信。任务指向具体日期时，与该日期不符的数据（自媒体复盘常滞后一天）要么弃用、要么显式标注真实日期，**严禁冒充任务当日数据**。\n- **素材确实为空、而请求又依赖外部实时数据时**：不要造一个占位模板文档交差。在脚本里 print 一行 NO_DATA: 缺什么数据、为什么拿不到，然后 sys.exit(1)。宁可如实报缺，也不要交空壳。\n- **部分数据项取不到、但其余成功时**：对每个失败项 print 一行 \`PARTIAL_FAIL: <数据项>—<原因>\`（不要退出，继续完成其余项）——系统会据此自动按手册备用源换源重取，绝不静默跳过失败项。\n- **素材与请求主题明显不符时同样按 NO_DATA 处理**：如请求"股票行情分析"而素材是大学简介/无关网页——检索可能搜偏了，**绝不拿无关素材硬凑成品**（那比没产出更糟：文档看着完成了、内容全错）。\n- **整段照抄手册函数，连同其单位换算与字段坑**：手册代码注释里的坑（价格是×1000整数、金额单位是元、字段错位要跳过等）全是实测踩过的，**严禁自写"等价"解析**——自写解析是「价格差千倍/字段张冠李戴」这类脏数据的头号来源，脚本看着跑通了其实数据全错。
${guide
    ? '- **设计完成度优先（本技能为规范/指南类）**：交付物必须把手册规范做足（完整的配色/字体/版式体系、真实文案、细节打磨），不要为省篇幅牺牲设计质量；输出超长会自动分段续写，无需自我压缩。但脚本骨架仍要简单：Python 只做「把内容写入文件」这一件事，复杂度留给交付物本身。'
    : '- **脚本保持精简（防截断，取数类尤其）**：每个数据项首轮只写手册标注的**首选数据源**这一条取数路径，绝不预写多层备用源分支——失败项系统会带着失败线索自动安排重试，届时再按手册换源；删繁就简（无关打印/装饰性注释都不要），输出超长被截断 = 整轮作废。'}\n- 脚本自足、可直接运行；用 print 输出关键进度与结果摘要。
- **bundle 内若提供排版/工具套件（如 scripts/*kit*.py），必须 sys.path.insert(0,"/work") 后 import 复用其现成函数来组织版面与结构，严禁绕开套件徒手重复实现同类排版**；技能手册若有「运行环境适配」章节，其规则优先级最高、覆盖手册其余流程。\n\n【常见运行时陷阱 · 防御写法（务必遵守，多数首轮报错都出在这里）】\n- 表格（python-docx / python-pptx）：先把要填的数据整理成二维列表 rows，再按 len(rows) 建表或逐行 add_row()；**严禁硬编码行列数、严禁假设模板表格行数够用**；写单元格前确保 (row,col) 落在表格现有行列范围内，不够就先 add_row()。尽量少用合并单元格；必须合并时按左上角单元格寻址。\n- 下标与键：任何 list 下标、dict 取值先判越界/存在（如 if i < len(x) / dict.get(k, 默认值)），不要裸写 x[i] / d[k]。\n- 缺失值：字段可能为空或缺失，统一兜底（空串 / 跳过 / 默认值），别让 None 流进 len()/切片/格式化。\n- 解析：数字/日期/金额用 try/except 兜底，失败就保留原值或置 0，不要让单条 ValueError 中断整篇。\n- 写入前先校验数据非空、并对齐"表头列数 == 每行列数"；宁可跳过某条异常数据并 print 警告，也不要让整脚本崩掉。
- **中文字体（matplotlib/Pillow/图表水印等）绝不硬编码单一路径**——沙箱字体文件与你的常识可能差一个后缀（实测 wqy 是 .ttc 不是 .ttf，硬编码 .ttf 直接 FileNotFoundError）。用候选探测：
  \`\`\`python
  import os
  FONT = next((p for p in [
      '/usr/share/fonts/custom/PingFang.ttc',              # 苹方（镜像可能内置）
      '/usr/share/fonts/custom/Microsoft YaHei.ttf',       # 微软雅黑
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',    # 文泉驿（注意 .ttc）
      '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ] if os.path.exists(p)), None)
  \`\`\`
  matplotlib 优先用字体名回退链：\`plt.rcParams['font.sans-serif'] = ['PingFang SC','Microsoft YaHei','WenQuanYi Micro Hei','WenQuanYi Zen Hei']\`；FONT 为 None 时别崩，继续出图（中文变方框好过整脚本挂掉）。\n${inputFiles && inputFiles.length ? `\n【用户工作空间输入文件（迭代编辑）】\n已铺至容器 /work/input/ 下：\n${inputFiles.map(f => '- /work/input/' + f).join('\n')}\n若用户请求是在这些文件基础上修改/续写/调整（如\"把刚才那份改一下\"\"第三节换个写法\"），必须先读取对应输入文件（如 python-docx 打开 /work/input/xxx.docx），在其现有内容基础上修改后另存到 /out/（可同名，即新版本）；除非用户明确要求重做，不要无视输入文件从零重建。\n` : ''}${focusHint ? `\n【本次协作分工（务必遵守）】\n${focusHint}\n` : ''}${lastError ? `\n【上一轮执行失败，stderr 如下，请修复后重写完整脚本】\n${lastError.slice(0, 1200)}\n` : ''}\n${guide
    ? '【设计规范 SKILL.md——本次产出的验收标准，逐条落实】\n它不是背景参考：配色、字体、版式、结构、署名元素、文案风格都必须按这份规范针对本次主题做出**有主见的独特选择**，禁止套用与主题无关的通用模板；规范里的构思流程（先构思方案、自评是否落入通用默认、再动笔）请在你的思考中完成后再写代码。交付物要能让读过规范的人一眼看出规范被执行了。'
    : '【技能手册 SKILL.md（节选）】'}\n${skillMd}\n\n【bundle 文件清单】\n${fileList.join('\n')}${materials ? `\n\n【已备素材（管线在执行前真实取到的数据：企业知识库命中 / 联网检索结果）——这就是文档要写的内容来源，请据此填充正文与表格，不要另行臆造】\n${materials}\n` : ''}${outline ? `\n\n【关键事实与内容大纲（已按素材预提炼——章节/页面组织**必须遵循大纲**：每页对应大纲一条、标题一致、不得漏章；正文与图表中的数字**必须取自关键事实清单原值**，绝不另行编造或改写）】\n${outline}\n` : ''}\n\n【用户请求】\n${userText}\n\n只输出一个 Python 代码块（\`\`\`python ... \`\`\`），不要任何解释。`
}

/**
 * 从模型回复中抠出 Python 脚本。三种形态都要接得住（2026-08-05 A股技能实锤两连坑）：
 * ① 正常围栏 → 取开栏到**最后一个**闭栏（曾用非贪婪取第一个 ``` ——脚本里 print("```chart...")
 *   这类围栏字符串会把代码拦腰截断）；
 * ② 只有开栏没有闭栏 = 输出触顶被截断 → 返回 ''，交给上层按「生成失败」重试并要求压缩篇幅。
 *   绝不能把带 ```python 首行的原文送进沙箱：首行就是 SyntaxError，而顶层 SyntaxError 的输出
 *   不含 "Traceback" 字样，会被旧版沙箱 ok 嗅探误判成"执行成功"，静默空跑到死；
 * ③ 无围栏 → 宽容裸代码回复，原样返回。
 */
function extractPyBlock(text: string): string {
  const t = (text || '').trim()
  const open = t.match(/```(?:python|py)?\s*\n/)
  if (!open) return t
  const rest = t.slice((open.index || 0) + open[0].length)
  const close = rest.lastIndexOf('\n```')
  if (close < 0) return ''
  return rest.slice(0, close).trim()
}

/** 回复里有开栏却抠不出完整代码块 = 生成被截断（与"压根没写代码"是两种病，重试话术不同）。 */
function looksTruncated(raw: string, extracted: string): boolean {
  return !extracted && /```(?:python|py)?\s*\n/.test(raw || '')
}

export async function runAgenticSkill(bundleRaw: string, skillSop: string, data: AgentTaskData, skl: string, sendLog: SendLog, out: SkillExecOut, focusHint?: string, materials?: string, opts?: { guide?: boolean }): Promise<void> {
  // bundle: {相对路径: 文本内容}（管理端整目录导入落库格式）
  let bundle: Record<string, string> = {}
  try { bundle = JSON.parse(bundleRaw || '{}') } catch (e) { swallow(e, 'agentic-bundle') }
  const skillMd = bundle['SKILL.md'] || skillSop || ''
  // 技能声明的沙箱依赖（SKILL.md frontmatter/正文 `packages:` 行）：随执行送沙箱安装；
  // 网络隔离下申报包会放开容器出网（受后端出网白名单管控）——取数类技能（如 A股行情）靠它联网。
  const netPkgs = extractSandboxPackages(skillMd + '\n' + skillSop)
  // 措辞要与后端实际行为一致：沙箱是**装包阶段联网、装完断网再跑用户代码**（fail-closed 安全模型）。
  // 原文案写的是"执行容器将放开出网"，让人以为脚本运行时也能联网——
  // 于是取数技能连抛 ConnectionError 时，没人往"沙箱本来就断网"上想（实测排查绕了很久）。
  if (netPkgs.length) {
    // 前台状态条直接滚这条——写成人话（实测反馈：包名清单直出没人看得懂）；
    // 完整包名保留在括号里供排查（装包联网、装完断网跑代码的语义别丢）。
    const head = netPkgs.slice(0, 3).join('、')
    const more = netPkgs.length > 3 ? ` 等 ${netPkgs.length} 个` : ''
    sendLog('thinking', `我先把运行环境备好：安装 ${head}${more}依赖包，装完就断网执行`)
  }
  const fileList = Object.keys(bundle).sort()
  const filesB64: Record<string, string> = {}
  for (const [p, content] of Object.entries(bundle)) filesB64[p] = Buffer.from(String(content), 'utf8').toString('base64')

  // 把上一轮沙箱产物铺回下一轮容器的 /work/prev/：重试轮直接读文件复用已取到的数据、只补失败部分。
  // 充分性换源、崩溃自修复、NO_DATA 重试三类共用——全量重跑既慢，又加剧限流接口（东财防封）的风控压力。
  const carryPrev = (resFiles?: { name: string; base64: string }[]): string[] => {
    const names: string[] = []
    for (const f of resFiles || []) {
      if (f && f.name && f.base64) { filesB64['prev/' + f.name] = f.base64; names.push(f.name) }
    }
    return names
  }

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

  // 选节与驱动脚本生成默认走快档（scriptGenCfg）：这两步是纯"按手册挑章节/照抄代码组装"，
  // 思考档在这里只贡献时延与截断（成稿质量由 4 轮沙箱自修复兜底）。
  // **指南型（guide）例外**：frontend-design/brand-guidelines 这类手册要的恰恰是设计构思，
  // 快档+照抄话术会把手册整份稀释成通用模板（2026-08-14 实锤：产出的网页看不出技能被应用）。
  // 指南型用会话模型并全程保留思考，让手册的构思流程真的发生。
  const guide = !!opts?.guide
  const genCfg = guide ? data.llmConfig : scriptGenCfg(data.llmConfig)
  if (!guide && genCfg.modelName !== data.llmConfig.modelName) {
    sendLog('thinking', `脚本生成用快档模型${(genCfg.mode || 'direct') === 'proxy' ? '（网关按标准档路由）' : `：${genCfg.modelName}`}——写脚本重在照抄手册代码，无需深思考档`)
  }
  if (guide) sendLog('thinking', '规范/指南类技能：用会话模型带完整思考进行创作，产出会逐条落实手册规范')
  // 超长手册先按本次请求选节（渐进披露），避免硬截后只剩开头的版本日志
  const manual = await selectManualExcerpt(skillMd, data.content, genCfg)
  if (manual.length < skillMd.length) sendLog('thinking', `技能手册较长（约 ${Math.round(skillMd.length / 1000)}k 字符），已按本次请求选取相关章节注入（约 ${Math.round(manual.length / 1000)}k）`)

  sendLog('thinking', `已加载技能手册与 ${fileList.length} 个 bundle 文件，正在按手册为本次请求编写执行脚本…`)
  const MAX_ATTEMPTS = 4
  /** 「生成不出脚本」额外重试几次。连着两次吐不出代码块多半是 prompt 本身有问题，
   *  再试只是重复烧 20k+ 的请求——与"执行失败带着报错去修"是两回事，不共用 MAX_ATTEMPTS 的额度。 */
  const GEN_RETRY_LIMIT = 1
  let genFailures = 0
  let lastError = ''
  let sufficiencyRetried = false   // 「数据充分性」换源重取只给一次机会：数据源真挂了，重试烧不出数据
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let driver = ''
    let genErr = ''
    let truncated = false
    // 流式进度框：编写期间把模型增量（思考+正文）节流吐进执行详情（同 id 替换合并，
    // 渲染成默认折叠的框，点开实时看）。写脚本一步动辄几分钟，从前只有一句静态
    // "正在编写执行脚本…"，用户全程盲等（2026-08-14 反馈）。每轮重试各一个框，
    // 失败轮写了什么留着可查。直连模式无流式增量 → 一次都不回调，框不出现，无损。
    let sThink = ''
    let sCode = ''
    let lastPush = 0
    const pushStream = (done: boolean) => {
      if (!sThink && !sCode) return
      const now = Date.now()
      if (!done && now - lastPush < 400) return   // 节流：增量以 token 为单位到达，逐条转发会刷爆 IPC
      lastPush = now
      sendLog(`${done ? 'stream-done' : 'stream'}:script-a${attempt}`, streamBoxText(sThink, sCode))
    }
    try {
      // maxTokens 64k：脚本生成的输出预算（思考+正文都从这里出，网关默认 32k 不够大技能用；
      // 厂商不认 64k 时网关自动回退通道默认预算重发）。单轮 64k 仍装不下的整站生成类产物
      // （impeccable 实锤 2026-08-13：64k 也截断）走分段续写：撞顶就带全部已写内容续写下一段，
      // 直到围栏闭合——渐进式落在输出侧，见 gen-continuation.ts。
      // 关思考的两类调用：① 修复轮（lastError 非空）——按报错照抄手册换源/改代码，无需深思考，
      // 每轮省 30~60s（实测修复轮 90s→17s，2026-08-13）；② 取数类（netPkgs 非空）**全程**——
      // 写取数脚本=照抄手册代码（本项目既有法则），实测带思考首轮 2 分钟、且思考并没防住
      // 「不照抄自写解析」的错（价格×1000 脏数据），纯浪费。创作类（无 netPkgs）维持首轮思考；
      // 指南型（guide）全程保留思考——构思即价值。
      const noThink = !guide && (lastError || netPkgs.length)
      const raw = await generateWithContinuation(
        buildAgenticPrompt(manual, fileList, data.content, lastError || undefined, focusHint, inputNames, materials, outline, netPkgs, guide),
        (p, o) => callLlm(p, genCfg, {
          ...(noThink ? { ...o, reasoning: false } : o),
          onDelta: d => {
            if (d.reasoning) sThink += d.reasoning
            if (d.content) sCode += d.content
            pushStream(false)
          },
        }),
        {
          maxTokens: 65536,
          onProgress: (round, chars) => sendLog('thinking', `产物超出单次输出上限，续写第 ${round} 段（已写约 ${Math.round(chars / 1000)}k 字符）…`),
        })
      pushStream(true)
      driver = extractPyBlock(raw)
      truncated = looksTruncated(raw, driver)
    }
    catch (e: any) {
      pushStream(true)   // 失败也收口进度框（否则框停在"编写中"永远转圈）
      genErr = String(e?.message || e).slice(0, 200); swallow(e, 'agentic-gen')
    }
    if (!driver) {
      // ① 生成失败也要重试。这里原本直接 return——而重试循环只覆盖"执行失败"，
      //    于是模型一次抖动（prompt 是 20k+ 的手册节选，超时/截断很常见）就让整个技能失败，
      //    一次机会都不给。实测踩到：A股分析技能报「模型生成驱动脚本失败」，重试一次即可。
      // ② 失败原因不能吞。原来 catch 里只有 swallow（还得开 IML_DEBUG 才看得见），
      //    用户和模型拿到的都是「生成驱动脚本失败」这一句——超时、上下文超限、网关 429、
      //    模型没吐代码块，四种完全不同的原因长得一模一样，没法判断该重试还是该改配置。
      genFailures++
      if (genFailures <= GEN_RETRY_LIMIT && attempt < MAX_ATTEMPTS) {
        // 超时与截断同因（思考型模型的思考+输出量撑爆预算/时限）：重试话术都要求大幅压缩，
        // 否则同样的写法只会再超一次（2026-08-08 a-stock 实锤：两轮生成双双超时）。
        const genTimeout = /timeout|abort|超时/i.test(genErr)
        lastError = genErr
          ? (genTimeout
            ? `上一轮脚本生成**超时**（${genErr}）——多为脚本写得太长、思考太久。请大幅压缩重写：`
              + '只保留完成本次请求所需的最小代码，每个数据项只挑手册里 1 个最可靠的数据源（不要贪多、不要写备用分支），'
              + '删掉所有注释与打印装饰，尽快输出**完整闭合**的 ```python 围栏脚本。'
            : `上一轮脚本生成失败：${genErr}。请重新生成完整的 Python 脚本。`)
          : truncated
            ? '上一轮脚本写到一半就被输出长度上限截断了，没有拿到完整代码。请大幅压缩篇幅重写：'
              + '只保留完成本次请求所需的最小代码（挑 1-2 个最可靠的数据源即可，不要贪多），'
              + '删掉所有注释/打印装饰/可选分支，务必在长度限制内输出**完整闭合**的 ```python 围栏脚本。'
            : '上一轮没有产出可执行的 Python 代码块。请用 ```python 围栏输出完整脚本。'
        sendLog('thinking', `脚本生成失败（${genErr || (truncated ? '输出超长被截断' : '未产出代码块')}），重试一次…`)
        continue
      }
      const why = genErr || (truncated ? '模型输出超长被截断，未能产出完整脚本（可换更大输出上限的模型或缩小任务范围）' : '模型未产出可执行的代码块')
      out.skillOk = false
      out.skillResult = `❌ 技能「${skl}」执行失败：${why}`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：${why}。`
        + '请把这个具体原因如实转述给用户（例如上下文超限就建议缩小任务范围、网关报错就提示稍后重试），'
        + '不要笼统说"技能执行失败"，更不要绕开它自己编一份结果。'
      return
    }
    sendLog('acting', attempt === 1 ? '在 Docker 容器沙箱中执行技能脚本…' : '按上一轮问题修复脚本后重试执行…')
    const res = await execViaBackendSandbox(driver, netPkgs, filesB64)
    if (!res) {
      out.skillOk = false
    out.skillResult = `⚠️ 代码执行沙箱当前不可用，技能「${skl}」未执行。请联系管理员检查沙箱（管理端「沙箱监控」）。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：公司级后端 Docker 沙箱不可达。请如实告知用户，绝不编造执行结果。`
      return
    }
    // 数据充分性反馈（取数类专属）：脚本跑通 ≠ 数据取全。stdout 出现「接口异常/未返回/风控」等
    // 局部失败信号时，旧逻辑照样按成功收工交差（实锤：EPS/ROE 未返回、资金流向接口异常仍出报告）。
    // 给一次「按手册备用源换源重取」的机会；已重试过或到末轮则带缺口如实交付（汇报指令会要求标注缺失）。
    // 触发判定分两级：① 结构化前缀 PARTIAL_FAIL:（脚本自报，最准）恒触发；② 兜底词表仅当命中行
    // **不含成功字样**时触发——"东财异常，已走新浪成功"是脚本自愈成功的叙述，曾据此白烧一轮全量重跑。
    // 放在落盘之前：半截数据的产物不落工作空间，免得重取成功后留下一对重名副本。
    const SELF_HEALED = /(成功|已走|已切换|已改用|已换用|succeeded|fallback ok)/i
    const stdoutLines = (res.stdout || '').split('\n')
    const partialHit = res.ok && (PARTIAL_SIGNAL.test(res.stdout || '')
      || stdoutLines.some(l => PARTIAL_FAIL.test(l) && !SELF_HEALED.test(l)))
    if (partialHit && netPkgs.length && !sufficiencyRetried && attempt < MAX_ATTEMPTS) {
      sufficiencyRetried = true
      // 失败线索优先取结构化信号行（脚本自报，最准），无信号行才退回兜底词表命中行（剔除自愈成功行）
      const signalLines = stdoutLines.filter(l => PARTIAL_SIGNAL.test('\n' + l))
      const failLines = (signalLines.length ? signalLines : stdoutLines.filter(l => PARTIAL_FAIL.test(l) && !SELF_HEALED.test(l))).slice(0, 8).join('\n')
      // 成功项数据延续：上一轮 /out 产物铺回新容器 /work/prev/——重试轮只重取失败项，已成功的数据
      // 直接读文件复用（全量重跑白烧时延，还会把原本成功的项重新暴露给风控，正反馈恶化）。
      const prevNames = carryPrev(res.files)
      lastError = `【上一轮脚本已跑通，但 stdout 显示部分数据项取数失败（线索见下）。${prevNames.length
        ? `上一轮成功产出的数据文件已铺在容器 /work/prev/ 下（${prevNames.join('、')}）——**已成功的数据项不要重新取数**，直接读取 /work/prev/ 里的对应文件复用（如 pd.read_csv('/work/prev/xxx.csv')），`
        : `请保持已成功的数据项取数方案不变，`}只对失败项查阅手册「备用源/速查」章节换用备用数据源重取；完整产物（复用项＋重取项）仍需全部写入 /out/。若某项所有源确实都取不到，保留其余数据并在输出中明确标注该项缺失及原因。\n失败线索：\n${failLines.slice(0, 1000)}】`
      sendLog('observing', `脚本跑通但部分数据项取数失败，${prevNames.length ? '复用已取到的数据、' : ''}按手册备用源只重取失败项…`)
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
        const prevN = carryPrev(res.files)
        if (prevN.length) lastError += `\n【上一轮已产出的文件铺在 /work/prev/（${prevN.join('、')}），其中已取到的数据可直接读取复用。】`
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
      out.skillOk = true
      out.skillResult = `🤖 已按技能手册「${skl}」现场编写并执行脚本。${fileLine}`
      out.skillPromptHint = buildExecReportHint(skl, res.stdout, fileLine, netPkgs.length > 0)
      return
    }
    // 成功但 /out/ 为空 → 大概率没把产物写到 /out/：当软失败，带纠正提示重试；最后一轮仍空才如实报“未产出”
    if (res.ok && saved.length === 0) {
      if (attempt < MAX_ATTEMPTS) {
        lastError = `【上一轮脚本执行成功(exit 0) 但 /out/ 目录为空——你没有把产物文件真正保存到 /out/】。本技能必须产出文件。请修正：① import os; os.makedirs('/out', exist_ok=True)；② 用绝对路径保存（如 doc.save('/out/xxx.docx') / wb.save('/out/xxx.xlsx') / prs.save('/out/xxx.pptx')），不要保存到 /work 或当前目录；③ 结尾 print('OUT_FILES:', os.listdir('/out')) 自证。上一轮 stdout：\n${(res.stdout || '(无输出)').slice(0, 800)}${res.stderr ? `\n上一轮 stderr（若含 [sandbox] 装包失败提示，说明该依赖在本环境不可用，改用手册中不依赖它的备用数据源）：\n${res.stderr.slice(0, 600)}` : ''}`
        sendLog('observing', `第 ${attempt} 轮执行成功但未产出文件，补充"必须写入 /out/"后重试…`)
        continue
      }
      sendLog('completed', `[Docker 沙箱·agentic] 多轮执行后仍未产出文件。`)
      out.skillResult = `⚠️ 技能「${skl}」脚本多轮执行成功但始终未产出文件。`
      out.skillPromptHint = `【技能 "${skl}" 未产出文件】脚本执行成功但 /out/ 始终为空（模型未把产物写入 /out/）。请如实告知用户"本次未能生成文件、建议重试或换个说法"，绝不编造已生成的文件。stdout：\n"""\n${(res.stdout || '(无输出)').slice(0, 800)}\n"""${res.stderr ? `\nstderr（如实转述其中的环境/依赖问题）：\n"""\n${res.stderr.slice(0, 600)}\n"""` : ''}`
      return
    }
    // 执行报错 → 带 stderr 重试。完整 stderr 只喂回模型自愈；主执行流不刷整段 traceback（吓人且无信息量），
    // 只报一句简明原因（取 traceback 末行的异常摘要，如 "IndexError: ..."）。
    lastError = res.stderr || res.error || '未知错误'
    // 按错误形态附结构化诊断——盲改必然重蹈覆辙（实测：被风控的接口连怼 4 轮，每轮只是小改参数）。
    if (/ConnectionError|RemoteDisconnected|Max retries|ProtocolError|Connection aborted/i.test(lastError)) {
      lastError += '\n【诊断】远端拒连/主动断连，该数据源大概率被风控或不可达（不是你的代码语法问题）。'
        + '**不要再调同一接口重试**——按手册「数据源优先级/备用源速查」换用备用数据源（如通达信/腾讯）重写取数；'
        + '东财系（eastmoney）请求必须使用手册提供的限流封装，严禁裸 requests 直连。'
    } else if (/EmptyDataError|No columns to parse|JSONDecodeError|Expecting value/i.test(lastError)) {
      lastError += '\n【诊断】解析函数吃到了**空响应/空文件**（接口返回空体或被反爬回了空页，不是解析代码写错）。'
        + '先 print 响应的 HTTP 状态码、长度与前 200 字符确认是否为空；为空则按手册「备用源速查」换**不同域名**的备用源重取；'
        + '禁止对空响应继续 read_csv/read_html/json.loads 硬解析。'
    } else if (/KeyError|IndexError|AttributeError|NoneType.*format|unsupported format/i.test(lastError)) {
      lastError += '\n【诊断】取值/格式化炸在空数据上。先 print 原始返回核对真实结构与列名（与手册代码逐字比对），'
        + '再取值；所有 f-string 格式化前判 None，数据为空时按手册换备用源，而不是继续格式化空值。'
    }
    // 崩溃前已成功写出的产物同样铺回 /work/prev/——重写脚本时复用已取到的数据，只重取未完成部分
    {
      const prevN = carryPrev(res.files)
      if (prevN.length) lastError += `\n【已保留上一轮产出】崩溃前已写出的文件铺在 /work/prev/（${prevN.join('、')}）——重写时直接读取复用其中的数据，只重取尚未完成的部分。`
    }
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
