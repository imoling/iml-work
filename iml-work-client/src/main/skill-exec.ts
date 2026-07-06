// 技能执行层：Docker 沙箱代码执行、agentic bundle 执行（LLM 现场编脚本 + 自修复重试）、
// 语义意图路由与写技能判定。纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import fs from 'fs'
import path from 'path'
import { getAdminBaseUrl, afetch } from './http'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { workspaceDir } from './workspace-files'
import { type SkillDefinition, skillDisplayName } from './skill-store'
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
export function saveSandboxFiles(files: { name: string; base64: string }[]): { name: string; sizeBytes: number }[] {
  const saved: { name: string; sizeBytes: number }[] = []
  for (const f of files) {
    try {
      const buf = Buffer.from(f.base64, 'base64')
      fs.writeFileSync(path.join(workspaceDir(), f.name), buf)
      saved.push({ name: f.name, sizeBytes: buf.length })
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

  const savedFiles = saveSandboxFiles(res.files)
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
// 返回选中的 skillId 数组（可空）；模型异常静默返回 []（不阻塞主链路）。
export async function routeSkillsByIntent(userText: string, skills: SkillDefinition[], llmConfig: LlmConfig): Promise<string[]> {
  if (!skills.length || !(userText || '').trim()) return []
  const catalog = skills.map(s =>
    `- id: ${s.id}\n  名称: ${skillDisplayName(s.id) || s.name}\n  描述: ${(s.description || s.sopContent || '').replace(/\s+/g, ' ').slice(0, 240)}`
  ).join('\n')
  const prompt = `你是企业工作分身的技能路由器。根据用户请求，从技能目录中选出完成该请求所需的【全部】技能（可以是 0 个、1 个或多个）。\n\n【技能目录】\n${catalog}\n\n【用户请求】\n${userText}\n\n判定规则：\n- 请求要产出/编辑/起草文档、报告、信函、文书、备忘录、表格、演示文稿等交付物 → 选对应的文档/生成类技能（哪怕没提"docx/word/ppt"字眼）。\n- 一句话要多种交付物（如"要 Word 报告和 PPT"）→ 同时选中对应的多个技能。\n- 请求是操作业务系统（审批、录入、查询）→ 选对应业务技能。\n- 闲聊、普通知识问答、与目录全部无关 → 返回空数组。\n- **宁缺勿滥**：目录里没有与请求的对象/系统真正对应的技能时，必须返回空数组——绝不要硬凑近似项（例如请求是"生产工单开工/排产/零件断供/采购收货"这类 ERM 操作，而目录只有"合同审批"，就返回空数组，不要选合同审批）。\n- skillId 必须逐字取自目录中的 id。\n【示例1】"帮我起草一份致歉文书"（目录有 docx）→ {"skillIds":["<docx技能id>"]}\n【示例2】"准备季度汇报，要 Word 报告和 PPT"（目录有 docx、pptx）→ {"skillIds":["<docx技能id>","<pptx技能id>"]}\n只输出严格 JSON（不要解释、不要代码块标记）：{"skillIds":["id1","id2"]} 或 {"skillIds":[]}`
  try {
    const outText = await callLlm(prompt, llmConfig, { temperature: 0 })
    const m = outText.match(/\{[\s\S]*?\}/)
    const arr = m ? JSON.parse(m[0])?.skillIds : null
    const picked = Array.isArray(arr) ? arr.filter((id: any) => typeof id === 'string' && skills.some(s => s.id === id)) : []
    console.log(`[skill-router] user="${userText.slice(0, 60)}" raw="${(outText || '').replace(/\s+/g, ' ').slice(0, 160)}" picked=${JSON.stringify(picked)}`)
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

function buildAgenticPrompt(skillMd: string, fileList: string[], userText: string, lastError?: string, focusHint?: string): string {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  return `你是企业工作分身的技能执行引擎。请阅读技能手册与文件清单，为用户请求编写一段可在 Linux Python 3.12 容器内独立运行的 Python 驱动脚本。\n\n【当前日期】${nowStr}。凡涉及年份/季度/日期（如"季度汇报""本年度"）一律以此为准，不要臆测成往年。\n\n【运行环境】\n- 工作目录 /work，技能 bundle 文件已按清单铺好（如 /work/scripts/...）；如需 import 它们，先 sys.path.insert(0, "/work")。\n- 已预装：${AGENTIC_PRELOADED_PKGS}。默认无网络，不要联网、不要调用 pip/subprocess 装东西。\n- **中文字体已装**：用 pillow/matplotlib 渲染任何中文时，必须加载 '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'（pillow: ImageFont.truetype(该路径, 字号)；matplotlib: rcParams['font.sans-serif']=['WenQuanYi Micro Hei']），严禁用默认字体，否则中文会变方框(□)。\n- 手册中依赖 soffice/pandoc/node 的流程在本环境不可用——改用预装的纯 Python 库实现同等效果（如用 python-docx 直接生成/编辑 .docx，python-pptx 生成 .pptx，openpyxl 生成 .xlsx）。\n- **产物必须写入 /out/ 目录（唯一会回传给用户的位置）**：脚本开头 import os; os.makedirs('/out', exist_ok=True)；保存时用绝对路径（如 doc.save('/out/讯飞介绍.docx')）；**结尾必须 print('OUT_FILES:', os.listdir('/out'))** 自证已产出。文件名用有意义的中文名。\n\n【硬性要求】\n- 本技能是**生成交付物类**（文档/表格/演示/PDF/图/海报）——脚本**必须真的把文件写进 /out/**；只 print 内容而不落文件、或写到别的目录、或 /out/ 为空，都算失败。宁可报错也不要静默不产出。\n- **只产出属于本技能能力范围（见下方 SKILL.md）的交付物**；即便用户请求里还提到别的格式/其它交付物，也一律不要在本脚本中生成——那些由对应的其它技能负责。\n- 只完成用户请求本身；内容必须来自请求与手册，绝不编造业务数据。\n- 脚本自足、可直接运行；用 print 输出关键进度与结果摘要。\n${focusHint ? `\n【本次协作分工（务必遵守）】\n${focusHint}\n` : ''}${lastError ? `\n【上一轮执行失败，stderr 如下，请修复后重写完整脚本】\n${lastError.slice(0, 1200)}\n` : ''}\n【技能手册 SKILL.md（节选）】\n${skillMd.slice(0, 12000)}\n\n【bundle 文件清单】\n${fileList.join('\n')}\n\n【用户请求】\n${userText}\n\n只输出一个 Python 代码块（\`\`\`python ... \`\`\`），不要任何解释。`
}

function extractPyBlock(text: string): string {
  const m = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/)
  return (m ? m[1] : text).trim()
}

export async function runAgenticSkill(bundleRaw: string, skillSop: string, data: AgentTaskData, skl: string, sendLog: SendLog, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }, focusHint?: string): Promise<void> {
  // bundle: {相对路径: 文本内容}（管理端整目录导入落库格式）
  let bundle: Record<string, string> = {}
  try { bundle = JSON.parse(bundleRaw || '{}') } catch (e) { swallow(e, 'agentic-bundle') }
  const skillMd = bundle['SKILL.md'] || skillSop || ''
  const fileList = Object.keys(bundle).sort()
  const filesB64: Record<string, string> = {}
  for (const [p, content] of Object.entries(bundle)) filesB64[p] = Buffer.from(String(content), 'utf8').toString('base64')

  sendLog('thinking', `已加载技能手册与 ${fileList.length} 个 bundle 文件，正在按手册为本次请求编写执行脚本…`)
  const MAX_ATTEMPTS = 3
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let driver = ''
    try { driver = extractPyBlock(await callLlm(buildAgenticPrompt(skillMd, fileList, data.content, lastError || undefined, focusHint), data.llmConfig, { temperature: 0 })) }
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
    const savedFiles = saveSandboxFiles(res.files)
    const saved = savedFiles.map(f => f.name)
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
    // 执行报错 → 带 stderr 重试
    lastError = res.stderr || res.error || '未知错误'
    sendLog('observing', `第 ${attempt} 轮执行失败：${lastError.slice(0, 200)}`)
  }
  out.skillResult = `❌ 技能「${skl}」执行失败（已自动修复重试 ${MAX_ATTEMPTS - 1} 次仍未成功）。`
  out.skillPromptHint = `【技能 "${skl}" 执行失败】${MAX_ATTEMPTS} 轮均失败，最后错误：\n${lastError.slice(0, 800)}\n请如实告知用户失败与原因，绝不编造结果。`
}
