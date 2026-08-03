// 「不碰业务系统」的技能形态分发（从 runCustomSkill 拆出——体检 P2-16：原函数 625 行内联十余种形态）。
//
// 这四种形态的共同点：**不接触任何业务系统**（不登录、不导航、不写入），因此不受只读模式约束、
// 也不需要写确认闸——判定与执行都能独立于主函数的业务系统链路。命中即在此跑完并返回 true；
// 未命中返回 false，主函数继续走系统路径（DSL 写 / 录制回放 / 读取抓取 / 联网检索 / 知识推理）。
// 逻辑与拆分前逐字一致，只是换了个住处。
//
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑验证。
import { runDeepResearch } from './deep-research'
import { IMAGE_GEN_MARKER, VIDEO_GEN_MARKER, runImageGen, runVideoGen } from './media-gen'
import { DEEP_RESEARCH_MARKER, runCodeSkill, runAgenticSkill } from './skill-exec'
import type { SkillDefinition } from './skill-store'
import type { AgentTaskData, SkillExecOut } from './agent-types'
import type { AgentTrace } from './agent-trace'
import type { SendLog } from './types'

export interface NonSystemFormCtx {
  matchedSkill: SkillDefinition
  skl: string
  data: AgentTaskData
  sendLog: SendLog
  trace: AgentTrace
  out: SkillExecOut
  skillType: string
  skillCode: string
  skillSop: string
  skillBundle: string
  focusHint?: string
  materials?: string
}

/** true = 已由本模块处理完（主函数应 return null 交后续合成）；false = 未命中，继续业务系统链路。 */
export async function runNonSystemSkillForm(ctx: NonSystemFormCtx): Promise<boolean> {
  const { matchedSkill, skl, data, sendLog, trace, out, skillType, skillCode, skillSop, skillBundle, focusHint, materials } = ctx

  // 深度调研引擎技能：SKILL.md/SOP 带 IML-ENGINE: deep-research 标记 → 客户端内置调研引擎
  //（规划→检索反思循环→事实笔记→长报告）。做成技能而非硬编码意图：技能中心统一管理/装配/路由。
  // 纯读（联网检索 + 本地成稿），不碰任何业务系统，不受只读模式约束。
  if (DEEP_RESEARCH_MARKER.test(`${skillSop}\n${matchedSkill.sopContent || ''}\n${skillBundle}`)) {
    await runDeepResearch(data, skl, sendLog, trace, out)
    trace.spans.push({ type: 'skill', name: `深度调研·${skl}`, status: out.skillOk ? 'ok' : 'warn' })
    return true
  }

  // 多媒体生成引擎技能（图片 / 视频）：同样靠 IML-ENGINE 标记分流。
  // 为什么不能走下面的 Python 沙箱：沙箱 networkIsolation=true，脚本连不上上游、也不该持有厂商密钥；
  // 这两个能力必须由客户端引擎经企业网关调用（media-gen.ts）。纯生成，不碰业务系统，不受只读模式约束。
  const engineText = `${skillSop}\n${matchedSkill.sopContent || ''}\n${skillBundle}`
  if (IMAGE_GEN_MARKER.test(engineText)) {
    await runImageGen(data, skl, sendLog, trace, out)
    return true
  }
  if (VIDEO_GEN_MARKER.test(engineText)) {
    await runVideoGen(data, skl, sendLog, trace, out)
    return true
  }

  // 代码型技能：type=python-sandbox 且带可执行代码 → 公司级后端 Docker 容器沙箱。
  // 沙箱只跑不可信代码、不触碰任何业务系统，故不受「只读模式」约束(只读保护的是业务系统写入)。
  if (skillType === 'python-sandbox' && skillCode.trim()) {
    await runCodeSkill(skillCode, skillSop, skl, sendLog, out)
    // 审计标记：本次经公司级 Docker 沙箱执行（成功与否都记，时间线体现结果）
    trace.sandboxUsed = true
    trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·代码技能', status: out.skillOk ? 'ok' : 'warn' })
    return true
  }

  // agentic bundle 技能：无直接可执行 code 但带整目录 bundle（SKILL.md+scripts，如 Anthropic 技能包）
  // → 模型读手册现场编写驱动脚本，与 bundle 一起送沙箱执行；失败自修复重试一轮。
  // 也容忍「只有 sopContent 没有 bundle」（裸 SKILL.md 导入的旧数据）：手册在哪都能跑，
  // runAgenticSkill 内部按 bundle['SKILL.md'] || sop 取手册——否则这类技能被路由选中也静默不执行。
  if (skillType === 'python-sandbox' && !skillCode.trim() && (skillBundle.trim() || skillSop.trim())) {
    await runAgenticSkill(skillBundle, skillSop, data, skl, sendLog, out, focusHint, materials)
    trace.sandboxUsed = true
    trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·agentic 技能', status: out.skillOk ? 'ok' : 'warn' })
    return true
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
      trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·指南型生成', status: out.skillOk ? 'ok' : 'warn' })
      return true
    }
    // 纯 SOP（无素材包）→ 不进沙箱，由模型作为岗位专家把规范应用到答复中，不生成文件。
    sendLog('acting', `技能「${skl}」为知识/指南型，按其规范应用到本次产出…`)
    const sop = (skillSop || matchedSkill.sopContent || '').trim()
    out.skillResult = `已参照技能「${skl}」的规范/指南完成。`
    out.skillPromptHint = `【技能 "${skl}" · 知识/指南型】\n该技能是一份规范/指南（无可执行代码、不访问任何系统）。请你作为该岗位专家，严格依据下面的指南完成用户任务：把其中的规范、风格、约束、清单落实到你的产出与建议中。\n- 不要声称运行了任何脚本或访问了任何系统；\n- 若指南要求的某些素材（字体/图片/数据）本地不具备，就说明并给出可行替代；\n- 绝不编造不存在的业务数据（人名/单号/金额/日期）。\n\n【指南内容（SKILL.md）】\n${sop || '（该技能未提供指南正文）'}`
    trace.spans.push({ type: 'skill', name: `知识/指南型·${skl}`, status: 'ok' })
    return true
  }

  return false
}
