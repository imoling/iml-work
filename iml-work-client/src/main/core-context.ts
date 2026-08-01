// 分身上下文的组装（有 IO：查企业信息/岗位画像/附件正文）。
//
// turn-prompt.ts 是纯函数（提示词模板），这里负责去各处**取真实数据**再交给它拼装。
// 这些块原先内联在 main.ts 的旧链路里，新内核起初只带了人设与记忆，
// 结果连「我是谁」都答不上来——企业信息、岗位画像、知识范围全缺席（实测）。
import { memoryGet, focusRecent, focusEvents } from './db'
import { getEnterpriseBlock, getKnowledgeScope } from './corporate-rag'
import { renderFocusBlock } from './focus-core'
import { extractAttachmentText } from './workspace-files'
import { swallow } from './util'
import type { SendLog } from './types'

/** 沉淀记忆读出来是 JSON 数组，渲染成给模型看的列表；坏数据不炸、当没有。 */
export function memoryLines(expertId: string, type: 'agent' | 'personal'): string {
  if (!expertId) return ''
  try {
    const raw = memoryGet(expertId, type)
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return ''
    return parsed.map((m: any) => `▸ ${m?.content ?? m}`).filter(Boolean).join('\n')
  } catch (e) { swallow(e, 'turn-context-memory'); return '' }
}

export interface CoreContextInput {
  content: string
  expertId: string
  sendLog: SendLog
  /** 本次是否需要读工作空间文件（由 needsWorkspaceFiles 判定）。 */
  wantsFiles: boolean
}

export interface CoreContextBlocks {
  /** 进 system 提示词的静态块（企业信息 + 知识范围）。 */
  standing: string
  /** 每轮 ephemeral 的动态块（岗位画像 + 附件正文）。 */
  ephemeral: string
}

/** 取齐一次任务需要的上下文（企业信息 + 岗位画像 + 附件正文）。 */
export async function buildTurnContext(i: CoreContextInput): Promise<CoreContextBlocks> {
  // 知识库**不在这里**预检索——它已工具化成 search_knowledge，由模型按需调用
  //（每条消息都预查一次的 4~8s 是白付的，问天气问算术根本用不上）。
  const enterprise = await getEnterpriseBlock().catch((e) => { swallow(e, 'turn-context-enterprise'); return '' })

  const standing: string[] = []
  if (enterprise) standing.push(enterprise)
  try {
    const scope = getKnowledgeScope(i.expertId)
    if (scope.length) {
      standing.push(`你可以用 search_knowledge 检索以下企业知识库（由管理端领用下发）：${scope.join('、')}。`
        + '涉及公司制度、流程、标准、产品资料的问题，先查它再回答。')
    }
  } catch (e) { swallow(e, 'turn-context-scope') }

  const ephemeral: string[] = []

  // 岗位画像：用户点名了最近跟进的业务对象 → 注入其本地沉淀（只读不写，来源是本体链路的真实接触）。
  // 收紧为**全名精确出现**：共用的 focusMentioned 按二字词组宽匹配——「华东电网智能巡检平台合同」
  // 的"智能""平台"撞上"桌面智能体…平台"就误判点名，两份无关合同画像被灌进上下文还顶到跑马灯标题
  //（实测截图）。宽匹配留给旧链路，这里只认去符号后的完整名。
  try {
    const rows = focusRecent(i.expertId, undefined, 20)
    const strip = (t: string) => (t || '').replace(/[\s·【】\[\]（）()「」，。、-]/g, '')
    const msgStripped = strip(i.content)
    const hit = rows.filter(r => {
      const name = strip(r.displayName)
      return name.length >= 4 && msgStripped.includes(name)
    }).slice(0, 2)
    const blocks = hit.map(f => renderFocusBlock(f.displayName, f.lastState, focusEvents(f.id, 5), f.profileSummary)).filter(Boolean)
    if (blocks.length) {
      ephemeral.push(blocks.join('\n\n'))
      i.sendLog('thinking', `想起你最近跟进过：${hit.map(f => `「${f.displayName}」`).join('、')}`)
    }
  } catch (e) { swallow(e, 'turn-context-focus') }

  // 附件正文：只在本轮确实带了附件/点名文件时解析，别为每条消息白跑一次解析。
  if (i.wantsFiles) {
    try {
      const text = await extractAttachmentText(i.content, i.sendLog)
      if (text) ephemeral.push(`【附件真实内容】（已从工作空间解析，请基于此作答，勿编造）\n${text}`)
    } catch (e) { swallow(e, 'turn-context-attachment') }
  }

  return { standing: standing.join('\n\n'), ephemeral: ephemeral.join('\n\n') }
}
