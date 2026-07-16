// 技能执行路径的岗位画像沉淀：录制/语义脚本技能**真实执行成功**后，把确认字段里的
// 业务对象沉进「我的关注」（字段标签↔本体类型标签数据驱动映射，见 focus-core.matchFieldsToTypes）。
//
// 为什么这条链路也该沉淀：录拜访时「关联商机」是从系统下拉真实选出的、拜访记录真实写进了 CRM——
// 对象和交互都是真的。以前只有本体消解路径沉淀，用户录完拜访，「我的关注」里客户/商机毫无痕迹。
//
// 与本体路径共用：岗位侧重域闸（getExpertOntologyDomains，同一份缓存）、focusTouch、画像摘要刷新。
// 依赖方向：skill-custom → 本模块 → (db / ontology-runtime / agent-ontology / focus-core)，无环。
import { focusTouch } from './db'
import { fetchOntologyHints } from './ontology-runtime'
import { getExpertOntologyDomains } from './agent-ontology'
import { scopeHintsByDomains } from './ontology-core'
import { matchFieldsToTypes, looksLikeObjectValue } from './focus-core'
import { maybeRefreshProfile } from './focus-profile'
import { swallow } from './util'
import type { LlmConfig } from './llm'
import type { SendLog } from './types'

export async function sinkSkillFields(args: {
  expertId: string
  skillLabel: string
  systemId?: string
  fields: { label: string; value: string }[]
  traceId?: string
  llmConfig?: LlmConfig
  sendLog?: SendLog
  /** 管理端在技能上配的显式映射（focusMapJson 解析后）。有它就完全按它来，objectType 空串=明确不沉淀。 */
  explicitMap?: { field: string; objectType: string }[]
}): Promise<void> {
  try {
    if (!args.expertId || !args.fields.length) return
    const domains = await getExpertOntologyDomains(args.expertId)
    const hints = scopeHintsByDomains(await fetchOntologyHints(), domains)
    // 显式映射优先（管理端技能编辑里人工核过的）；没配才退回自动匹配。
    // 侧重域闸对两者一视同仁：显式映射到了岗位侧重域之外的类型，也不沉（scoped hints 里查不到）。
    const typeOf = new Map((hints.types || []).map(t => [t.typeKey, t]))
    const matches = args.explicitMap
      ? args.fields
          .map(f => ({ f, m: args.explicitMap!.find(x => x.field === f.label) }))
          .filter(x => x.m && x.m.objectType && typeOf.has(x.m.objectType) && looksLikeObjectValue(x.f.label, x.f.value))
          .map(x => ({ typeKey: x.m!.objectType, typeLabel: typeOf.get(x.m!.objectType)!.label, domain: typeOf.get(x.m!.objectType)!.domain, value: x.f.value.trim(), fieldLabel: x.f.label }))
      : matchFieldsToTypes(args.fields, hints.types || [])
    if (!matches.length) return
    const touched: string[] = []
    for (const m of matches) {
      focusTouch({
        expertId: args.expertId, objectType: m.typeKey, externalId: '',
        displayName: m.value, systemId: args.systemId || '',
        kind: 'skill', traceId: args.traceId || '',
        summary: `${args.skillLabel}：${m.fieldLabel}=${m.value}`,
      })
      touched.push(`「${m.value}」（${m.typeLabel}）`)
      if (args.llmConfig) void maybeRefreshProfile(args.expertId, m.typeKey, m.value, args.llmConfig)
    }
    // 如实告知沉淀发生了——用户此前的困惑正是"录完拜访，关注列表毫无动静"
    if (touched.length && args.sendLog) args.sendLog('observing', `已沉淀到「我的关注」：${touched.join('、')}`)
  } catch (e) { swallow(e, 'skill-focus-sink') }
}
