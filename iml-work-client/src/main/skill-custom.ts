// 自定义技能真实执行：解析绑定业务系统 → 语义脚本(DSL)/录制回放/CRM拜访录入/读取抓取/
// 联网检索/知识推理；含只读权限闸、写操作表单确认、批量执行。纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import { getAdminBaseUrl, afetch } from './http'
import { configSet } from './db'
import { swallow } from './util'
import { requestFormConfirmation, requestPermissionChoice } from './automation-runtime'
import { sinkSkillFields } from './focus-sink'
import { openSystemAndExtract, extractVisitFields, fillCrmVisitForm, extractFieldsByLabels, parseDsl } from './browser-automation'
import { runBrowseExecutor, renderStepsHint } from './browse-executor'
import { runSkillStepper } from './skill-stepper'
import { callLlm } from './llm'
import { probeSystem } from './biz-keepalive'
import { webSearch, refineSearchQuery } from './web-search'
import { sourceTier } from './web-search-core'
import { type SkillDefinition, skillDisplayName, setSkillDisplayName } from './skill-store'
import { WRITE_INTENT_LABEL, runCodeSkill, runAgenticSkill } from './skill-exec'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult, SystemInfo, SkillDetail, AutomationStep } from './agent-types'
import { type SendLog, type VisitField, type RecStep } from './types'



// Harness ReAct Loop simulation trigger
// 把近几轮对话渲染成 prompt 上文块（空则空串）。用于单会话多轮上下文：分身能理解指代、延续话题、
// 引用用户上文说过的信息（如上一轮"我的生日是…"）。截断每条，避免历史过长撑爆 token。
// agent 子流程（记忆/定时意图、答案合成）已拆至 agent-steps.ts。

// 技能执行层（沙箱/agentic/路由/写判定）已拆至 skill-exec.ts。

// 写前签字卡内容：**字段核对清单**而非整页文本倾倒（原始 innerText 混着水印/导航/统计，用户根本看不懂）。
// 每个确认过的字段值标注「✓已见于页面 / ⚠️页面未见」——未见=可能没落值，签字前一眼识破空值单。
function buildSignFields(pageText: string, filled: VisitField[], confirmed: Record<string, string>, actionLabel: string): VisitField[] {
  const normV = (s: string) => String(s || '').replace(/[\s,，¥￥$%]/g, '')
  const pt = normV(pageText)
  // 邻近匹配：值必须出现在**字段标签之后 160 字内**才算真落值——全页匹配是假凭据
  //（"因公误时"在统计区/别的字段也出现、"昕宇"可能挂在没关的下拉里，全页 includes 全是误判 ✓）。
  const nearHit = (label: string, nv: string): boolean => {
    const nl = normV(label)
    if (!nl || !pt) return false
    let idx = pt.indexOf(nl)
    while (idx !== -1) {
      const win = pt.slice(idx + nl.length, idx + nl.length + 160)
      if (win.includes(nv)) return true
      idx = pt.indexOf(nl, idx + 1)
    }
    return false
  }
  const rows: VisitField[] = filled.filter(f => (confirmed[f.name] || '').trim()).map(f => {
    const v = (confirmed[f.name] || '').trim()
    const nv0 = normV(v)
    const nv = nv0.length > 10 ? nv0.slice(0, 10) : nv0
    const near = nearHit(f.label, nv)
    const global = !near && !!pt && pt.includes(nv)
    const mark = near ? '　✓ 已见于字段附近' : global ? '　⚠️ 仅全页出现（可能来自其它字段/统计，未必已落值）' : '　⚠️ 页面未见（可能未落值）'
    return { name: '_p_' + f.name, label: f.label, value: `${v}${mark}`, type: 'text', readonly: true }
  })
  const missN = rows.filter(r => r.value.includes('⚠️')).length
  const head: VisitField[] = missN
    ? [{ name: '_warn', label: '⚠️ 注意', value: `有 ${missN} 个字段未在页面上见到——可能没真正填进去，建议取消并核实`, type: 'text', readonly: true }]
    : []
  return [
    ...head,
    ...rows,
    { name: '_final', label: '将执行的写操作（核对以上字段后确认；取消则不提交、不改动系统）', value: actionLabel, type: 'text', readonly: true },
  ]
}

export async function runCustomSkill(matchedSkill: SkillDefinition, skl: string, data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }, focusHint?: string, materials?: string): Promise<AgentResult | null> {
  let skillHandled = false
      sendLog('thinking', `[技能执行] 识别到自定义技能 "${skl}"，正在拉取技能定义...`)

      // 本地 SKILL.md 不含目标系统，需向管理端拉取完整技能定义。
      let targetSystemId = ''
      let actionScriptRaw = ''
      let skillCode = ''
      let skillType = ''
      let skillSop = ''
      let skillKind = ''        // read=读取/查看类，write=写入/操作类（FDE 录制时判定）
      let skillNavHash = ''     // 录制到的导航目标路由，读取类据此直达子页
      let skillBundle = ''      // agentic 技能包（SKILL.md+scripts 整目录 JSON），无直接 code 时按手册现场生成脚本
      let focusMap: { field: string; objectType: string }[] | undefined   // 管理端配的画像沉淀映射（无则自动匹配）
      try {
        const sr = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${matchedSkill.id}`)
        if (sr.ok) { const full = await sr.json() as SkillDetail; targetSystemId = full.targetSystemId || ''; actionScriptRaw = full.actionScript || ''; skillCode = full.code || ''; skillType = full.type || ''; skillSop = full.sopContent || ''; skillKind = full.skillKind || ''; skillNavHash = full.navHash || ''; skillBundle = full.bundle || ''; if (full.name) setSkillDisplayName(matchedSkill.id, String(full.name))
          try { const fm = JSON.parse((full as any).focusMapJson || 'null'); if (Array.isArray(fm)) focusMap = fm } catch (e) { swallow(e, 'focus-map-parse') } }
      } catch (e) { swallow(e) }
      // 如实播报绑定情况：生成/知识类技能本就不绑定业务系统，别播"正在解析绑定系统"误导用户
      sendLog('thinking', targetSystemId
        ? `[技能执行] 该技能绑定了目标业务系统，稍后将复用本地登录态访问。`
        : `[技能执行] 该技能未绑定业务系统（生成/知识类），在本地与沙箱内完成，不访问任何业务系统。`)

      // 解析绑定系统地址的小工具
      const resolveSystem = async (): Promise<{ sysName: string; baseUrl: string }> => {
        let sysName = '业务系统', baseUrl = ''
        if (targetSystemId) {
          try {
            const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
            if (ir.ok) { const list = await ir.json() as SystemInfo[]; const sys = Array.isArray(list) ? list.find((x) => x.id === targetSystemId) : null; if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl } }
          } catch (e) { swallow(e) }
        }
        return { sysName, baseUrl }
      }

      // 系统预检闸（所有要碰业务系统的分支先过这里）：①系统可达吗 ②登录了吗。
      // 不可达 → 如实秒回，不再空跑整条自动化；未登录 → 出「登录卡」（去登录 + 一键重试），
      // 不再让用户读一段"请到设置→企业系统连接"的文字步骤。返回 null = 预检通过继续执行。
      const preflightSystem = async (systemId: string, baseUrl: string, sysName: string): Promise<AgentResult | null> => {
        sendLog('acting', `预检【${sysName}】：系统可达性与登录态…`)
        const pf = await probeSystem(systemId || 'rec', baseUrl)
        if (!pf.reachable) {
          sendLog('observing', `【${sysName}】不可达：${pf.error || '服务未响应'}`)
          await trace.submit(data.content, 'BLOCKED', `技能 "${skl}"：目标系统【${sysName}】不可达（${pf.error || '未响应'}），未执行。`)
          return { content: `❌ 无法访问【${sysName}】（${pf.error || '服务未启动或网络不通'}），本次未执行。\n\n请确认该系统服务已启动、地址配置正确后再次发起。`, success: false, traceId: trace.id }
        }
        if (!pf.loggedIn) {
          sendLog('observing', `【${sysName}】未登录 → 出登录卡等待本地登录`)
          await trace.submit(data.content, 'BLOCKED', `技能 "${skl}"：目标系统【${sysName}】未登录，已出登录卡等待用户本地登录。`)
          return {
            content: `🔐 【${sysName}】需要先完成本地登录才能继续（登录态只保存在本机，平台不存密码）。请在下方卡片完成登录后一键重试。`,
            success: false, traceId: trace.id,
            loginRequest: { systemId: systemId || 'rec', systemName: sysName, baseUrl, retryContent: data.content }
          }
        }
        sendLog('observing', `预检通过：【${sysName}】可达且已登录`)
        return null
      }

      // 代码型技能：type=python-sandbox 且带可执行代码 → 公司级后端 Docker 容器沙箱。
      // 沙箱只跑不可信代码、不触碰任何业务系统，故不受「只读模式」约束(只读保护的是业务系统写入)。
      if (skillType === 'python-sandbox' && skillCode.trim()) {
        await runCodeSkill(skillCode, skillSop, skl, sendLog, out)
        // 审计标记：本次经公司级 Docker 沙箱执行（成功与否都记，时间线体现结果）
        trace.sandboxUsed = true
        trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·代码技能', status: out.skillResult.startsWith('🐍') ? 'ok' : 'warn' })
        return null
      }

      // agentic bundle 技能：无直接可执行 code 但带整目录 bundle（SKILL.md+scripts，如 Anthropic 技能包）
      // → 模型读手册现场编写驱动脚本，与 bundle 一起送沙箱执行；失败自修复重试一轮。
      if (skillType === 'python-sandbox' && !skillCode.trim() && skillBundle.trim()) {
        await runAgenticSkill(skillBundle, skillSop, data, skl, sendLog, out, focusHint, materials)
        trace.sandboxUsed = true
        trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·agentic 技能', status: out.skillResult.startsWith('🤖') ? 'ok' : 'warn' })
        return null
      }

      // 知识/指南型技能：无厂商预置脚本，但常常是「为产出交付物服务」的规范/指南（如 brand-guidelines / frontend-design / canvas-design）。
      if (skillType === 'knowledge') {
        if (skillBundle.trim()) {
          // 带素材包 → 本就用于按规范产出交付物（海报/页面/设计稿/图表）。
          // 仍走公司级沙箱：模型读 SKILL.md 规范，现场编写生成脚本、产出文件（只是没有厂商脚本而已）。
          sendLog('acting', `技能「${skl}」为知识/指南型，将按其规范现场生成交付物…`)
          const isPoster = /海报|poster|展板|大图|宣传图|banner|封面|kv|主视觉/i.test(data.content)
          const CJK_FONT = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'   // 沙箱已装中文字体，pillow/matplotlib 画中文须加载它
          const posterRule = isPoster
            ? `\n【海报/视觉类硬性要求（务必满足）】\n- **大画布、铺满、字要大**：大幅面单张海报（竖版 1080×1920 或横版 1920×1080），固定画布、不要窄栏或大片空白；主标题 ≥ 90px、副标题 ≥ 44px、正文 ≥ 28px，粗体高对比；层次为 主标题→核心卖点→要点列表→落款日期；每个板块都要填入**来自请求的真实文字**，不要占位小字。\n- **中文必须正常显示（不能是方框）**：① 首选自包含 .html（内联 CSS，浏览器中文字体最全最稳）；② 若用 pillow/PIL 输出 .png，**必须**用中文字体 ImageFont.truetype('${CJK_FONT}', 字号)，**严禁** ImageFont.load_default()（中文会变方框）。配图用 CSS/形状/emoji，不外链字体或图片。`
            : `设计/前端/页面类优先自包含 .html（内联 CSS，正文 ≥ 16px）；若用 pillow/matplotlib 渲染含中文的图片，**必须**加载中文字体 '${CJK_FONT}'（pillow 用 ImageFont.truetype；matplotlib 设 font.sans-serif 为 'WenQuanYi Micro Hei'），不要用默认字体（中文会变方框）；报告/文档类输出 .docx/.pdf。`
          const guideHint = focusHint || `本技能是「知识/指南型」，没有预置脚本；请严格按下方 SKILL.md 的规范，为用户请求**生成对应的交付物文件并写入 /out/**：${posterRule}\n不要只在 stdout 打印内容而不产文件。`
          await runAgenticSkill(skillBundle, skillSop, data, skl, sendLog, out, guideHint, materials)
          trace.sandboxUsed = true
          trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·指南型生成', status: out.skillResult.startsWith('🤖') ? 'ok' : 'warn' })
          return null
        }
        // 纯 SOP（无素材包）→ 不进沙箱，由模型作为岗位专家把规范应用到答复中，不生成文件。
        sendLog('acting', `技能「${skl}」为知识/指南型，按其规范应用到本次产出…`)
        const sop = (skillSop || matchedSkill.sopContent || '').trim()
        out.skillResult = `已参照技能「${skl}」的规范/指南完成。`
        out.skillPromptHint = `【技能 "${skl}" · 知识/指南型】\n该技能是一份规范/指南（无可执行代码、不访问任何系统）。请你作为该岗位专家，严格依据下面的指南完成用户任务：把其中的规范、风格、约束、清单落实到你的产出与建议中。\n- 不要声称运行了任何脚本或访问了任何系统；\n- 若指南要求的某些素材（字体/图片/数据）本地不具备，就说明并给出可行替代；\n- 绝不编造不存在的业务数据（人名/单号/金额/日期）。\n\n【指南内容（SKILL.md）】\n${sop || '（该技能未提供指南正文）'}`
        trace.spans.push({ type: 'skill', name: `知识/指南型·${skl}`, status: 'ok' })
        return null
      }

      // 读取类判定（优先 FDE 标注的 skillKind；无标注则按脚本/步骤里有无写入动作推断）。
      // 读取类绝不走「只导航不取数」的 DSL/回放分支——否则只会回“请核对结果”而没有真实数据；
      // 应落到下方「打开目标页 + 抓取真实内容 + 按 SOP 整理」分支，由分身给出真正的待办/查询结果。
      // 写意图点击：点击「同意/提交/批准/删除/确认…」等改变业务状态的按钮 = 写操作。
      // 即便 FDE 录制把它误标为 read（纯"点同意"审批无填表字段就会这样），也一律按写处理——
      // 安全红线：写操作绝不静默执行，必须走「只读拦截」或「人工确认」。
      const writeIntentClick = (() => {
        try {
          const p = JSON.parse(actionScriptRaw || '{}')
          const st: AutomationStep[] = Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.hints) ? p.hints : []))
          return st.some((s) => { const a = s && (s.action || s.act); if (a === 'agent') return true; return (a === 'click' || a === 'tap' || a === 'button') && WRITE_INTENT_LABEL.test(String((s && (s.label || s.text || s.value)) || '')) })
        } catch (e) { swallow(e); return false }
      })()
      let isReadSkill = skillKind === 'read'
      if (writeIntentClick) {
        isReadSkill = false   // 覆盖误标：点了写按钮就是写
      } else if (!skillKind) {
        let hasWrite = /(^|\n)\s*(fill|select|searchSelect|dropdown|choose|upload|agent)\b/i.test(skillCode || '')
        if (!hasWrite) {
          try {
            const p = JSON.parse(actionScriptRaw || '{}')
            const st: AutomationStep[] = Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.hints) ? p.hints : []))
            hasWrite = st.some((s) => { const a = s && (s.action || s.act); return a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || !!(s && s.fieldName) })
              || (Array.isArray(p.fields) && p.fields.length > 0) || (Array.isArray(p.params) && p.params.length > 0)
          } catch (e) { swallow(e) }
        }
        isReadSkill = !hasWrite
      }

      // 只读模式（权限范围=只读）：拦截一切写入/操作类技能，绝不对业务系统做改动。
      // 弹**权限选择卡**（切到允许操作并重跑 / 继续保持只读）——而非只给一句"请手动去切"的文字（用户反馈）。
      if (data.permMode === 'readonly' && !isReadSkill) {
        sendLog('acting', `检测到写操作（${skl}），当前为只读——请先选择如何处理…`)
        const choice = await requestPermissionChoice([skl])
        if (choice === 'switch') {
          await trace.submit('用户选择切到「允许操作」后重跑本任务。', 'BLOCKED', `只读拦截写技能 "${skl}"，用户选择切档重跑。`)
          return { content: `🔄 已切到「允许操作」，正在按原任务重新执行…（写操作会请你人工确认）`, success: true, traceId: trace.id, permSwitch: true }
        }
        await trace.submit(data.content, 'BLOCKED', `只读模式拦截写入类技能 "${skl}"（用户选择继续只读）。`)
        return { content: `🔒 已选择继续保持**只读**：写入/操作类技能「${skl}」已跳过，未对业务系统做任何改动。`, success: true, traceId: trace.id }
      }

      // —— 语义脚本技能（DSL）：解释执行（灵活、可读可改），优先于原始录制回放 —— 仅写入/操作类走此分支 ——
      const dsl = parseDsl(skillCode)
      // 用 rawSteps 的录制选择器(fp.sel)回填 DSL 的 @sel：早期 readable() 丢了选择器，导致回放只能靠
      // 模糊 label 匹配 + 模型自愈、易定位到错控件（如 textarea#reason 被漏填）。回填后精确定位，救活现有技能。
      try {
        const parsed = JSON.parse(actionScriptRaw || '{}')
        const raw: { fp?: { sel?: string } }[] = Array.isArray(parsed.rawSteps) ? parsed.rawSteps : []
        if (raw.length === dsl.length) dsl.forEach((d, i) => {
          const sel = raw[i]?.fp?.sel
          if (!d.sel && sel && !/^(body|html|form)$/i.test(sel.trim())) d.sel = sel   // 只回填精确选择器，跳过 body/form 这类过宽的
        })
      } catch (e) { swallow(e) }
      if (dsl.length && !isReadSkill) {
        // 目标一致性闸已移除：它是"确定性回放会盲点录死 click 目标→点错单据"时代的预执行闸，会把
        // 「审批人为昕宇」这类**字段赋值**误当"点名对象"、跟录死的 click 值比对而误伤。browse 语义执行不盲点
        // 录死目标（以需求为准），且**写前签字钩子在提交前把真实单据读给用户签字**——批错对象在签字那步就拦住，
        // 比名字启发式强。故此闸既误伤又冗余，去掉。
        // 脚本里用到的参数 {{name}}
        const usedParams = new Set<string>()
        dsl.forEach(s => {
          const m = s.valueExpr.match(/^\{\{\s*([^{}]+?)\s*\}\}$/); if (m) usedParams.add(m[1])   // 参数键含中文，勿用 \w（否则识别不到→确认表单退化空）
          const am = (s.arg || '').match(/^\{\{\s*([^{}]+?)\s*\}\}$/); if (am) usedParams.add(am[1])   // arg 位参数（click "{{目标对象}}"，录制治本产物）
        })
        // 字段定义（含选项）来自 actionScript.fields，仅保留脚本实际用到的
        let scriptFields: VisitField[] = []
        try { const parsed = JSON.parse(actionScriptRaw || '{}'); if (Array.isArray(parsed.fields)) scriptFields = parsed.fields.map((f: any) => ({ name: f.name, label: f.label, type: f.type || 'text', value: '', options: Array.isArray(f.options) ? f.options : undefined })) } catch (e) { swallow(e) }
        scriptFields = scriptFields.filter(f => usedParams.has(f.name))
        usedParams.forEach(pn => { if (!scriptFields.find(f => f.name === pn)) scriptFields.push({ name: pn, label: pn, type: 'text', value: '' }) })

        const filledFields = scriptFields.length ? await extractFieldsByLabels(data.content, scriptFields, data.llmConfig, sendLog) : []
        // 写操作一律须人工确认：无 {{参数}} 的纯操作型脚本也要弹"操作确认"卡（列出关键动作）
        const clickSummary = dsl.filter(s => s.op === 'click' || s.op === 'tap').map(s => String((s as any).label || s.arg || '').trim()).filter(Boolean).join(' → ')
        const confirmFields: VisitField[] = filledFields.length
          ? filledFields
          : [{ name: '_confirm', label: '将执行的写操作（核对后确认，取消则不执行）', type: 'text', value: clickSummary || '执行该技能脚本的操作步骤' }]
        sendLog('acting', filledFields.length ? '已整理出待填写字段，请在下方表单卡片中核对并确认...' : '这是写操作，请在下方卡片中核对确认后执行…')
        const confirmed: Record<string, string> = await requestFormConfirmation(confirmFields)
        if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', `语义脚本技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId: trace.id } }
        const { sysName, baseUrl: sysUrl } = await resolveSystem()
        const baseUrl = sysUrl || (dsl.find(s => s.op === 'open')?.arg || '')
        const fieldTable = filledFields.length
          ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
          : ''
        if (!baseUrl) {
          await trace.submit(data.content, 'PARTIAL', `语义脚本技能 "${skl}"：已确认字段，但缺少可执行的目标系统地址。`)
          return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法执行。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true, traceId: trace.id }
        }
        { const gate = await preflightSystem(targetSystemId, baseUrl, sysName); if (gate) return gate }
        // 写入类执行迁到 browse 主引擎（语义可控执行）：以 SOP / 录制步骤为 hint、确认后的字段值为 fieldValues，
        // browse 读实时页面、语义定位、多步自适应把事办成——页面结构 / 标签变了也能自愈（对比确定性回放：标签一变即废）。
        // 终笔「读单据 → 签字」红线由 onWriteConfirm 钩子保留：browse 点提交 / 同意 / 删除等写按钮**之前**，
        // 把当前页面真实单据读出来给用户过目签字，未签则中止不点（先看清、再裁决——上次批错合同正是只确认一行字就签掉的）。
        let writeCancelled = false
        const onWriteConfirm = async (ctx: { actionLabel: string; pageText: string }): Promise<boolean> => {
          const roFields = buildSignFields(ctx.pageText, filledFields, confirmed, ctx.actionLabel)
          const r = await requestFormConfirmation(roFields)
          const okSign = !!(r && Object.keys(r).length > 0)
          if (!okSign) writeCancelled = true
          return okSign
        }
        // hint：优先用语义 SOP（Batch 1a 起录制即带 sopContent），缺失才由录制步骤渲染成人话操作提示。
        const stepsForHint: RecStep[] = (() => { try { const p = JSON.parse(actionScriptRaw || '{}'); return Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.hints) ? p.hints : [])) } catch { return [] } })()
        const hint = (skillSop && skillSop.trim()) ? skillSop : renderStepsHint(stepsForHint, confirmed)
        sendLog('acting', `正在用 browse 主引擎在【${sysName}】按语义执行（复用登录态；写操作提交前会请你核对单据签字）…`)
        const bres = await runBrowseExecutor({
          systemId: targetSystemId || 'rec', systemName: sysName, entryUrl: baseUrl,
          task: data.content, hint, fieldValues: confirmed,
          cfg: data.llmConfig, callModel: callLlm, sendLog,
          onWriteConfirm, maxSteps: 30, budgetMs: 600000,
        })
        // 写前签字被取消：干净收尾，不当失败讲，也不沉字段（没真写入）
        if (writeCancelled) {
          const content = `🚫 已在提交前取消，未点击写入按钮，未改动业务系统。${fieldTable}`
          await trace.submit(data.content, 'BLOCKED', `技能(browse) "${skl}"：用户在写前签字时取消。`)
          return { content, success: true, traceId: trace.id }
        }
        if (!bres.loggedIn) {
          const content = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
          await trace.submit(data.content, 'PARTIAL', `技能(browse) "${skl}"：未登录【${sysName}】。`)
          return { content, success: true, traceId: trace.id }
        }
        const outcome = bres.ok ? (bres.outcome || `✅ 已在【${sysName}】完成操作。`) : `未完全办成（${bres.failLabel || '多步未办成'}）：${bres.outcome || ''}`
        // 岗位画像沉淀：真实办成才沉（字段 ↔ 本体类型数据驱动映射，如「关联商机」→ 商机对象）
        if (bres.ok) {
          void sinkSkillFields({ expertId: data.expertId || '', skillLabel: skl, systemId: targetSystemId, traceId: trace.id, llmConfig: data.llmConfig, sendLog, explicitMap: focusMap, fields: filledFields.map(f => ({ label: f.label, value: (confirmed[f.name] || '').trim() })) })
        }
        await trace.submit(data.content, bres.ok ? 'SUCCESS' : 'PARTIAL', `技能(browse) "${skl}" 执行：${bres.steps} 步。`)
        return { content: `✅ 已执行技能「${skl}」（browse 语义执行）。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true, traceId: trace.id }
      }

      // —— 录制回放型技能：有可回放的录制步骤时，按字段确认 → 确定性回放（兼容旧录制） ——
      // 兼容两种存法：parsed.steps（旧）与 parsed.rawSteps（from-recording 入库字段）。
      let recParsed: any = null
      try { recParsed = actionScriptRaw ? JSON.parse(actionScriptRaw) : null } catch (e) { swallow(e) }
      const recSteps: RecStep[] = recParsed && Array.isArray(recParsed.steps) ? recParsed.steps
        : (recParsed && Array.isArray(recParsed.rawSteps) ? recParsed.rawSteps
        : (recParsed && Array.isArray(recParsed.hints) ? recParsed.hints : []))   // v3：录制步骤降级为 hints
      // 是否为写入/表单类技能：有填写/选择动作、或标注了字段、或声明了表单字段。
      // 读取类技能（纯导航/点击）不走脆弱的确定性回放——录制步骤格式（act/nav/fp）与旧回放引擎
      // 期望的 selector 也对不上，且对折叠菜单/hash 路由极易失败——改走更稳的「SOP 打开页面+抓取」。
      const isWriteStep = (s: any) => { const a = s && (s.action || s.act); return a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || a === 'choose' || a === 'upload' || a === 'agent' || !!(s && s.fieldName) }
      // 优先用 FDE 录制时判定的 skillKind；缺失才按步骤兜底推断。
      const hasWriteOps = writeIntentClick ? true          // 写意图点击优先（覆盖误标的 read）
        : skillKind === 'write' ? true
        : skillKind === 'read' ? false
        : (recSteps.some(isWriteStep) || (recParsed && Array.isArray(recParsed.fields) && recParsed.fields.length > 0) || (recParsed && Array.isArray(recParsed.params) && recParsed.params.length > 0))
      // 导航 hash（折叠侧边栏/SPA 路由场景）：优先用 FDE 录制到的 navHash，缺失才从步骤里找。
      const recNavHash: string = skillNavHash || (recSteps.find((s: any) => s && s.nav) as any)?.nav || ''

      // 该技能未绑定业务系统时，是否应走「公网检索」。
      // 仅限「公开信息类」技能（标讯/招标/行业调研/新闻/行情/政策/官网等）——这些公网真能查到；
      // 「需登录平台的数据类」技能（简历/候选人/CRM/OA/待办/审批/内部系统）绝不退化为公网检索充数，
      // 因为真实个人/业务数据在登录墙后，公网只会搜到无关资讯。这类未连接时走「澄清画像+提示连接平台」。
      const skillText2 = (matchedSkill.name || '') + '\n' + (matchedSkill.sopContent || '')
      const platformGated = /(简历|候选人|人才库|人才搜索|招聘平台|ats|猎聘|boss|前程无忧|智联|crm|oa|待办|审批|内部系统|工单|登录态|账号密码)/i.test(skillText2)
      const publicWebIntent = /(标讯|招标|中标|投标|政府采购|项目线索|行业(调研|动态|资讯|分析)|市场调研|新闻|资讯|最新(消息|动态|政策|情况|进展)|行情|股价|汇率|百度|谷歌|google|bing|官网|公开(信息|资料|数据)|联网(查|搜|检索)|网上(查|搜))/i.test(skillText2)
      const webSearchIntent = publicWebIntent && !platformGated
      let deferToWebSearch = false

      // —— 读取/查询类技能：脚本/直达路由导航到目标子页 → 抓取真实页面内容 → 交分身按 SOP 整理 ——
      // （读取类不取数只导航没有意义，必须把真实内容抓回来由分身整理，绝不回“请自行核对”。）
      if (isReadSkill && !skillHandled) {
        const { sysName, baseUrl: sysUrl } = await resolveSystem()
        const baseUrl = sysUrl || (dsl.find(s => s.op === 'open')?.arg || '') || (recSteps[0] as any)?.url || ''
        if (!baseUrl && webSearchIntent) {
          // 未绑定业务系统、但本质是联网检索型技能 → 交由下方「联网检索」分支执行真实检索
          deferToWebSearch = true
        } else if (!baseUrl) {
          // 未绑定业务系统、且非检索型 → 作为「知识/推理型技能」由大模型按 SOP 执行（不一律判“未执行”）
          out.skillResult = `已按技能「${skl}」的标准作业流程执行（该技能未连接业务系统，基于大模型推理与当前上下文完成）。`
          out.skillPromptHint = `【技能 "${skl}" 执行 · 知识/推理型】\n该技能未连接可访问的业务系统，请你作为该岗位专家，严格按下面的 SOP，基于用户输入、已上传附件与工作空间内容进行推理、整理与产出，完成你能完成的部分。\n- 若 SOP 中某一步骤确实需要某个尚未连接系统的实时数据（如需登录某平台抓取真实记录/列表），请明确指出该步骤需先到「设置 → 企业系统连接」连接对应系统；\n- 绝对不要编造任何不存在的真实业务数据（具体人名、单号、简历、待办条目、金额、日期）。\n\n【SOP】\n${matchedSkill.sopContent}`
        } else {
          { const gate = await preflightSystem(targetSystemId, baseUrl, sysName); if (gate) return gate }
          // browse 主引擎只读语义导航到目标页 + read 读真实正文（比确定性直达/DSL 更能穿透折叠菜单/JS 路由）；
          // navHash 作为入口提示拼进 entryUrl；**只读绝不写入**；读到的原文交下方按 SOP 严格整理（绝不编造，护栏不弱化）。
          const readEntry = recNavHash ? (baseUrl.replace(/#.*$/, '') + (recNavHash.startsWith('#') ? recNavHash : '#' + recNavHash)) : baseUrl
          const rbres = await runBrowseExecutor({
            systemId: targetSystemId || 'rec', systemName: sysName, entryUrl: readEntry,
            task: data.content, hint: (skillSop && skillSop.trim()) ? skillSop : renderStepsHint(recSteps as RecStep[]),
            cfg: data.llmConfig, callModel: callLlm, sendLog, readonly: true, maxSteps: 22, budgetMs: 300000,
          })
          const okR = true                        // browse 跑过即算访问到系统；登录/内容质量由下面分支细分
          const loggedIn = rbres.loggedIn
          const pageText = rbres.pageText || ''    // 最后一次 read 的目标页真实正文（只读，绝不编造）
          const pageTitle = ''
          if (!okR) {
            out.skillResult = `❌ 后台访问【${sysName}】失败。`
            out.skillPromptHint = `【技能执行失败】访问【${sysName}】失败。请如实告知用户失败、建议检查系统地址/网络，勿编造数据。`
          } else if (!loggedIn) {
            out.skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录该系统（登录态本地保存），随后再次发起。`
            out.skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时未登录，未获取到任何真实数据。请：1) 告知用户先到「设置 → 企业系统连接」完成【${sysName}】本地登录后重试；2) 依据下面 SOP 给出手动操作指引。这不是真实数据，勿编造待办/条目/数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if ((pageText || '').length > 40) {
            out.skillResult = `已在【${sysName}】中实际打开目标页面并抓取到真实内容，正在按标准流程整理。`
            out.skillPromptHint = `【技能 "${skl}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${pageTitle}）：\n"""\n${pageText}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户（如为待办/列表，请逐条列出标题、发起人、时间等页面可见字段）。若内容与任务无关、为空、或仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else {
            out.skillResult = `⚠️ 已打开【${sysName}】但未抓取到有效内容（可能仍停留在首页或目标列表为空）。`
            out.skillPromptHint = `【技能执行 · 内容不足】已在【${sysName}】打开页面但未取到有效正文（可能未导航到目标子页或列表为空）。请如实告知用户，并依据下面 SOP 给出手动操作指引，勿编造数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          }
        }
        // 联网检索型技能延后到下方检索分支处理；其余读取类已在此抓取并整理。
        skillHandled = !deferToWebSearch
      }

      if (recSteps.length > 0 && hasWriteOps && !skillHandled) {
        const steps = recSteps
        // v3（语义 SKILL）：params 是参数单一来源（{name,type,sample,options}）；v2/v1 退回 fields。
        // 候选只给真正的封闭下拉（select）——search（检索选人/选对象，如审批人/异常类型）的"候选"是录制那一刻
        // 弹层恰好渲染的内容，不完整也不可信，带上会被确认卡渲染成残缺下拉、还会吞掉不在候选里的提取值；
        // search 一律自由输入，值由 browse 执行时现场检索选中。
        const scriptFields: VisitField[] = recParsed && Array.isArray(recParsed.params) && recParsed.params.length
          ? recParsed.params.map((f: any) => ({ name: String(f.name), label: String(f.name), type: f.type === 'date' ? 'date' : 'text', value: '', options: f.type === 'select' && Array.isArray(f.options) && f.options.length ? f.options : undefined }))
          : (recParsed && Array.isArray(recParsed.fields)
            ? recParsed.fields.map((f: any) => ({ name: f.name, label: f.label, type: f.type || 'text', value: '', options: Array.isArray(f.options) ? f.options : undefined }))
            : [])
        // AI 动态参数：actionScript.fields 缺省时，从语义 SOP 的 {{占位}} 派生参数字段——
        // 让"审批人/类型/原因/日期"等只要在 SOP 里写成 {{审批人}} 就能被动态提取+确认，再交 browse 现场填。
        if (skillSop && skillSop.trim()) {
          const seen = new Set(scriptFields.map(f => f.label || f.name))
          ;(skillSop.match(/\{\{\s*([^{}]+?)\s*\}\}/g) || []).forEach((m: string) => {
            const p = m.replace(/[{}]/g, '').trim()
            if (p && !seen.has(p)) { seen.add(p); scriptFields.push({ name: p, label: p, type: 'text', value: '' }) }
          })
        }
        {
          // 目标一致性闸已移除（同 DSL 分支理由）：browse 语义执行以需求为准、不盲点录死目标，
          // 写前签字钩子在提交前读真实单据给用户签字——批错对象在签字那步拦住，去掉误伤又冗余的预执行闸。
          // ① 抽取字段值。输入并入最近几轮用户消息——缺参追问后用户只回一句"昕宇"时，
          //    重路由进来靠上文才能把参数补上（当前句里没有技能词也没有其它参数）。
          const extractInput = [...(data.history || []).filter(h => h.role === 'user').slice(-3).map(h => h.content), data.content].join('\n')
          const filledFields = scriptFields.length ? await extractFieldsByLabels(extractInput, scriptFields, data.llmConfig, sendLog) : []
          // ①c 确定性回填：LLM 没提取到的参数，用两条零成本规则从原话直接补，防止"明说了还被追问"的假阴性——
          //   a) 候选直配：参数有 options 且原话出现某候选文本 → 填该候选（"类型为因公误时"，因公误时∈「异常类型」候选）；
          //   b) 名称直配：原话出现「参数名(或其头/尾两字)＋为/是/：＋值」→ 取值（"审批人为昕宇"→审批人=昕宇，"异常类型"尾词"类型"也能对上）。
          if (recParsed && recParsed.version === 3 && Array.isArray(recParsed.params)) {
            const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            for (const p of recParsed.params) {
              const nm = String((p && p.name) || '').trim(); if (!nm) continue
              const f = filledFields.find(x => x.name === nm || x.label === nm)
              if (f && (f.value || '').trim()) continue
              let v = ''
              if (Array.isArray(p.options) && p.options.length) {
                const hit = p.options.map(String).filter((o: string) => o && extractInput.includes(o)).sort((a: string, b: string) => b.length - a.length)[0]
                if (hit) v = hit
              }
              if (!v) {
                const cands = Array.from(new Set([nm, nm.length > 2 ? nm.slice(-2) : '', nm.length > 2 ? nm.slice(0, 2) : ''].filter(Boolean)))
                for (const c of cands) {
                  const m = extractInput.match(new RegExp(reEsc(c) + '[^，。,；;、\\n]{0,2}?[为是:：]\\s*([^，。,；;、\\n\\s]{1,20})'))
                  if (m && m[1]) { v = m[1]; break }
                }
              }
              if (v) { if (f) f.value = v; else filledFields.push({ name: nm, label: nm, type: 'text', value: v }) }
            }
          }
          // ①b 缺参追问（v3 语义 SKILL）：必填参数没提取到 → 先问清再执行，绝不带缺参碰业务系统。
          if (recParsed && recParsed.version === 3 && Array.isArray(recParsed.params)) {
            const requiredNames: string[] = recParsed.params.filter((p: any) => p && p.required).map((p: any) => String(p.name))
            const missing = requiredNames.filter(nm => { const f = filledFields.find(x => x.name === nm || x.label === nm); return !f || !(f.value || '').trim() })
            if (missing.length) {
              const skillShown = skillDisplayName(matchedSkill.id) || (matchedSkill.name && matchedSkill.name !== matchedSkill.id ? matchedSkill.name : '') || skl
              const got = filledFields.filter(x => (x.value || '').trim()).map(x => `${x.label}=${x.value}`).join('、')
              // 待续技能：记下"这单还没办完、在等补参"。下一条短回复（如"审批人：昕宇"）由路由层**确定性**
              // 拉回本技能——不赌语义路由（实测补答被路由进裸问答，模型编造"已生成并准备推送"，红线事故）。
              try { configSet('pending-skill', JSON.stringify({ skillId: matchedSkill.id, convId: data.convId || '', at: Date.now() })) } catch (e) { swallow(e, 'pending-skill-set') }
              const content = `办理「${skillShown}」还差 ${missing.map(m => `「${m}」`).join('、')}${got ? `（已收到：${got}）` : ''}——请问${missing[0]}是？（直接回复即可，如：${missing[0]}是××）`
              sendLog('completed', `缺少必填参数：${missing.join('、')}，已暂停等待补充，未对业务系统做任何操作。`)
              await trace.submit(data.content, 'PARTIAL', `录制技能 "${skillShown}"：缺必填参数 ${missing.join('、')}，追问中。`)
              return { content, success: true, traceId: trace.id }
            }
            configSet('pending-skill', '')   // 参数齐了：清掉待续标记，进入确认/执行
          }
          // ①d 候选完整性兜底：已提取/直配的值不在该字段候选里（录制抓的候选常残缺）→ 去掉候选降级为自由输入，
          // 否则确认卡的下拉显示不了这个值、会把它重置成"（请选择）"静默吞掉。
          for (const f of filledFields) {
            if (Array.isArray(f.options) && f.options.length && (f.value || '').trim() && !f.options.includes(f.value.trim())) f.options = undefined
          }
          // ② 写操作一律须人工确认（安全红线）：有可填字段→核对字段值；无字段（纯"点同意/提交/删除"操作）→合成"操作确认"卡后放行。
          const clickSummary = steps.filter((s: any) => { const a = s && (s.action || s.act); return a === 'click' || a === 'tap' || a === 'button' })
            .map((s: any) => String((s && (s.label || s.text)) || '').trim()).filter(Boolean).join(' → ')
          const confirmFields: VisitField[] = filledFields.length
            ? filledFields
            : [{ name: '_confirm', label: '将执行的写操作（核对后确认，取消则不执行）', type: 'text', value: clickSummary || '执行录制的操作步骤' }]
          sendLog('acting', filledFields.length ? '已整理出待填写字段，请在下方表单卡片中核对并确认...' : '这是写操作，请在下方卡片中核对确认后执行…')
          const confirmed: Record<string, string> = await requestFormConfirmation(confirmFields)
          if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', `录制技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId: trace.id } }
          // 解析绑定系统地址
          let sysName = '业务系统'; let baseUrl = ''
          if (targetSystemId) {
            try {
              const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
              if (ir.ok) { const list = await ir.json() as SystemInfo[]; const sys = Array.isArray(list) ? list.find((x) => x.id === targetSystemId) : null; if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl } }
            } catch (e) { swallow(e) }
          }
          if (!baseUrl) { baseUrl = steps[0]?.url || '' }

          const fieldTable = filledFields.length
            ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
            : ''

          if (!baseUrl) {
            await trace.submit(data.content, 'PARTIAL', `录制技能 "${skl}"：已确认字段，但缺少可回放的目标系统地址。`)
            return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法回放。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true, traceId: trace.id }
          }

          // ③ browse 主引擎语义执行（客户端录制技能主路）：复用登录态，SOP 作可控计划、录制步骤作 hint，
          //    页面结构/标签变了也能自愈（对比确定性回放：标签一变即废）。写按钮提交前经 onWriteConfirm 读单据签字。
          { const gate = await preflightSystem(targetSystemId, baseUrl, sysName); if (gate) return gate }
          let writeCancelled = false
          const onWriteConfirm = async (ctx: { actionLabel: string; pageText: string }): Promise<boolean> => {
            const roFields = buildSignFields(ctx.pageText, filledFields, confirmed, ctx.actionLabel)
            const r = await requestFormConfirmation(roFields)
            const okSign = !!(r && Object.keys(r).length > 0)
            if (!okSign) writeCancelled = true
            return okSign
          }
          // 走分步引擎的前提：v3 且 SOP 是**真操作计划**（含编号步骤行）。占位/一句话 SOP（如旧后端硬编的
          // "本技能通过实操录制生成…"）解析不出有效步骤，硬走分步只会拿废话指令空转——退回整体语义执行。
          const isV3Sop = !!(recParsed && recParsed.version === 3 && skillSop && /^\s*\d{1,2}[.、)]/m.test(skillSop))
          if (isV3Sop) {
            // v3 语义 SKILL：SOP 分步推进（每步 ✓ 汇报、失败停步如实报告、提交步签字、完成回读凭据）。
            sendLog('acting', `正在按 SOP 分步办理【${sysName}】（共 ${skillSop.split(/\n/).filter(l => /^\s*\d+[.、)]/.test(l)).length} 步；提交前会请你核对单据签字）…`)
            // 人工接管兜底（attended mode）：自动化搞不定的那一步，弹卡请用户在可视化窗口手动完成，
            // 确认后该步标 ✓ 继续自动化。95% 自动 + 5% 人点一下 = 100% 可靠。
            const onHumanAssist = async (ctx: { stepIndex: number; stepText: string; reason: string }): Promise<boolean> => {
              const fields: VisitField[] = [
                { name: '_step', label: `第 ${ctx.stepIndex + 1} 步需要你搭把手`, value: ctx.stepText, type: 'text', readonly: true },
                { name: '_why', label: '自动化卡住的原因', value: String(ctx.reason || '').slice(0, 200), type: 'text', readonly: true },
                { name: '_how', label: '怎么做', value: '请在弹出的「iML 分身操作中」浏览器窗口里手动完成上面这一步（其它都不用动），完成后点「确认」——后续步骤会继续自动执行；点「取消」则终止本次办理。', type: 'text', readonly: true },
              ]
              const r = await requestFormConfirmation(fields)
              return !!(r && Object.keys(r).length > 0)
            }
            const sres = await runSkillStepper({
              systemId: targetSystemId || 'rec', systemName: sysName, entryUrl: baseUrl,
              sop: skillSop, task: data.content, fieldValues: confirmed,
              hint: renderStepsHint(steps as RecStep[]),   // 录制轨迹（控件名/顺序）供各步定位提效
              cfg: data.llmConfig, callModel: callLlm, sendLog, onWriteConfirm, onHumanAssist,
            })
            if (sres.cancelled || writeCancelled) {
              const content = `🚫 已在提交前取消，未点击写入按钮，未改动业务系统。${fieldTable}`
              await trace.submit(data.content, 'BLOCKED', `录制技能(分步) "${skl}"：用户在写前签字时取消。`)
              return { content, success: true, traceId: trace.id }
            }
            if (!sres.loggedIn) {
              const content = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
              await trace.submit(data.content, 'PARTIAL', `录制技能(分步) "${skl}"：未登录【${sysName}】。`)
              return { content, success: true, traceId: trace.id }
            }
            // 回读凭据 + 字段回显核对（确认值出现在回读页面 = 确实写入；缺的如实列出）
            const normV = (s: string) => String(s || '').replace(/[\s,，¥￥$%]/g, '')
            const vt = normV(sres.verifyText)
            const missEcho = filledFields.map(f => ({ label: f.label, val: normV((confirmed[f.name] || '').trim()) }))
              .filter(x => x.val && vt && !vt.includes(x.val.length > 10 ? x.val.slice(0, 10) : x.val)).map(x => x.label)
            const verifyNote = sres.verifyText
              ? (missEcho.length ? `\n\n⚠️ 回读页面未见到字段：${missEcho.join('、')}——**不能确认已写入**，请到系统里核对。` : `\n\n已回读页面核对，确认内容已生效。`)
              : ''
            // 真成功 = 步骤全过 **且** 回读页面能见到确认过的字段值。回读对不上就绝不喊"已办理"
            //（血泪：曾"✅完成全部1/1步"+"回读未见任何字段"同屏矛盾，实际什么都没提交）。
            const verified = sres.ok && !missEcho.length
            const outcome = sres.ok ? `${verified ? '✅' : '⚠️'} ${sres.outcome}。${verifyNote}` : `❌ ${sres.outcome}${sres.verifyText ? `\n\n（当页快照：${sres.verifyText.slice(0, 200)}…）` : ''}`
            if (verified) {
              void sinkSkillFields({ expertId: data.expertId || '', skillLabel: skl, systemId: targetSystemId, traceId: trace.id, llmConfig: data.llmConfig, sendLog, explicitMap: focusMap, fields: filledFields.map(f => ({ label: f.label, value: (confirmed[f.name] || '').trim() })) })
            }
            await trace.submit(data.content, verified ? 'SUCCESS' : 'PARTIAL', `录制技能(分步) "${skl}"：${sres.done}/${sres.total} 步${sres.failedAt >= 0 ? `，停在第 ${sres.failedAt + 1} 步` : ''}${sres.ok && !verified ? '，回读未确认写入' : ''}。`)
            return { content: `${verified ? '✅ 已办理' : sres.ok ? '⚠️ 已执行但未确认写入' : '⚠️ 部分完成'}「${skl}」（SOP 分步执行 ${sres.done}/${sres.total}）。\n\n${outcome}${fieldTable}`, success: true, traceId: trace.id }
          }
          // v2/v1 老技能：browse 一口气语义执行（SOP/步骤作 hint）
          const hint = (skillSop && skillSop.trim()) ? skillSop : renderStepsHint(steps as RecStep[], confirmed)
          sendLog('acting', `正在用 browse 主引擎在【${sysName}】按语义执行录制技能（复用登录态；写操作提交前会请你核对单据签字）…`)
          const bres = await runBrowseExecutor({
            systemId: targetSystemId || 'rec', systemName: sysName, entryUrl: baseUrl,
            task: data.content, hint, fieldValues: confirmed,
            cfg: data.llmConfig, callModel: callLlm, sendLog,
            onWriteConfirm, maxSteps: 30, budgetMs: 600000,
          })
          if (writeCancelled) {
            const content = `🚫 已在提交前取消，未点击写入按钮，未改动业务系统。${fieldTable}`
            await trace.submit(data.content, 'BLOCKED', `录制技能(browse) "${skl}"：用户在写前签字时取消。`)
            return { content, success: true, traceId: trace.id }
          }
          if (!bres.loggedIn) {
            const content = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
            await trace.submit(data.content, 'PARTIAL', `录制技能(browse) "${skl}"：未登录【${sysName}】。`)
            return { content, success: true, traceId: trace.id }
          }
          const outcome = bres.ok ? (bres.outcome || `✅ 已在【${sysName}】完成操作。`) : `未完全办成（${bres.failLabel || '多步未办成'}）：${bres.outcome || ''}`
          // 岗位画像沉淀：真实办成才沉（字段 ↔ 本体类型数据驱动映射）
          if (bres.ok) {
            void sinkSkillFields({ expertId: data.expertId || '', skillLabel: skl, systemId: targetSystemId, traceId: trace.id, llmConfig: data.llmConfig, sendLog, explicitMap: focusMap, fields: filledFields.map(f => ({ label: f.label, value: (confirmed[f.name] || '').trim() })) })
          }
          await trace.submit(data.content, bres.ok ? 'SUCCESS' : 'PARTIAL', `录制技能(browse) "${skl}" 执行：${bres.steps} 步。`)
          return { content: `✅ 已执行录制技能「${skl}」（browse 语义执行）。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true, traceId: trace.id }
        }
      }

      // —— 客户拜访记录录入 CRM 的结构化流程：抽取参数 → 表单确认 → 无头浏览器录入 ——
      const skillText = `${matchedSkill.name || ''}\n${matchedSkill.sopContent || ''}`
      const isVisitRecord = /拜访/.test(skillText) && /(crm|拜访反馈|拜访记录|客户管理|拜访过程反馈)/i.test(skillText)
      if (isVisitRecord && !skillHandled) {
        // ① 抽取
        const fields = await extractVisitFields(data.content, data.llmConfig, sendLog)
        // ② 对话框表单确认（阻塞等待用户在卡片中确认）
        sendLog('acting', '已整理出待录入 CRM 的字段，请在下方表单卡片中核对并确认...')
        const confirmed = await requestFormConfirmation(fields)
        if (fields.length && (!confirmed || Object.keys(confirmed).length === 0)) { const content = `🚫 已取消客户拜访记录录入，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', '拜访记录录入：用户取消确认。'); return { content, success: true, traceId: trace.id } }

        // 解析绑定的目标 CRM 系统地址
        let sysName = 'CRM'
        let baseUrl = ''
        if (targetSystemId) {
          try {
            const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
            if (ir.ok) {
              const list = await ir.json() as SystemInfo[]
              const sys = Array.isArray(list) ? list.find((x) => x.id === targetSystemId) : null
              if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl }
            }
          } catch (e) { swallow(e) }
        }

        const tbl = fields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')
        const confirmedTable = `| 字段 | 值 |\n| --- | --- |\n${tbl}`

        if (!baseUrl) {
          await trace.submit(data.content, 'PARTIAL', '拜访记录：已抽取并确认字段，但该技能未绑定可自动录入的 CRM 系统。')
          return {
            content: `✅ 已根据您的拜访记录整理并确认以下字段：\n\n${confirmedTable}\n\n⚠️ 但该技能尚未在管理端「业务系统连接」中绑定可自动录入的 CRM，因此暂未执行无头浏览器录入。请到管理端为该技能绑定目标 CRM 后重试。`,
            success: true, traceId: trace.id
          }
        }

        // ③ 无头浏览器录入
        { const gate = await preflightSystem(targetSystemId, baseUrl, sysName); if (gate) return gate }
        const entry = await fillCrmVisitForm(targetSystemId, baseUrl, sysName, confirmed, fields, sendLog)
        let outcome = ''
        if (!entry.ok) {
          outcome = `❌ 无头浏览器访问【${sysName}】失败：${entry.error || '未知错误'}。已保留上述参数，请检查系统地址/网络后重试。`
        } else if (!entry.loggedIn) {
          outcome = `⚠️ 检测到尚未登录【${sysName}】，无法录入。请先到「设置 → 企业系统连接」完成该系统登录（登录态会本地保存复用），随后再次发起即可。`
        } else {
          const filledLine = entry.filled.length ? `已自动填充字段：**${entry.filled.join('、')}**。` : '当前页面未匹配到对应的可填写控件。'
          const missingLine = entry.missing.length ? `\n未能在当前页面定位到：${entry.missing.join('、')}。` : ''
          outcome = `🤖 已在后台打开【${sysName}】并复用登录态执行录入。${filledLine}${missingLine}\n\n说明：自动填充按字段标签就近匹配当前页面的表单控件。若部分字段（尤其是下拉框、带 \`+\` 的检索框）未填充，通常是因为需要先在 CRM 中导航到“客户管理 → 拜访反馈 → 新建”表单页，或该 CRM 的控件需要专用选择器适配——这部分可按你的 CRM（如纷享销客）页面结构进一步配置。请在 CRM 中核对后点击保存。`
        }
        await trace.submit(data.content, entry.ok && entry.loggedIn ? 'SUCCESS' : 'PARTIAL', `拜访记录录入：抽取→用户确认→无头浏览器(${entry.ok ? (entry.loggedIn ? '已尝试填充' : '未登录') : '失败'})。`)
        return { content: `✅ 已确认并执行客户拜访记录录入。\n\n**确认的录入参数：**\n\n${confirmedTable}\n\n**执行结果：**\n\n${outcome}`, success: true, traceId: trace.id }
      }

      if (skillHandled) {
        // 读取类已在上面抓取并设置整理提示，跳过默认的"打开首页抓取"。
      } else if (targetSystemId) {
        // 解析目标系统地址（来自管理端"业务系统连接"）。
        let sysName = '业务系统'
        let baseUrl = ''
        try {
          const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
          if (ir.ok) {
            const list = await ir.json() as SystemInfo[]
            const sys = Array.isArray(list) ? list.find((x) => x.id === targetSystemId) : null
            if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl }
          }
        } catch (e) { swallow(e) }

        if (!baseUrl) {
          out.skillResult = `❌ 技能 "${skl}" 绑定的业务系统不存在或已被删除，无法执行。`
          out.skillPromptHint = `【技能未执行】技能 "${skl}" 绑定的目标业务系统不可用。请如实告知用户该技能未能执行、原因是目标系统未配置，绝对不要编造任何业务数据或待办。\n\n【SOP 仅供参考】\n${matchedSkill.sopContent}`
        } else {
          const ext = await openSystemAndExtract(targetSystemId, baseUrl, sysName, sendLog, recNavHash)
          if (ext.ok && ext.loggedIn && ext.text.length > 40) {
            out.skillResult = `已在【${sysName}】中实际打开页面并抓取到真实内容，正在交由分身按标准流程整理。`
            out.skillPromptHint = `【技能 "${skl}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${ext.title}）：\n"""\n${ext.text}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户。如果这些内容与用户任务无关、为空、或看起来仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if (ext.ok && !ext.loggedIn) {
            out.skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先在「设置 → 企业系统连接」中登录该系统（登录态会保存在本地），随后再次发起该任务即可。`
            out.skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时发现当前未登录，无法获取任何真实数据。请按以下两点回复用户：\n1) 首先明确告知：需要先到「设置 → 企业系统连接」完成【${sysName}】的本地登录（登录态会保存在本地、可复用），登录后再次发起本任务即可由分身自动获取。\n2) 然后，依据下面的 SOP，给出一份清晰、可照做的「手动操作指引」（编号分步），让用户在登录前也能自己先操作。\n注意：这是操作指引，不是已抓取的真实数据；绝对不要编造任何待办条目、发起人、单号或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else {
            out.skillResult = `❌ 访问【${sysName}】失败：${ext.error || '未知错误'}`
            out.skillPromptHint = `【技能执行失败】访问【${sysName}】失败，原因："${ext.error || '未知错误'}"。请如实告知用户失败原因并建议检查系统地址/网络，绝对不要编造任何数据。`
          }
        }
      } else if (webSearchIntent) {
        // 公开信息类技能（标讯/招标/行业调研等）→ 执行联网检索能力（检索词带上技能意图，更对口）。
        const sklName = skillDisplayName(matchedSkill.id) || (matchedSkill.name !== matchedSkill.id ? matchedSkill.name : '该技能要找的信息')
        const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
        try {
          const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog, sklName, matchedSkill.sopContent, false, data.history)
          const r = await webSearch(sq, sendLog, data.llmConfig)
          const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}｜信源级别：${p.tier || sourceTier(p.url)}】\n${p.text}`).join('\n\n')
          out.skillResult = `技能 "${skl}" 已联网检索「${sq}」。`
          out.skillPromptHint = r.results.length
            ? `【技能 "${skl}" · 联网检索真实结果】检索词：「${sq}」。\n— 结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文）'}\n\n请严格按下面的 SOP 整理回答，但务必先做一步**相关性判断**：\n- 该技能要找的是【${sklName}】这一类对象。请只挑选**确实属于这一类**的检索结果整理成 SOP 要求的列表格式（如标讯须为"招标/中标/采购公告"类网页，逐条给出发布时间、标题、发布单位、详情链接）。\n- 若上面的检索结果**不是**该类对象（例如要找招标公告却只搜到行业资讯、企业介绍、新闻、招聘等无关内容），**绝对不要**把它们硬凑、改写或包装成该技能的结果；应按 SOP 的"未找到"话术如实告知用户未检索到相关${sklName}，并建议补充更具体的关键词/企业名/地区后重试。\n- 结尾另起一行写「来源：」，把真正引用到的网页写成 Markdown 链接「- [网页标题](链接)」；严禁编造任何不在上述内容中的条目、单位、时间或链接。\n\n【SOP】\n${matchedSkill.sopContent}`
            : `【技能 "${skl}" · 联网检索】对「${sq}」未检索到结果，可能网络受限或无相关${sklName}。请如实告知用户未检索到，并建议更换/补充关键词，勿编造。`
        } catch (e: any) {
          out.skillResult = `❌ 联网检索失败：${e.message}`
          out.skillPromptHint = `【联网检索失败】"${e.message}"。请如实告知用户，勿编造。`
        }
      } else {
        // 未绑定业务系统、也无原生实现 —— 作为「知识/推理型技能」由大模型按 SOP 执行。
        // 很多技能（撰写/分析/规划/答疑/草拟）本就不依赖业务系统，不应一律判为“未执行”。
        out.skillResult = `已按技能「${skl}」的标准作业流程执行（该技能为知识/推理型，基于大模型与当前上下文完成）。`
        out.skillPromptHint = `【技能 "${skl}" 执行 · 知识/推理型】\n该技能不依赖业务系统、也无需自动化网页操作，请你作为该岗位专家，严格按下面的 SOP 完成用户任务：基于用户输入、已上传附件与工作空间内容进行推理、整理与产出。\n- 若 SOP 中某一步骤确实需要某个尚未连接系统的实时数据，请完成你能完成的部分，并明确指出哪一步需要先到「设置 → 企业系统连接」连接对应系统；\n- 绝对不要编造任何不存在的真实业务数据（具体人名、单号、简历、待办条目、金额、日期）。\n\n【SOP】\n${matchedSkill.sopContent}`
      }
  return null
}

// ── 任务编排（planner-executor）─────────────────────────────────────────────
// 一句话含多个异构诉求（读+写、多技能+联网）时，把请求拆成有序子任务依次执行：
// 读取/生成类自动跑；写入类子任务在其内部自然弹出「人工确认 + 一次性签名令牌」流程；
// 最后合并成一条回复 + 一条审计（写子任务的确认/取消状态都如实体现，绝不自动串写）。
