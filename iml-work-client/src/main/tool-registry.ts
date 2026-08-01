// 工具注册表——新执行内核里「能力」的唯一载体。
//
// 核心思想（取自 统一循环参考实现）：**能力差异只体现为注册表里工具的多少**，不体现为链路分支。
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
  /** 分类，仅用于展示分组。 */
  category?: string
}

export interface ToolRunContext {
  sendLog: SendLog
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
 * 并发安全判据：只有「声明为 low 档且不需审批」的工具才允许并发执行。
 * 写操作、browse、未标注的一律串行，
 * 宁可慢也不要并发写导致的状态竞争。
 */
export function isParallelSafe(spec: ToolSpec): boolean {
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
