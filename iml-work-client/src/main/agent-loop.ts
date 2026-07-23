// 通用 Agent 执行循环（P1 · planner-executor / ReAct）——iML Work 的"通用智能体"内核。
//
// 定位：把开放的多步任务，交给一个"思考 → 选一个工具 → 调用 → 观察结果 → 再想下一步"的循环，
// 直到得出答案。与现有单趟快路径（技能路由/联网问答）**并存**，只有复杂多步任务才走这里。
//
// 设计原则（对齐 CLAUDE.md）：
// · 叶子模块——只 import 工具函数与 llm/util，绝不 import main.ts；工具靠**入参**传入（AgentTool[]），
//   循环本身不认识任何具体工具，P2/P3 加 read_file/browse 只是往注册表里加一项，循环零改动。
// · 文本协议 ReAct（模型输出 JSON 决策，我方解析）——与路由/SOP agent 同套模式，模型无关、
//   不依赖网关 function-calling。
// · 纯叶子——**不 import llm/db**（那会连带触发 electron 的 app.getPath，污染纯函数测试）；
//   模型调用由**调用方传入** callModel（生产传 callLlm，单测传 mock），LlmConfig 仅 type-only 导入。
// · 真实性红线：最终答案必须落在观察到的工具结果上，提示词显式约束不得编造。
import type { LlmConfig } from './llm'
import { swallow } from './util'
import type { SendLog } from './types'

/** 一个工具：名字 + 给模型看的说明 + 参数样例 + 真正执行（返回"观察"文本）。 */
export interface AgentTool {
  name: string
  description: string
  argsHint: string   // 例：'{"query":"检索词"}'
  run: (args: Record<string, unknown>, sendLog: SendLog) => Promise<string>
  /** 有状态工具（如 browse 的浏览器会话）在循环结束后的清理；循环在 finally 里统一调用。 */
  cleanup?: () => Promise<void>
}

export interface AgentStep {
  n: number
  thought: string
  tool?: string
  args?: Record<string, unknown>
  observation?: string
  finish?: boolean
}

export interface AgentLoopResult {
  answer: string
  steps: AgentStep[]
  finished: boolean   // true=模型主动 finish；false=步数耗尽被迫收尾
}

export interface AgentLoopOptions {
  task: string
  tools: AgentTool[]
  cfg: LlmConfig
  sendLog: SendLog
  /** 额外上下文（日期/知识库命中/人设等），拼进系统提示。 */
  contextBlock?: string
  maxSteps?: number
  /** 单条观察的截断上限（工具可能返回巨量文本，防提示词爆炸）。 */
  obsCap?: number
  /** 墙钟时间预算（毫秒）：>0 时，某步开始前若已超预算就**主动收尾**、用已获观察作答——
   *  防止慢工具（深读/文件）把循环拖到被外层硬 timeout 砍成空答（实测 GAIA ga05 教训）。 */
  budgetMs?: number
  /** 模型调用（生产传 callLlm，单测传 mock）——必填，使本模块不依赖 llm/db。 */
  callModel: (prompt: string, cfg: LlmConfig, opts?: { temperature?: number; longRunning?: boolean }) => Promise<string>
}

/** 从模型输出里稳健抽出决策 JSON（容忍 ```json 包裹、前后废话）。 */
export function parseAgentDecision(raw: string): { thought: string; tool?: string; args?: Record<string, unknown>; finish?: boolean; answer?: string } | null {
  const s = (raw || '').replace(/```json/gi, '').replace(/```/g, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let parsed: any
  try { parsed = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const thought = typeof parsed.thought === 'string' ? parsed.thought : ''
  if (parsed.finish === true || typeof parsed.answer === 'string') {
    return { thought, finish: true, answer: typeof parsed.answer === 'string' ? parsed.answer : '' }
  }
  if (typeof parsed.tool === 'string' && parsed.tool) {
    const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args as Record<string, unknown> : {}
    return { thought, tool: parsed.tool, args }
  }
  return null
}

function buildSystemPrompt(o: AgentLoopOptions): string {
  const toolList = o.tools.map(t => `- ${t.name}：${t.description}\n    调用参数示例：${t.argsHint}`).join('\n')
  return `你是一个能自主使用工具、多步完成任务的智能体。你面对一个可能需要"多次检索/计算/交叉核对"才能回答的任务，请一步步推进，不要指望一次到位。

【当前日期】${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}
${o.contextBlock ? '\n' + o.contextBlock + '\n' : ''}
【任务】
${o.task}

【可用工具】
${toolList}

【工作方式（每一步只输出一个 JSON，不要多余文字）】
- 要调用工具：{"thought":"我现在需要...","tool":"工具名","args":{...}}
- 已能给出最终答案：{"thought":"依据...","finish":true,"answer":"最终答案（简洁、直接给结论）"}

【铁律】
- 一次只做一步；每一步都基于上一步真实观察到的结果来决定，绝不臆测工具会返回什么。
- **计算/计数/求和/日期差**这类务必用 python 工具真算，不要心算硬报。
- 最终答案**只能**建立在你实际观察到的工具结果上；结果不足以确定答案时，如实说明缺什么，绝不编造人名/数字/日期/单号。
- 需要的事实还没拿到就继续调工具；已经拿到足够信息就尽快 finish，不要无谓地多绕。`
}

/**
 * 运行通用 agent 循环。返回最终答案 + 完整步骤轨迹。
 * 步数耗尽仍未 finish → 强制收尾（让模型基于已有观察给最佳答案，或如实说未能完成）。
 */
export async function runAgentLoop(o: AgentLoopOptions): Promise<AgentLoopResult> {
  try {
    return await runAgentLoopInner(o)
  } finally {
    // 有状态工具（browse 的浏览器会话等）统一清理，绝不泄漏离屏窗口
    for (const t of o.tools) { if (t.cleanup) { try { await t.cleanup() } catch (e) { swallow(e, 'tool-cleanup') } } }
  }
}

async function runAgentLoopInner(o: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = o.maxSteps ?? 10
  const obsCap = o.obsCap ?? 2400
  const budgetMs = o.budgetMs ?? 0    // >0 启用墙钟预算：超预算主动收尾，不被外层硬 timeout 砍成空答
  const startMs = Date.now()
  const call = o.callModel
  const sys = buildSystemPrompt(o)
  const steps: AgentStep[] = []
  const scratch: string[] = []
  const toolByName = new Map(o.tools.map(t => [t.name, t]))
  let lastKey = ''          // 循环侦测：连续两次同工具+同参数 → 提示模型换招
  let repeat = 0
  let parseFails = 0

  for (let i = 0; i < maxSteps; i++) {
    if (budgetMs > 0 && Date.now() - startMs > budgetMs) {
      // 时间预算耗尽：别再起新一步（慢工具可能又几十秒），直接跳到收尾用已获观察作答
      o.sendLog('observing', `[Agent] 接近时间预算（已用 ${Math.round((Date.now() - startMs) / 1000)}s），提前收尾。`)
      break
    }
    const scratchBlock = scratch.length ? `\n【已完成的步骤与观察】\n${scratch.join('\n')}\n` : ''
    const nudge = repeat >= 1 ? '\n（注意：你上一步重复了完全相同的调用且没有新进展，请换一个检索词/工具/角度，或直接 finish。）' : ''
    const prompt = `${sys}\n${scratchBlock}\n请决定下一步（只输出一个 JSON）：${nudge}`
    let raw = ''
    try { raw = await call(prompt, o.cfg, { temperature: 0, longRunning: true }) } catch (e) {
      swallow(e, 'agent-loop-model')
      // 模型调用失败：收尾，给已有观察能得出的结论
      break
    }
    const d = parseAgentDecision(raw)
    if (!d) {
      parseFails++
      o.sendLog('thinking', `[Agent] 第 ${i + 1} 步决策解析失败，重试…`)
      if (parseFails >= 3) break
      scratch.push(`第${i + 1}步：（输出无法解析为决策 JSON，已提示重试）`)
      continue
    }
    parseFails = 0

    if (d.finish) {
      steps.push({ n: i + 1, thought: d.thought, finish: true })
      o.sendLog('completed', `[Agent] 已得出答案（共 ${i + 1} 步）。`)
      return { answer: d.answer || '', steps, finished: true }
    }

    const tool = toolByName.get(d.tool!)
    const key = `${d.tool}|${JSON.stringify(d.args || {})}`
    repeat = key === lastKey ? repeat + 1 : 0
    lastKey = key
    if (repeat >= 2) {
      // 连续三次一模一样 → 判定卡死，强制收尾
      o.sendLog('observing', `[Agent] 连续重复同一调用，终止循环并收尾。`)
      steps.push({ n: i + 1, thought: d.thought, tool: d.tool, args: d.args, observation: '（重复调用，已终止）' })
      break
    }

    if (!tool) {
      const obs = `未知工具「${d.tool}」。可用工具：${o.tools.map(t => t.name).join('、')}`
      steps.push({ n: i + 1, thought: d.thought, tool: d.tool, args: d.args, observation: obs })
      scratch.push(`第${i + 1}步：想调用「${d.tool}」→ ${obs}`)
      continue
    }

    o.sendLog('acting', `[Agent] 第 ${i + 1} 步 · ${tool.name}(${JSON.stringify(d.args).slice(0, 80)})`)
    let obs = ''
    try { obs = await tool.run(d.args || {}, o.sendLog) } catch (e: any) {
      obs = `工具执行出错：${e?.message || e}`
      swallow(e, 'agent-tool-run')
    }
    if (obs.length > obsCap) obs = obs.slice(0, obsCap) + `\n…（观察过长，已截断，共 ${obs.length} 字）`
    steps.push({ n: i + 1, thought: d.thought, tool: d.tool, args: d.args, observation: obs })
    scratch.push(`第${i + 1}步：${d.thought ? d.thought + ' → ' : ''}调用 ${tool.name}(${JSON.stringify(d.args)})\n  观察：${obs}`)
  }

  // 步数耗尽/中断 → 强制收尾：让模型基于已有观察给最佳答案
  const finalPrompt = `${sys}\n\n【已完成的步骤与观察】\n${scratch.join('\n') || '（无有效观察）'}\n\n你已达到步数上限或无法继续。请**只依据上面真实观察到的结果**给出最终答案；若观察不足以确定答案，如实说明已确认到哪一步、还缺什么，绝不编造。只输出答案本身。`
  let answer = ''
  try { answer = await call(finalPrompt, o.cfg, { temperature: 0, longRunning: true }) } catch (e) { swallow(e, 'agent-loop-final') }
  // 收尾输出偶尔仍被模型套上 JSON 决策壳（{"thought":…,"answer":"519"}）——拆出内容，绝不把裸 JSON 甩给用户
  //（实测 fr04 泄漏教训）。纯文本答案 parseAgentDecision 返回 null，保持原样。
  const parsedFinal = parseAgentDecision(answer)
  if (parsedFinal) answer = parsedFinal.answer || parsedFinal.thought || ''
  o.sendLog('completed', `[Agent] 步数上限收尾（共 ${steps.length} 步）。`)
  return { answer: answer.trim() || '未能在步数内完成该任务。', steps, finished: false }
}
