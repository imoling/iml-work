// 工具注册表——新执行内核里「能力」的唯一载体。
//
// 核心思想：**能力差异只体现为注册表里工具的多少**，不体现为链路分支。
// 普通问答＝没注册业务工具的一轮；企业系统操作＝注册了 browse 的一轮。旧链路那种
// 「8 层正则决定走哪条路」的决策树，在这里退化成「决定注册哪些工具」。
//
// 与旧 `AgentTool`（agent-loop.ts 的文本 ReAct 工具）的关系：
// 形状不同（新的带 JSON Schema，旧的只有 argsHint 样例串），但能力实现完全复用——
// `fromAgentTool()` 把存量工具原样包进来，阶段 2 迁移时不用重写任何一个工具的执行体。
//
// 叶子纪律：只 import 类型与 util，绝不 import main.ts / llm / db。
import type { ToolRisk } from '../shared/core-protocol'
import type { AgentTool } from './agent-loop'
import type { SendLog } from './types'
import { swallow } from './util'

/** JSON Schema（function-calling 的 parameters 字段）。只用到 object 顶层，故形状收窄到够用。 */
export interface ToolParamSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: unknown }>
  required?: string[]
}

export interface ToolMetadata {
  /** 人话标签：权限确认卡与执行日志用（"在讯飞OA点击提交"里的"提交"就来自这里）。 */
  label: string
  /**
   * 风险档。**这是写保护的唯一判据**——从"猜用户意图"改成"看工具能力"。
   * 旧链路靠 writeVerb 中文词表判读写，「补个卡」「作废掉」曾被判成读意图（体检实测）；
   * 现在工具自己声明是写操作，模型无论怎么措辞都绕不过确认闸。
   */
  risk: ToolRisk
  /** 即使是 low 档也强制过确认闸（如消耗额度、外发消息）。 */
  requiresApproval?: boolean
  /**
   * 工具在 run() 内部**自己**发起签字确认（因为要先取回信息才能让人看清在批准什么）。
   *
   * 通用闸只能把原始入参罗列出来——安装技能时那张卡只会显示一个 URL，用户根本判断不了。
   * 而工具自己的卡能展示预检结果：技能名、触发词、包含哪些文件、安全扫描结论、装到哪。
   * 标了这个位，通用闸就不再重复弹卡（否则用户要签两次字，且第一张还更没用），
   * 但**只读拦截与无人值守拦截照常生效**——跳过的只是那张重复的卡片，不是闸门本身。
   */
  selfConfirms?: boolean
  /** 分类，仅用于展示分组。 */
  category?: string
}

export interface ToolRunContext {
  sendLog: SendLog
  /**
   * 本次调用的 id（由内核在 execOne 传入）。
   *
   * 绝大多数工具用不到它——需要它的是**会自己发事件的工具**（子智能体）：
   * 子智能体的工具行必须挂回"发起它的那次调用"上，渲染层才能嵌套显示；
   * 拿不到 callId 就只能靠"最近一次 run_subagent"去猜归属，一并行就错乱。
   */
  callId?: string
}

export interface ToolSpec {
  name: string
  /** 给模型看的说明——决定它什么时候调这个工具，写清楚"何时用/何时不用"。 */
  description: string
  parameters: ToolParamSchema
  metadata: ToolMetadata
  /** 执行体，返回给模型的「观察」文本。 */
  run: (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<string>
  /** 有状态工具（browse 的浏览器会话等）在一轮结束后的清理。 */
  cleanup?: () => Promise<void>
}

/** 上游 function-calling 的工具声明形状（OpenAI 兼容）。 */
export interface LlmToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: ToolParamSchema }
}

/**
 * 并发安全判据：只有「声明为 low 档且不需审批」的**无状态**工具才允许并发执行。
 * 写操作、browse、未标注的一律串行，宁可慢也不要并发写导致的状态竞争。
 *
 * ⚠️ browse 必须显式排除，不能只看 risk：browse 的 risk **有意**标成 low
 *（否则每次翻页都弹确认卡，用户会疲劳到闭眼点确认，反而更不安全——见 core-tools 的 browseTools 注释），
 * 于是它一度被判成可并发。而 browse 的多个调用操作的是**同一个浏览器窗口**：
 * 实测一轮里 5 个 fill 并发下发，只有部分真正落值，表单带着空字段被提交——
 * 库里留下一条 dest='' 的废单，而 agent 报告"已提交成功"。
 * 「看起来办成了、实际是废单」比直接失败危险得多，这条判据是红线。
 */
export function isParallelSafe(spec: ToolSpec): boolean {
  if (spec.metadata.category === 'browse') return false
  // 子智能体（category='subagent'）**允许**并行，走下面这条通用判据即可。
  // 首版曾照 browse 的样子把它也排除掉，理由写的是"共享 RunContext 的确认通道会互相覆盖"——
  // 那是 P2（子智能体拿到写能力）才会出现的风险，被提前套用到了一个全只读的形态上。
  // 实测承载：模型网关 4 路并发 4/4 成功、3.82× 加速且单次延迟无劣化；本地 Docker 沙箱
  // 3 路并发 3/3 成功、1.71× 加速。前提「工具表全只读」由 agent-subagent.buildSubRegistry
  // 的断言守住，不是靠这里的注释。
  return spec.metadata.risk === 'low' && !spec.metadata.requiresApproval
}

export class ToolRegistry {
  private specs = new Map<string, ToolSpec>()

  register(spec: ToolSpec): void {
    this.specs.set(spec.name, spec)
  }

  registerAll(specs: ToolSpec[]): void {
    for (const s of specs) this.register(s)
  }

  get(name: string): ToolSpec | undefined {
    return this.specs.get(name)
  }

  names(): string[] {
    return [...this.specs.keys()]
  }

  list(): ToolSpec[] {
    return [...this.specs.values()]
  }

  /** 出站给模型的工具声明。空注册表返回空数组（调用方据此不传 tools 字段）。 */
  schemas(): LlmToolSchema[] {
    return this.list().map(s => ({
      type: 'function' as const,
      function: { name: s.name, description: s.description, parameters: s.parameters },
    }))
  }

  /** 一轮结束后统一清理有状态工具，绝不泄漏离屏窗口/子进程。 */
  async cleanup(): Promise<void> {
    for (const s of this.list()) {
      if (!s.cleanup) continue
      try { await s.cleanup() } catch (e) { swallow(e, 'tool-registry-cleanup') }
    }
  }
}

/**
 * 把存量 `AgentTool`（文本 ReAct 工具）包装成新内核的 ToolSpec。
 *
 * argsHint 是给模型看的 JSON 样例串（如 `{"query":"检索词"}`），这里解析出键名生成**宽松 schema**
 * （全部 string、全部必填）。宽松是有意的：存量工具的执行体本来就用 `String(args.x || '')` 取参、
 * 自己做校验，收紧 schema 只会让模型因为类型不符被上游拒掉，而不会让执行更安全。
 */
export function fromAgentTool(tool: AgentTool, metadata: ToolMetadata): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: schemaFromArgsHint(tool.argsHint),
    metadata,
    run: (args, ctx) => tool.run(args, ctx.sendLog),
    ...(tool.cleanup ? { cleanup: tool.cleanup } : {}),
  }
}

/** 从 argsHint 的 JSON 样例串推出参数 schema；解析不了就给个自由形状（总比没有强）。 */
export function schemaFromArgsHint(argsHint: string): ToolParamSchema {
  let sample: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(argsHint || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sample = parsed as Record<string, unknown>
  } catch (e) { swallow(e, 'tool-registry-argshint') }

  const properties: ToolParamSchema['properties'] = {}
  for (const [key, value] of Object.entries(sample)) {
    // 样例值本身就是最好的参数说明（"具体检索词（越具体越好，可含实体名/年份）"）。
    properties[key] = { type: typeof value === 'number' ? 'number' : 'string', description: String(value) }
  }
  return { type: 'object', properties, required: Object.keys(properties) }
}
