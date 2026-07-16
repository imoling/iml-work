// 岗位画像的 LLM 摘要层：把对象的交互流水浓缩成三两句"跟进画像"，缓存进 focus_object.profile_summary。
//
// 设计约束：
//   · **低频**——接触满 5 次的倍数、或摘要已陈旧（>7 天）才重生成；绝不每次任务都烧 tokens。
//   · **异步旁路**——由本体执行后 fire-and-forget 触发，失败静默（swallow），绝不阻塞/拖慢执行链路。
//   · **只基于流水**——摘要的每一句都来自 focus_event 的真实记录，提示词里明令禁止推断编造。
import { focusRecent, focusEvents, focusSetProfile } from './db'
import { callLlm, type LlmConfig } from './llm'
import { swallow } from './util'

const REFRESH_EVERY_TOUCHES = 5
const STALE_SECONDS = 7 * 86400

/** 需要时为该对象重生成画像摘要（不需要则零成本返回）。调用方 void 掉，不 await。 */
export async function maybeRefreshProfile(expertId: string, objectType: string, displayName: string, cfg: LlmConfig): Promise<void> {
  try {
    const row = focusRecent(expertId, objectType, 50).find(f => f.displayName === displayName)
    if (!row) return
    const due = (row.touchCount >= REFRESH_EVERY_TOUCHES && row.touchCount % REFRESH_EVERY_TOUCHES === 0)
      || (!!row.profileSummary && Date.now() / 1000 - row.profileAt > STALE_SECONDS)
    if (!due) return
    const events = focusEvents(row.id, 10)
    if (events.length < 2) return
    const lines = events.map(e => {
      const d = new Date(e.ts * 1000)
      return `- ${d.getMonth() + 1}/${d.getDate()}：${e.summary}`
    }).join('\n')
    const prompt = `以下是用户对业务对象「${row.displayName}」（${objectType}${row.lastState ? `，当前状态：${row.lastState}` : ''}）的真实操作流水。请用两三句话概括跟进情况（做过什么、进展到哪、有无反复），供下次提到该对象时快速回忆。只基于流水陈述，绝不推断或补充流水之外的信息；直接输出摘要本身，不要前缀。\n${lines}`
    const out = (await callLlm(prompt, cfg, { temperature: 0 })).trim()
    if (out) focusSetProfile(row.id, out)
  } catch (e) { swallow(e, 'focus-profile') }
}
