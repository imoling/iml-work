// 新内核的提示词组装：静态 system 指令 + 每轮 ephemeral 上下文。
//
// 两者刻意分开（同款处理）：
// · system 指令**整轮不变**，放在 messages[0]，天然吃上游的 prompt cache；
// · ephemeral 上下文（日期/权限档/工作空间清单）每轮重新生成，追加到最后一条 user 消息尾部——
//   不插 system 消息，因为中途插 system 在各厂商表现不一致；也不写回历史，避免过期快照被重放。
//
// 叶子模块：只读配置与工作空间清单，绝不 import main.ts / 内核。

/**
 * 叙述规范——「执行反馈好不好」的核心机制，移植自  _NARRATION_GUIDANCE。
 *
 * 为什么必须显式要求：模型默认要么闷头连调五个工具一句话不说（用户盯着转圈不知道在干嘛），
 * 要么把过程叙述当成最终答案输出（"我将会去查询…"然后就没了）。这段约束把两头都掐住。
 */
const NARRATION_RULE = `【执行叙述】
每一批工具调用**之前**，先用一句朴素的话说明你正在做什么、为什么（例：「先查一下最近三个月的报销记录。」）。这句话会作为实时进度展示给用户看。
- 琐碎的单步跟进不必叙述，也不要重复上一句已经说过的话。
- 叙述**绝不能代替最终答案**：任务完成时要给出完整的结论，而不是只说"我已经查完了"。`

/**
 * 任务清单规范：什么时候该列、什么时候不该列。
 *
 * 判据必须是**可数的**（预计几次工具调用），不能是"多步/复杂"这类形容词——实测用形容词描述时，
 * 一个跑了 6 次工具调用的调研任务模型照样不列清单，因为它主观上不觉得"复杂"。
 */
const TODO_RULE = `【任务清单】
以下两类任务，**第一步就调用 todo_write 列出计划**，此后每完成一步再调一次更新状态（清单展示在用户对话框里，是他判断进度的唯一依据）：
① 预计需要 **3 次以上**工具调用（联网调研、跨系统取数、生成材料等）——判据是"预计调几次工具"，不是"难不难"；
② 要**执行业务技能（run_skill）**的任务——技能动辄跑几分钟，至少列出「执行技能→整理结果」两项，别让用户对着空屏干等。
一两次普通调用（检索/算数）就能答完的问题不要列——那只会添噪音。
**答复里绝不要出现清单的 JSON**：更新清单只能通过调用 todo_write 工具完成。`

/** 真实性红线：与旧链路的 NO_FABRICATION_RULE 同源，是产品的第三条安全红线。 */
const NO_FABRICATION_RULE = `【真实性边界 · 红线】
你**没有**任何凭空访问业务系统、邮箱、OA、CRM、ERP、数据库的能力。你掌握的真实业务数据，**只能**来自本次对话中工具实际返回的结果。
- 严禁编造任何邮件、待办、审批单、报销单、订单、人名、金额、日期、单号。
- 工具没查到、或你手头没有对应工具时，如实说明拿不到，并给出下一步建议（在「企业技能中心」配置对应技能、或在「设置 → 企业系统连接」登录目标系统后重试）。
- 绝不为了"显得完成了任务"而虚构结果。宁可如实说"没查到"，也不要给一个看起来完整的假答案。`

/** 工具使用原则：把实测踩过的坑固化成规则。 */
const TOOL_RULE = `【工具使用】
- **算术/计数/求和/日期差一律用 python 工具真算**，不要心算硬报。
- 一次只推进一步，每步都基于上一步真实观察到的结果决定下一步，不要臆测工具会返回什么。
- 信息拿够了就尽快作答，不要无谓地多绕；拿不够就继续调工具，别急着用猜测填空。
- 检索类任务：一次搜不到就换更具体的检索词再搜，或对结果里的链接用读取网页正文的工具深读，不要凭一次搜索的摘要就下结论。
- **交付文件时**：正文里先用几句话（数据类可用小表格）概述文件的关键内容，再给文件——只说"已生成文件"等于什么都没交付。`

export interface SystemPromptOptions {
  /** 分身的岗位人设名（如「张三 · 财务专员」）。 */
  expertName: string
  userNickname: string
  /** 岗位背景/职责描述。 */
  background?: string
  /** 已沉淀的个人习惯记忆。 */
  personalMemory?: string
  /** 岗位预置 SOP。 */
  agentSop?: string
  /** 整轮不变的事实块（企业信息、本岗位可检索的知识库范围）。 */
  standing?: string
}

/** 整轮不变的 system 指令。 */
export function buildSystemPrompt(o: SystemPromptOptions): string {
  const parts = [
    `你是「${o.expertName}」，${o.userNickname}的企业工作分身。你的职责是**把事情真正做完**，而不只是聊天。`,
    o.background ? `【岗位背景】\n${o.background}` : '',
    NARRATION_RULE,
    TODO_RULE,
    TOOL_RULE,
    NO_FABRICATION_RULE,
    // 记忆为空就如实为空——绝不注入编造的「用户习惯/岗位 SOP」，否则模型会当事实引用。
    o.personalMemory ? `【${o.userNickname}的使用习惯（已沉淀）】\n${o.personalMemory}` : '',
    o.agentSop ? `【岗位预置 SOP】\n${o.agentSop}` : '',
    o.standing || '',
  ]
  return parts.filter(Boolean).join('\n\n')
}

export interface EphemeralContextOptions {
  permMode: 'readonly' | 'full'
  unattended?: boolean
  /** 工作空间里可读的文件名（空则不提，免得诱导模型瞎试）。 */
  workspaceFiles?: string[]
  /** 用户关掉了「工作空间访问」——要如实告诉模型，否则它会去别处瞎找。 */
  workspaceOff?: boolean
  /** 本轮企业知识库命中的片段（已由调用方检索）。 */
  knowledgeChunks?: string[]
  /** 调用方额外拼好的动态块（知识库正文/岗位画像/附件内容）。 */
  extra?: string
}

/** 每轮重新生成的上下文块——变化的事实放这里，不进 system。 */
export function buildEphemeralContext(o: EphemeralContextOptions): string {
  const parts: string[] = [
    `当前日期：${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}`,
  ]
  if (o.permMode === 'readonly') {
    parts.push('当前是**讨论档（只读）**：查询、检索、浏览网页/业务系统、读取文件、向用户提问等**只读动作照常执行**，不要因为只读档就拒绝去查去看。只有真正**写入/改动**系统的动作（提交/删除/下单/审批…）会被拦截——把只读的准备工作全部做完后，用 propose_actions 工具向用户提交行动方案（用户点「按此执行」会自动继续），不要只在答案里让用户自己切档。')
  }
  if (o.unattended) {
    parts.push('当前是**无人值守运行**：没有人在屏幕前，需要人工确认的写操作无法执行。遇到这类步骤请跳过并在结论里说明。')
  }
  if (o.workspaceFiles?.length) {
    parts.push(`工作空间可读文件：${o.workspaceFiles.join('、')}`)
  }
  // 不说清楚的话，模型会以为只是自己没找对——于是写 python 去沙箱里满世界找一个
  // 根本不在那儿的文件（实测：用户关掉开关后发图，模型跑了 7 轮工具调用才放弃）。
  if (o.workspaceOff) {
    parts.push('用户已**关闭工作空间访问**：你读不到他电脑上的文件，也没有 read_file 工具。'
      + '沙箱里同样没有这些文件，**不要写脚本去找**。若任务需要某个文件，直接告诉用户'
      + '「工作空间访问已关闭，请用附件按钮把文件发给我，或在设置里开启访问」——本轮通过附件发来的图片你是能看到的。')
  }
  if (o.knowledgeChunks?.length) {
    parts.push(`【企业知识库命中（可作参考，注明出处）】\n${o.knowledgeChunks.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
  }
  if (o.extra) parts.push(o.extra)
  return parts.join('\n\n')
}
