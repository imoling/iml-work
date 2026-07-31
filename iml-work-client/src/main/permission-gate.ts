// 工具级权限闸——写保护的**唯一判据**从「猜用户意图」上移到「看工具能力」。
//
// 为什么要上移（体检 P1-2 的根因）：旧链路用 writeVerb 中文词表判读写意图，代码注释自己
// 就记着「路由词表判"读"不可靠（「补个卡」「作废掉」曾被判读意图）」。词表是穷举，
// 而用户的说法是开放的——漏一个词就是一次未经确认的真实写入。
//
// 现在：工具在 metadata 里声明自己 risk='write'，**模型无论用什么措辞发起调用，都必须过闸**。
// 词表（write-intent-core.ts）随之从"安全防线"降级为"UX 提示"——它失效只是提示不够早，
// 不再是安全事故。
//
// 叶子纪律：只依赖 confirm-token / tool-registry / types，绝不 import main.ts 或内核。
import type { TurnToolCall } from '../shared/turn-protocol'
import type { ToolSpec } from './tool-registry'
import { requestSignedConfirmation, tokenStateNote, type TokenState } from './confirm-token'
import type { FormField } from './automation-runtime'
import type { SendLog } from './types'

export interface AuthDecision {
  allowed: boolean
  /** 拒绝理由 / 放行说明——原样回灌给模型（让它知道为什么被拒，别死循环重试），并进 trace。 */
  reason: string
  /** 走过确认闸时带上，供 trace 如实标注（绝不在没消费令牌时声称"已用一次性签名令牌"）。 */
  tokenState?: TokenState
}

export interface AuthContext {
  /** 'readonly' 档：任何写工具直接拒，不给模型任何绕过空间。 */
  permMode: 'readonly' | 'full'
  /** 无人值守（定时任务/IM 触发）：没有人在屏幕前，不能弹卡也不能替用户签字。 */
  unattended?: boolean
  sendLog: SendLog
}

/** 单个参数值渲染成用户能核对的一行；长内容（代码/正文）截断，确认卡不是日志窗口。 */
function previewValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? flat.slice(0, 300) + '…' : flat
}

/**
 * 把一次工具调用渲染成确认卡字段——**用户签字时看到的就是这些**。
 *
 * 这份字段同时是签名令牌的 formDataHash 来源，语义是「执行的动作与用户签字时看到的单据未被中途调包」。
 * 所以必须把决定后果的参数全都摆出来：只写"执行 browse"而不显示点哪个按钮，签字就没有意义。
 */
export function describeCall(spec: ToolSpec, call: TurnToolCall): FormField[] {
  const fields: FormField[] = [
    { name: '_tool', label: '将执行的操作', value: spec.metadata.label, type: 'text' },
  ]
  const schemaProps = spec.parameters.properties || {}
  for (const [key, value] of Object.entries(call.args)) {
    const preview = previewValue(value)
    if (!preview) continue
    fields.push({ name: key, label: schemaProps[key]?.description || key, value: preview, type: 'text' })
  }
  return fields
}

/**
 * 判定一次工具调用是否可以执行。
 *
 * 顺序刻意如此：先按权限档硬拒（不弹卡、不打扰），再按风险档走签字闸。
 * 返回 allowed=false 时，调用方必须把 reason 作为 tool 结果回灌给模型——
 * 让它知道"被拒了、为什么"，而不是拿不到结果反复重试同一个调用。
 */
export async function authorizeToolCall(
  spec: ToolSpec | undefined,
  call: TurnToolCall,
  ctx: AuthContext,
): Promise<AuthDecision> {
  if (!spec) {
    return { allowed: false, reason: `未知工具「${call.name}」，请从可用工具中选择。` }
  }

  const needsGate = spec.metadata.risk === 'write' || !!spec.metadata.requiresApproval

  // ① 只读档：写工具一律拒。这是用户显式选择的档位，模型不得越过。
  if (ctx.permMode === 'readonly' && spec.metadata.risk === 'write') {
    const reason = `只读模式：已拦截「${spec.metadata.label}」，未改动任何系统。如需执行请切换到完全权限档。`
    ctx.sendLog('acting', `🔒 ${reason}`)
    return { allowed: false, reason }
  }

  if (!needsGate) return { allowed: true, reason: '低风险工具，自动放行' }

  // ② 无人值守：没有人在屏幕前核对单据，**绝不替用户签字**。
  //    宁可任务半途停下如实报"需要人工确认"，也不能无人确认地写进业务系统。
  if (ctx.unattended) {
    const reason = `「${spec.metadata.label}」是写操作，需要人工确认，但当前是无人值守运行，已跳过未执行。`
    ctx.sendLog('acting', `⏸️ ${reason}`)
    return { allowed: false, reason }
  }

  // ③ 写工具：本地确认卡（人看清单据）+ 服务端 HMAC 一次性令牌（防重放/防中途调包）双闸。
  ctx.sendLog('acting', `分身准备执行「${spec.metadata.label}」——这是**写操作**，请在确认卡核对后签字…`)
  const sc = await requestSignedConfirmation(
    describeCall(spec, call),
    { actionId: `tool:${call.name}` },
  )

  if (sc.tokenState === 'rejected') {
    const reason = `安全闸拦截：确认令牌校验未通过（${sc.rejectReason || '过期/重放/表单变更'}），未执行。`
    ctx.sendLog('acting', `🚫 ${reason}`)
    return { allowed: false, reason, tokenState: sc.tokenState }
  }
  if (!sc.values) {
    const reason = `用户取消了「${spec.metadata.label}」，未执行。请不要重复发起同一操作，改为询问用户下一步。`
    ctx.sendLog('acting', `✋ ${reason}`)
    return { allowed: false, reason, tokenState: sc.tokenState }
  }

  // consumed=双闸通过；degraded=令牌服务不可达、仅本地确认——**如实标注**，绝不谎称已用签名令牌。
  return { allowed: true, reason: tokenStateNote(sc.tokenState), tokenState: sc.tokenState }
}
