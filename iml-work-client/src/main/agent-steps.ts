// agent 子流程：对话上文块、「记住」意图落地个人记忆、「定时」意图落地自动化任务、
// 技能结果 → 记忆/知识库融合 → LLM 合成最终答复。纯搬迁自 main.ts，不改逻辑。
import { memoryGet, memorySet, schedUpsert } from './db'
import { callLlm } from './llm'
import { swallow } from './util'
import { emitToRenderer } from './window-ref'
import { getEnterpriseBlock, getKnowledgeScope, queryCorporateKnowledge, buildCorporateRagBlock, attachRagImages, buildKnowledgeSources } from './corporate-rag'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog } from './types'

export function buildHistoryBlock(history?: { role: 'user' | 'assistant'; content: string }[]): string {
  if (!history || !history.length) return ''
  const recent = history.slice(-8)
  const lines = recent.map((h, idx) => {
    const text = (h.content || '').replace(/\s+/g, ' ').trim()
    // 截断策略：头尾都保留（分身消息的提议/待办通常在结尾——用户回"好的"确认的就是它，
    // 只留开头会把提议切掉，确认语随之失去指代）；最近一条给更大预算（承接性最强）。
    const cap = idx === recent.length - 1 ? 1200 : 400
    const clipped = text.length <= cap
      ? text
      : text.slice(0, Math.floor(cap * 0.4)) + ' ……(中间省略)…… ' + text.slice(-Math.ceil(cap * 0.6))
    return `${h.role === 'user' ? '用户' : '分身'}：${clipped}`
  }).join('\n')
  return `\n【对话上文（本次会话最近几轮，用于理解指代与延续话题；其中用户提供的信息可直接引用作答，勿复述整段。若用户本轮只是简短确认——如同意、认可、让你继续——指的就是分身上一条消息末尾提出的提议/待办，应直接着手执行该提议，而不是再次询问需求）】\n${lines}\n`
}

// 「记住/记下 X」意图：把用户要记的信息提炼成简短事实，追加进个人长期记忆（本地 SQLite，按岗位隔离），
// 之后每次对话自动注入 System Prompt。命中即短路返回确认（不再走技能/联网）。模型异常则如实告知未记住。
const REMEMBER_INTENT = /(记住|记一下|记下|记录一下|帮我记|存一下|记到|备忘|以后记得|请记得)/
export async function runMemoryWrite(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  const expertId = data.expertId || ''
  if (!expertId || !REMEMBER_INTENT.test(data.content)) return null
  sendLog('thinking', '识别到"记住"意图，正在提炼要长期记忆的信息…')
  const prompt = `用户希望分身长期记住一些个人信息/偏好。请从下面这句话里提炼出需要记住的**事实**，每条一行、简短陈述句（含关键要素如日期/名称/偏好），不要解释、不要编号。若确实没有可长期记忆的个人事实则输出 NONE。\n\n【用户的话】\n${data.content}\n\n只输出事实（每行一条）或 NONE：`
  let facts: string[] = []
  try {
    const out = await callLlm(prompt, data.llmConfig, { temperature: 0 })
    facts = (out || '').split('\n').map(l => l.replace(/^[-*\d.、\s]+/, '').trim()).filter(l => l && l !== 'NONE' && l.length <= 200)
  } catch (e) { swallow(e, 'memory-extract') }
  if (!facts.length) return null   // 提炼失败 → 回退正常对话流

  // 读旧记忆 → 去重追加 → 存回（结构与记忆面板一致：{id,content,timestamp}）
  let list: { id: string; content: string; timestamp: string }[] = []
  try { const raw = memoryGet(expertId, 'personal'); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) list = p } } catch (e) { swallow(e) }
  const existing = new Set(list.map(x => (x.content || '').trim()))
  const added: string[] = []
  const ts = new Date().toLocaleString('zh-CN', { hour12: false })
  for (const f of facts) if (!existing.has(f)) { list.unshift({ id: `fact-${Date.now()}-${added.length}`, content: f, timestamp: ts }); added.push(f) }
  try { memorySet(expertId, 'personal', JSON.stringify(list)) } catch (e) { swallow(e) }

  const body = added.length
    ? `好的康Sir，我已经记住了：\n${added.map(f => `· ${f}`).join('\n')}\n\n这些会长期保存在你的个人记忆里，以后每次对话我都会自动带上。你也可以在「设置 → 资料与记忆」里查看或删除。`
    : `这些信息我之前已经记过了，无需重复。你可以在「设置 → 资料与记忆」里查看。`
  sendLog('completed', `已写入个人长期记忆 ${added.length} 条`)
  trace.spans.push({ type: 'memory', name: `写入个人记忆·${added.length} 条`, status: 'ok' })
  await trace.submit(body, 'SUCCESS', `识别"记住"意图，提炼并写入个人长期记忆 ${added.length} 条。`)
  return { content: body, success: true, traceId: trace.id }
}

// 「每天/每周…定时做某事」意图：解析成定时任务并入库（本地调度器到点自动跑该 prompt），命中即短路确认。
// 覆盖"每天9点总结AI新闻""每个工作日下午5点提醒我写日报"等——把口语指令直接变成自动化任务。
const SCHEDULE_INTENT = /(每天|每日|每周|每星期|每个?工作日|工作日每|每月|定时|以后每天|每隔|定期)/
export async function runScheduleCreate(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  const expertId = data.expertId || ''
  if (!expertId || !SCHEDULE_INTENT.test(data.content)) return null
  sendLog('thinking', '识别到"定时/周期"意图，正在解析成自动化任务…')
  const prompt = `用户想设置一个周期性自动任务。请从下面这句话解析出定时任务参数，输出严格 JSON（不要解释、不要代码块标记）：\n{"title":"简短任务名","prompt":"到点要执行的完整指令（第一人称祈使句，如：总结最新的AI新闻并给我一份摘要）","freq":"daily|weekday|weekly|monthly","time":"HH:MM(24小时)","dow":0-6周日到周六(仅weekly用),"dom":1-28(仅monthly用)}\n规则：\n- "每天"→daily；"每个工作日/工作日"→weekday；"每周X"→weekly+dow；"每月X号"→monthly+dom。\n- 时间转 24 小时 HH:MM（"9点/早上9点"→09:00，"下午5点"→17:00）；没说时间默认 09:00。\n- 若这句话其实不是要设周期任务，输出 {"freq":"none"}。\n\n【用户的话】\n${data.content}\n\n只输出 JSON：`
  let parsed: any = null
  try {
    const out = await callLlm(prompt, data.llmConfig, { temperature: 0 })
    const m = out.match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
  } catch (e) { swallow(e, 'schedule-parse') }
  if (!parsed || parsed.freq === 'none' || !['daily', 'weekday', 'weekly', 'monthly'].includes(parsed.freq)) return null

  const time = /^\d{1,2}:\d{2}$/.test(String(parsed.time || '')) ? String(parsed.time).padStart(5, '0') : '09:00'
  const task = {
    id: 'sch-' + Date.now(),
    title: String(parsed.title || '定时任务').slice(0, 40),
    prompt: String(parsed.prompt || data.content).slice(0, 500),
    expertId, expertName: data.expertName || '',
    freq: parsed.freq as 'daily' | 'weekday' | 'weekly' | 'monthly',
    time,
    dow: Number.isInteger(parsed.dow) ? Math.max(0, Math.min(6, parsed.dow)) : 1,
    dom: Number.isInteger(parsed.dom) ? Math.max(1, Math.min(28, parsed.dom)) : 1,
    enabled: true,
  }
  try { schedUpsert(task) } catch (e) { swallow(e, 'schedule-save') }
  emitToRenderer('schedule:changed')   // 通知自动化页刷新

  const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const when = task.freq === 'daily' ? `每天 ${task.time}`
    : task.freq === 'weekday' ? `每个工作日 ${task.time}`
    : task.freq === 'weekly' ? `每${DOW[task.dow]} ${task.time}`
    : `每月 ${task.dom} 日 ${task.time}`
  const body = `好的康Sir，已为你创建定时任务「**${task.title}**」：\n· 触发：**${when}**\n· 到点自动执行：${task.prompt}\n\n任务已开启，可在左侧「自动化」里查看 / 编辑 / 暂停 / 立即执行。到点我会自动跑并给你结果。`
  sendLog('completed', `已创建定时任务：${when}`)
  trace.spans.push({ type: 'schedule', name: `创建定时任务·${when}`, status: 'ok' })
  await trace.submit(body, 'SUCCESS', `识别"定时"意图，创建周期任务（${when}）。`)
  return { content: body, success: true, traceId: trace.id }
}

export async function synthesizeSkillAnswer(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, sk: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }): Promise<AgentResult> {
  const expertId = data.expertId || ''
  const userNickname = data.userNickname || '用户'
  const { skillResult, skillPromptHint } = sk
    sendLog('thinking', `信息都拿到了，正在帮你整理成回复…`)
    const cfg = data.llmConfig
    const isConfigComplete = cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName

    if (!isConfigComplete) {
      sendLog('observing', `⚠️ 未检测到有效大模型配置。将绕过 LLM 润色，直接以本地沙箱执行结果返回呈现。`)
      sendLog('completed', `[Completed] 本地技能直通测试完毕。`)
      return {
        content: `💡 **[本地技能直通测试模式]**\n您当前未配置有效的大模型（或已关闭连接）。以下为本地 Node.js / Electron 引擎执行该技能的真实返回结果：\n\n---\n\n${skillResult}`,
        success: true, traceId: trace.id, files: sk.skillFiles
      }
    }

    // Retrieve memories from SQLite for context integration
    sendLog('thinking', '先回忆下你的习惯和岗位经验…')
    let personalMemoryList = ''
    let agentSopList = ''
    if (expertId) {
      try {
        const personalStr = memoryGet(expertId, 'personal')
        if (personalStr) {
          const parsed = JSON.parse(personalStr)
          if (Array.isArray(parsed)) {
            personalMemoryList = parsed.map((m: any) => `▸ ${m.content}`).join('\n')
          }
        }
      } catch (e) { swallow(e) }
      try {
        const agentStr = memoryGet(expertId, 'agent')
        if (agentStr) {
          const parsed = JSON.parse(agentStr)
          if (Array.isArray(parsed)) {
            agentSopList = parsed.map((m: any) => `▸ ${m.content}`).join('\n')
          }
        }
      } catch (e) { swallow(e) }
    }

    // 记忆为空就如实为空——绝不注入编造的「用户习惯/岗位 SOP」，否则模型会当事实引用（违反真实性红线）。
    if (!personalMemoryList) personalMemoryList = `（暂无沉淀的个人习惯记忆）`
    if (!agentSopList) agentSopList = `（暂无岗位预置 SOP，按通用岗位常识与下方企业知识作答）`

    const kbScope = getKnowledgeScope(expertId)
    const kbScopeLine = kbScope.length
      ? `\n- 本岗位云端知识库检索范围（由管理端领用下发）：${kbScope.join('、')}`
      : ''

    sendLog('thinking', `正在查相关的公司制度…`)
    const corporateChunks = await queryCorporateKnowledge(data.content, expertId)
    if (corporateChunks.length) {
      sendLog('thinking', `查到 ${corporateChunks.length} 条相关制度，已经一起考虑进去了。`)
    } else {
      sendLog('thinking', `没查到相关制度，先用本地记忆来答。`)
    }
    const corporateRagBlock = buildCorporateRagBlock(corporateChunks)
    const enterpriseBlock = await getEnterpriseBlock()

    const promptWithContext = `[系统指令/System Prompt]
你是一个岗位专家智能体助手。
你的名字（岗位名称）是：${data.expertName}
你对用户的称呼是：${userNickname}
【当前日期时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}（系统实时，回答日期/时间相关问题一律以此为准，不要臆测）
${buildHistoryBlock(data.history)}
【岗位预置知识与SOP】
${agentSopList}

【用户个人信息与习惯】
- 岗位背景：${data.background}
- 用户称呼：${userNickname}
${personalMemoryList}

【企业知识与规则】（由管理端统一维护）
${enterpriseBlock}${kbScopeLine}${corporateRagBlock}

【本地真实技能执行数据】
${skillPromptHint}

[当前指令/User Instruction]
请严格、且仅依据上述【本地真实技能执行数据】作答：
- 若其中是真实抓取/执行结果，则以你自己完成了该技能的口吻如实汇报；
- 若其中说明"技能未执行 / 需登录 / 执行失败 / 目标系统不可用"，你必须如实转达该情况并给出下一步建议（例如先在弹出的系统窗口登录后重试），不得给出任何看似完成的结论；
- 严禁编造任何上述数据中不存在的待办、条目、发起人、数字或结果。
如果数据中含图片 Markdown 或表格，请完整保留并显示。
用户指令："${data.content}"`

    try {
      let content = await callLlm(promptWithContext, cfg)
      content = attachRagImages(content, corporateChunks)   // 【图N】占位 → 真实插图
      sendLog('completed', `[Completed] 问答与本地技能调用链完毕。`)
      const blocked = /未登录|需登录|未执行|未绑定/.test(skillResult)
      await trace.submit(content, blocked ? 'BLOCKED' : 'SUCCESS',
        `目标：完成用户任务。${trace.skill ? '匹配技能「' + trace.skill + '」并执行；' : ''}${trace.webSearch ? '判定需联网→检索→综合作答；' : ''}基于真实结果整理回答，未编造。`)
      return { content, success: true, traceId: trace.id, sources: buildKnowledgeSources(corporateChunks), files: sk.skillFiles }
    } catch (err: any) {
      sendLog('observing', `大模型连接润色失败: ${err.message}。自动回退为本地技能直达渲染。`)
      sendLog('completed', `[Completed] 技能运行完毕（回退直通）。`)
      return {
        content: `⚠️ **[大模型连接失败 - 自动切换本地直通输出]**\n\n大模型请求遇到问题 (\`${err.message}\`)，但本地技能已在 Electron 环境内执行成功。以下是物理执行结果：\n\n---\n\n${skillResult}`,
        success: true, traceId: trace.id, files: sk.skillFiles
      }
    }
}
