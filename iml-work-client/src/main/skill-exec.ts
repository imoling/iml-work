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
export const WRITE_INTENT_LABEL = /同意|通过|批准|审批|核准|提交|确认|确定|保存|删除|移除|清除|新增|添加|录入|创建|发布|上架|下架|归档|驳回|拒绝|退回|撤回|撤销|作废|付款|转账|下单|支付|签收|收货|盖章|签字|生效|发送|发起/

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
      timeoutMs: 180000,   // 容器创建 + pip 安装 + 执行，放宽超时
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
// 把沙箱回传的 base64 产物落到工作空间，返回 {name,sizeBytes}[]（供文件卡展示 + 汇报文案）。
export function saveSandboxFiles(files: { name: string; base64: string }[], source?: string): { name: string; sizeBytes: number }[] {
  const saved: { name: string; sizeBytes: number }[] = []
  for (const f of files) {
    try {
      const buf = Buffer.from(f.base64, 'base64')
      const dir = workspaceDir()
      // 重名防覆盖（两个任务都产 output.docx 时后者不再吃掉前者）+ 产物登记（任务→文件出处索引）
      const name = uniqueArtifactName(dir, f.name)
      const absPath = path.join(dir, name)
      fs.writeFileSync(absPath, buf)
      registerArtifact({ name, absPath, sizeBytes: buf.length, source })
      saved.push({ name, sizeBytes: buf.length })
    } catch (e) { swallow(e) }
  }
  return saved
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
    out.skillPromptHint = `【技能 "${skl}" Docker 沙箱真实执行结果】\n标准输出：\n"""\n${(res.stdout || '(无输出)').slice(0, 2000)}\n"""\n${fileLine}\n\n请用**一两句话简洁汇报**已生成了什么即可——文件卡会在下方自动展示文件名、大小与「查看/打开位置」入口，你**无需**罗列文件名、文件大小、保存路径、页数等细节，也不要用编号列表逐个交代。绝不编造未产出的内容。\n\n【SOP】\n${skillSop}`
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

// 判断技能是否为「写入/操作类」（用于编排前置权限闸的预判）：skillKind=write，或动作里含 fill/select，
// 或点击了「同意/提交/删除…」等写意图按钮。与 runCustomSkill 的运行时判定同源，避免只读下静默半执行。
const skillWriteCache = new Map<string, boolean>()
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
            if (a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || (s && s.fieldName)) return true
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

function buildAgenticPrompt(skillMd: string, fileList: string[], userText: string, lastError?: string, focusHint?: string, inputFiles?: string[], materials?: string): string {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  return `你是企业工作分身的技能执行引擎。请阅读技能手册与文件清单，为用户请求编写一段可在 Linux Python 3.12 容器内独立运行的 Python 驱动脚本。\n\n【当前日期】${nowStr}。凡涉及年份/季度/日期（如"季度汇报""本年度"）一律以此为准，不要臆测成往年。\n\n【运行环境】\n- 工作目录 /work，技能 bundle 文件已按清单铺好（如 /work/scripts/...）；如需 import 它们，先 sys.path.insert(0, "/work")。\n- 已预装：${AGENTIC_PRELOADED_PKGS}。默认无网络，不要联网、不要调用 pip/subprocess 装东西。\n- **中文字体已装**：用 pillow/matplotlib 渲染任何中文时，必须加载 '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'（pillow: ImageFont.truetype(该路径, 字号)；matplotlib: rcParams['font.sans-serif']=['WenQuanYi Micro Hei']），严禁用默认字体，否则中文会变方框(□)。\n- 手册中依赖 soffice/pandoc/node 的流程在本环境不可用——改用预装的纯 Python 库实现同等效果（如用 python-docx 直接生成/编辑 .docx，python-pptx 生成 .pptx，openpyxl 生成 .xlsx）。\n- **产物必须写入 /out/ 目录（唯一会回传给用户的位置）**：脚本开头 import os; os.makedirs('/out', exist_ok=True)；保存时用绝对路径（如 doc.save('/out/讯飞介绍.docx')）；**结尾必须 print('OUT_FILES:', os.listdir('/out'))** 自证已产出。文件名用有意义的中文名。\n\n【硬性要求】\n- 本技能是**生成交付物类**（文档/表格/演示/PDF/图/海报）——脚本**必须真的把文件写进 /out/**；只 print 内容而不落文件、或写到别的目录、或 /out/ 为空，都算失败。宁可报错也不要静默不产出。\n- **产物命名要一眼可辨**：以输入文件名（去扩展名）或任务主题为基底、追加变体后缀，如「《原文件名》-A4.docx」「《原文件名》-A3双面.docx」；**严禁 output/result/final/input 这类泛名**。\n- **/out/ 只放新产出的交付物**：绝不把输入文件原样复制进 /out/（用户已有原件）；中间临时文件写 /tmp，不要回传。\n- **只产出属于本技能能力范围（见下方 SKILL.md）的交付物**；即便用户请求里还提到别的格式/其它交付物，也一律不要在本脚本中生成——那些由对应的其它技能负责。\n- 只完成用户请求本身；内容必须来自请求、手册与下方【已备素材】，绝不编造业务数据。\n- **有素材就必须用真素材填进文档**：把【已备素材】里的事实（数值/日期/名称/来源）写进正文与表格，不允许产出「待填充」「暂无数据」「请替换为实际数据」这类占位空壳——那等于没干活。\n- **素材确实为空、而请求又依赖外部实时数据时**：不要造一个占位模板文档交差。在脚本里 print 一行 NO_DATA: 缺什么数据、为什么拿不到，然后 sys.exit(1)。宁可如实报缺，也不要交空壳。\n- **素材与请求主题明显不符时同样按 NO_DATA 处理**：如请求"股票行情分析"而素材是大学简介/无关网页——检索可能搜偏了，**绝不拿无关素材硬凑成品**（那比没产出更糟：文档看着完成了、内容全错）。\n- 脚本自足、可直接运行；用 print 输出关键进度与结果摘要。\n\n【常见运行时陷阱 · 防御写法（务必遵守，多数首轮报错都出在这里）】\n- 表格（python-docx / python-pptx）：先把要填的数据整理成二维列表 rows，再按 len(rows) 建表或逐行 add_row()；**严禁硬编码行列数、严禁假设模板表格行数够用**；写单元格前确保 (row,col) 落在表格现有行列范围内，不够就先 add_row()。尽量少用合并单元格；必须合并时按左上角单元格寻址。\n- 下标与键：任何 list 下标、dict 取值先判越界/存在（如 if i < len(x) / dict.get(k, 默认值)），不要裸写 x[i] / d[k]。\n- 缺失值：字段可能为空或缺失，统一兜底（空串 / 跳过 / 默认值），别让 None 流进 len()/切片/格式化。\n- 解析：数字/日期/金额用 try/except 兜底，失败就保留原值或置 0，不要让单条 ValueError 中断整篇。\n- 写入前先校验数据非空、并对齐"表头列数 == 每行列数"；宁可跳过某条异常数据并 print 警告，也不要让整脚本崩掉。\n${inputFiles && inputFiles.length ? `\n【用户工作空间输入文件（迭代编辑）】\n已铺至容器 /work/input/ 下：\n${inputFiles.map(f => '- /work/input/' + f).join('\n')}\n若用户请求是在这些文件基础上修改/续写/调整（如\"把刚才那份改一下\"\"第三节换个写法\"），必须先读取对应输入文件（如 python-docx 打开 /work/input/xxx.docx），在其现有内容基础上修改后另存到 /out/（可同名，即新版本）；除非用户明确要求重做，不要无视输入文件从零重建。\n` : ''}${focusHint ? `\n【本次协作分工（务必遵守）】\n${focusHint}\n` : ''}${lastError ? `\n【上一轮执行失败，stderr 如下，请修复后重写完整脚本】\n${lastError.slice(0, 1200)}\n` : ''}\n【技能手册 SKILL.md（节选）】\n${skillMd.slice(0, 12000)}\n\n【bundle 文件清单】\n${fileList.join('\n')}${materials ? `\n\n【已备素材（管线在执行前真实取到的数据：企业知识库命中 / 联网检索结果）——这就是文档要写的内容来源，请据此填充正文与表格，不要另行臆造】\n${materials}\n` : ''}\n\n【用户请求】\n${userText}\n\n只输出一个 Python 代码块（\`\`\`python ... \`\`\`），不要任何解释。`
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

  sendLog('thinking', `已加载技能手册与 ${fileList.length} 个 bundle 文件，正在按手册为本次请求编写执行脚本…`)
  const MAX_ATTEMPTS = 3
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let driver = ''
    try { driver = extractPyBlock(await callLlm(buildAgenticPrompt(skillMd, fileList, data.content, lastError || undefined, focusHint, inputNames, materials), data.llmConfig, { temperature: 0, longRunning: true })) }
    catch (e) { swallow(e, 'agentic-gen') }
    if (!driver) {
      out.skillResult = `❌ 技能「${skl}」执行失败：模型未能生成有效的执行脚本。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：模型生成驱动脚本失败。请如实告知用户，绝不编造结果。`
      return
    }
    sendLog('acting', attempt === 1 ? '在 Docker 容器沙箱中执行技能脚本…' : '按上一轮问题修复脚本后重试执行…')
    const res = await execViaBackendSandbox(driver, [], filesB64)
    if (!res) {
      out.skillResult = `⚠️ 代码执行沙箱当前不可用，技能「${skl}」未执行。请联系管理员检查沙箱（管理端「沙箱监控」）。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：公司级后端 Docker 沙箱不可达。请如实告知用户，绝不编造执行结果。`
      return
    }
    const savedFiles = saveSandboxFiles(res.files, skl)
    const saved = savedFiles.map(f => f.name)
    // 素材缺失（脚本主动 print NO_DATA 并退出）→ 这不是脚本 bug，重试多少轮都没用（数据本来就没取到）。
    // 立刻停止自修复循环，如实汇报缺什么数据，绝不交一个「待填充」占位空壳文档。
    const noData = /(^|\n)\s*NO_DATA[:：]/.test(res.stdout || '') || /(^|\n)\s*NO_DATA[:：]/.test(res.stderr || '')
    if (noData) {
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
      out.skillPromptHint = `【技能 "${skl}" agentic 真实执行结果】\n标准输出：\n"""\n${(res.stdout || '(无输出)').slice(0, 2000)}\n"""\n${fileLine}\n\n请用**一两句话简洁汇报**已生成了什么即可——文件卡会在下方自动展示文件名、大小与「查看/打开位置」入口，你**无需**罗列文件名、文件大小、保存路径、页数等细节，也不要用编号列表逐个交代。绝不编造未产出的内容。`
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
