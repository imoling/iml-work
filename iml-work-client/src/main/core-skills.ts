// 技能工具化（阶段 4）——把「业务技能」变成新内核工具表里的一项。
//
// 做完这一步，分流就没了：从前「要生成 PPT」「显式锁定技能」都得绕回旧链路，
// 因为新内核没有产出文件、没有执行确定性流程的能力。现在它有了 run_skill，
// 由模型自己判断该不该调、调哪个。
//
// 两条纪律：
// ① **不在工具层再加确认闸**——技能执行链路内部已有 7 处 requestSignedConfirmation/表单卡，
//    外面再包一层就是双重弹卡，用户很快会疲劳到闭眼点确认，反而更不安全。
// ② **只读档的拦截必须在这里**——那是路由层原有的职责，技能内部的闸管的是"执行时确认"，
//    不管"这个档位允不允许执行写技能"。
import type { ToolSpec } from './tool-registry'
import type { AgentTaskData, SkillExecOut } from './agent-types'
import type { AgentTrace } from './agent-trace'
import { getLoadedSkills, loadLocalSkills, skillLabel, skillDisplayName, type SkillDefinition } from './skill-store'
import { scopedSkillsFor } from './skill-orchestrator'
import { runCustomSkill } from './skill-custom'
import { isWriteSkill, isDataFetchSkill } from './skill-exec'
import { swallow } from './util'
import path from 'path'
import { workspaceDir, extractFileText } from './workspace-files'

export interface SkillToolsInput {
  data: AgentTaskData
  trace: AgentTrace
  /** 本次任务的岗位（决定哪些技能在册）。 */
  expertId: string
}

export interface SkillToolsHandle {
  specs: ToolSpec[]
  /**
   * 触发词点名提示：用户的话命中某技能触发词时生成一句 ephemeral 提醒。
   * 为什么需要：目录里的「先技能、后自查」是软规则，实测「深度调研…主角是你自己」这句
   * 模型照样自己当引擎跑了 14 轮（先查自己资料的念头压过了规则）。点名提示比软规则硬——
   * 但仍不是硬路由：模型保留否决权，任务与技能描述不符时可以不调（防旧链路"触发词截胡"复辟）。
   */
  triggerHint: (content: string) => string
  /** 注入提示词的技能目录（渐进披露：只给名字与描述，正文在执行时才读）。 */
  catalog: string
  /** 技能 id → 显示名（内核微计划等用户可见文案用）。 */
  nameOf: (id: string) => string | undefined
  /** 本轮技能产出的文件（供结果卡展示）。 */
  files: () => { name: string; sizeBytes: number }[]
  /** 本轮技能带回的联网来源。 */
  webSources: () => { title: string; url: string }[]
}

/**
 * 技能目录文本。空目录返回空串——没有技能却告诉模型"你有技能"只会诱导它瞎调。
 *
 * 必须带上**触发词**：那是技能作者为「什么话该用这个技能」标注的信号，是最强的匹配线索。
 * 第一版只给了 id + name + 描述，而 SKILL.md 里 name 恰好就等于 id，于是目录长这样：
 *   `- skill-24bd9f42：skill-24bd9f42 —— 当用户在Mock OA演示系统点击统一待办时…`
 * 名字重复且毫无信息量，模型认不出来，宁可用 read_page 去硬啃 OA 页面也不调技能（实测）。
 */
function buildCatalog(skills: SkillDefinition[]): string {
  if (!skills.length) return ''
  const lines = skills.map(s => {
    // name 常常就是 id（SKILL.md 的 name 字段写的是目录名），这时不重复显示
    const disp = skillDisplayName(s.id) || (s.name && s.name !== s.id ? s.name : '')
    const kw = s.triggerKeywords?.length ? `〔${s.triggerKeywords.slice(0, 8).join('、')}〕` : ''
    const desc = (s.description || '').replace(/\s+/g, ' ').slice(0, 100)
    return `- ${s.id}${disp ? ` ${disp}` : ''}${kw}${desc ? ` ${desc}` : ''}`
  })
  return `【可用业务技能】——用 run_skill 执行，skillId 传下面的 ID。〔〕里是触发词。\n${lines.join('\n')}\n\n`
    + '**判断规则**：用户的话只要对上某条技能的触发词或描述，就**直接调 run_skill**，不要自己用检索/读网页去凑。\n'
    + '**先技能、后自查**：任务的最终交付物对应某条技能（调研报告/PPT/文档/行情数据）时，'
    + '**第一步就调它**——深度调研、取数这类技能会自己完成检索与取数，'
    + '你先自己搜一遍再调它，等于同一件事做两遍，白白多花几分钟（把你已有的要求经 task 参数传给它即可）。\n'
    + '**单任务单数据引擎**：调研/取数这类引擎技能，一次任务只调**与用户诉求最对口的一个**；'
    + '它完成后基于其结果直接交付，**不要**再顺手追加执行其它引擎技能去"补充数据"——'
    + '用户没点名要的数据（如调研任务之外再拉一份行情）不要自作主张去拉，可在答复末尾建议用户按需提出。\n'
    + '这些是为具体业务场景配好的确定性流程，比你临场拼凑更快更准；而且**只有它们能真正产出文件**'
    + '（.pptx/.docx/.xlsx）和**操作企业系统**（带登录态取数、办理业务）——你自己没有这两样能力。\n'
    // 技能 / 子智能体 / 自己查，是三件不同的事，最容易混的是前两者（都像"派出去干活"）。
    // 不划清界限的下场是：该调技能时派了个子智能体去瞎查（它产不出文件、进不了业务系统），
    // 白跑两分钟还交不出东西。
    + '**技能 vs 小分身**：技能是**确定性流程**（有手册、能产文件、能进业务系统）；'
    + '小分身（run_subagent）是**开放式调查**（只会检索/阅读/计算，产不出文件、进不了业务系统）。'
    + '任务对得上某条技能就调技能；对不上、又需要大量阅读才能得出结论的，才分小分身；'
    + '一两次检索能答的，自己查最快。'
}

/**
 * 组装技能工具。
 * 目录取自「岗位在册技能集」（装配 ∪ 本人私有），与旧链路路由同源，不会冒出别的岗位的技能。
 */
export function makeSkillTools(o: SkillToolsInput): SkillToolsHandle {
  loadLocalSkills()   // 用最新技能集（与技能路由一致）
  const skills = scopedSkillsFor(o.expertId)
  const files: { name: string; sizeBytes: number }[] = []
  const webSources: { title: string; url: string }[] = []
  // 本轮已执行过的**数据检索引擎**技能（深度调研/取数类）的标签——「单任务单数据引擎」纪律用
  const ranDataFetch: string[] = []

  const spec: ToolSpec = {
    name: 'run_skill',
    description: '执行一个已安装的业务技能，返回它的真实执行结果。'
      + '需要产出文件（PPT/Word/Excel/PDF）、在企业系统里取数或办理业务、拉行情数据时，'
      + '**必须**用对应技能——你自己没有写文件和操作业务系统的能力。skillId 从可用技能目录里取。',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能目录里的技能 ID，如 skill-imp-4a954f92' },
        task: {
          type: 'string',
          description: '交给技能的**完整任务描述**。技能内部有自己的执行模型，它只看得见这段文字——'
            + '你检索到的关键素材、已确定的结构/章节/要点，都要写进来，否则技能会自行发挥、产物与你的计划对不上。'
            + '不传则技能只拿到用户原话。',
        },
      },
      required: ['skillId'],
    },
    // low 档是**有意**的：技能内部已有自己的确认卡与签名令牌闸（见文件头纪律①）。
    metadata: { label: '执行业务技能', risk: 'low', category: 'skill' },
    run: async (args, ctx) => {
      const id = String(args.skillId || '').trim()
      if (!id) return '（run_skill 需要 skillId 参数）'
      const skill = skills.find(s => s.id === id) || getLoadedSkills().find(s => s.id === id)
      if (!skill) {
        return `没有找到技能「${id}」。可用技能：${skills.map(s => s.id).join('、') || '（本岗位暂无在册技能）'}`
      }

      // 只读档 + 写技能 → 拒。这是路由层原有的安全职责，工具化后必须跟着搬过来，
      // 否则「只读模式」在新内核里对技能形同虚设（旧链路出过「看考勤误打卡」的事故）。
      if (o.data.permMode === 'readonly') {
        let isWrite = false
        try { isWrite = await isWriteSkill(skill.id) } catch (e) { swallow(e, 'turn-skill-iswrite'); isWrite = true }  // 判不出就按写处理
        if (isWrite) {
          const msg = `只读模式：技能「${skillLabel(skill)}」会改动业务系统，已拦截未执行。`
            + '请如实告诉用户需要切换到「完全权限」档才能执行，不要试图用别的方式绕过。'
          ctx.sendLog('acting', `🔒 ${msg}`)
          return msg
        }
      }

      // 「单任务单数据引擎」纪律（确定性闸，2026-08-08 实锤）：一轮里已跑过一个数据检索引擎技能后，
      // 再调**另一个**数据引擎、且用户原话没有任何触发词指向它 → 拦下。实锤场景：「深度调研人形
      // 机器人行业」完成后，模型自作主张又调 a-stock-data 跑了份与主题无关的当日 A 股复盘（用户
      // 没提行情/股票任何字眼）——多烧五分钟与一堆额度，产物还得用户自己忽略。目录里的软规则
      // 挡不住这种"顺手补一份"，只有确定性闸挡得住；用户真点名要的组合（原话命中触发词）照常放行。
      let isDataEngine = false
      try { isDataEngine = await isDataFetchSkill(skill.id) } catch (e) { swallow(e, 'turn-skill-datafetch') }
      if (isDataEngine && ranDataFetch.length && !ranDataFetch.includes(skillLabel(skill))) {
        const lower = (o.data.content || '').toLowerCase()
        const kwHit = (skill.triggerKeywords || []).some(k => k && lower.includes(String(k).toLowerCase()))
        if (!kwHit) {
          const msg = `已拦截对「${skillLabel(skill)}」的追加调用：本轮已执行过「${ranDataFetch.join('、')}」，`
            + `而用户的原始请求没有任何字眼指向「${skillLabel(skill)}」（触发词均未命中）。`
            + `请基于已有执行结果直接向用户交付；若你判断用户可能还需要这类数据，在答复末尾**建议**用户明确提出，不要自行执行。`
          ctx.sendLog('observing', `🔒 ${msg}`)
          return msg
        }
      }

      ctx.sendLog('acting', `执行技能「${skillLabel(skill)}」…`)
      // 任务传导：外层模型拟的大纲/素材经 task 参数进技能——不开这个通道时，技能只见用户原话，
      // 内部模型自行发挥，产物与外层在对话里的描述必然脱节（实测：说好 SWOT+星级矩阵，文档里全没有）。
      const task = String(args.task || '').trim()
      const dataForSkill = task ? { ...o.data, content: task } : o.data
      const out: SkillExecOut = { skillResult: '', skillPromptHint: '' }
      let early: Awaited<ReturnType<typeof runCustomSkill>> = null
      try {
        early = await runCustomSkill(skill, skillLabel(skill), dataForSkill, ctx.sendLog, o.trace, out)
      } catch (e: any) {
        swallow(e, 'turn-skill-run')
        return `技能「${skillLabel(skill)}」执行出错：${e?.message || e}。请如实告知用户，不要编造执行结果。`
      }
      if (isDataEngine) ranDataFetch.push(skillLabel(skill))   // 成败都占用"单数据引擎"名额（失败也不该换个引擎瞎补）

      if (out.skillFiles?.length) files.push(...out.skillFiles)
      if (out.webSources?.length) webSources.push(...out.webSources)

      // 早返回＝技能链路自己给出了终态（表单取消、安全闸拦截、需要登录…），原样回灌给模型。
      if (early) return early.content || '（技能已结束，无输出）'

      // 失败要说清楚**为什么**。skillOk 是结构化终态，别从文案反推。
      // 实测：技能因缺依赖包失败时，模型只对用户说了句"该技能暂时无法正常执行"，
      // 用户完全不知道是白名单缺包——错误原因明明就在 hint 里，却被这句模糊话盖掉了。
      if (out.skillOk === false) {
        return `技能「${skillLabel(skill)}」**未能成功执行**。原因：${out.skillPromptHint || out.skillResult || '（技能未给出原因）'}\n`
          + '请把上面的具体原因如实转述给用户（例如缺少依赖、需要登录、参数不足），'
          + '不要用"暂时无法执行/存在环境问题"这类模糊说法搪塞，更不要绕开它自己编一份结果交差。'
      }
      // 产物真实内容回读（真实性红线）：模型并不知道技能到底往文档里写了什么——
      // 不回读的话它会按**自己原先的设想**向用户描述文档（实测：对话里列的分析维度与文档内容对不上）。
      let contentPeek = ''
      if (out.skillFiles?.length) {
        try {
          const f = out.skillFiles[0]
          const text = await extractFileText(path.join(workspaceDir(), f.name))
          if (text?.trim()) {
            contentPeek = `\n\n【产物「${f.name}」的真实内容节选】\n${text.trim().slice(0, 1800)}\n`
              + '【交付纪律】向用户交付时，**先用几句话（或一个小表格）概述文件里的关键内容**，再提文件本身——'
              + '只说"已生成文件"等于什么都没说（实测反馈：用户还得自己点开看）。概述**只依据上面的真实节选**，'
              + '不要按你此前的设想描述；节选未覆盖的部分不要具体断言，设想与实际不符时以实际为准。'
          }
        } catch (e) { swallow(e, 'turn-skill-peek') }
      }
      // skillPromptHint 是给模型看的执行说明，比 skillResult 更适合回灌。
      return (out.skillPromptHint || out.skillResult || '（技能执行完成，但没有返回内容）') + contentPeek
    },
  }

  return {
    specs: skills.length ? [spec] : [],
    catalog: buildCatalog(skills),
    nameOf: (id: string) => {
      const sk = skills.find(x => x.id === id)
      return skillDisplayName(id) || (sk?.name && sk.name !== id ? sk.name : undefined)
    },
    triggerHint: (content: string) => {
      const lower = (content || '').toLowerCase()
      const hits = skills
        .map(s2 => ({ s: s2, kw: (s2.triggerKeywords || []).find(k => k && lower.includes(String(k).toLowerCase())) }))
        .filter(x => x.kw)
        .slice(0, 2)
      if (!hits.length) return ''
      return `【技能提示】用户这句话命中了技能触发词：${hits.map(x => `「${x.kw}」→ ${x.s.id}${skillDisplayName(x.s.id) ? `（${skillDisplayName(x.s.id)}）` : ''}`).join('；')}。`
        + '若任务与该技能的描述相符，**第一步就调 run_skill 执行它**（把完整要求经 task 参数传入），不要自己用检索拼凑同样的事；确实不相符才可以不调。'
    },
    files: () => files,
    webSources: () => webSources,
  }
}
