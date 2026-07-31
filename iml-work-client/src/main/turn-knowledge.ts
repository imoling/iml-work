// 企业知识库工具化 + 寒暄快路径（阶段 3）。
//
// 变化：知识库检索从「每条消息无条件预检索」改成「模型判断需要时才调」。
// 预检索一次要 4~8 秒的后端往返，而绝大多数消息（寒暄、联网检索、算数、闲聊）根本用不上它——
// 这笔时延是每条消息都白付的。工具化后由模型按需触发，代价只在真要查制度/流程时才发生。
//
// 溯源角标仍然要：工具把每次命中的片段累积在闭包里，一轮结束由调用方取走。
import type { ToolSpec } from './tool-registry'
import { queryCorporateKnowledge, type CorporateChunk } from './corporate-rag'
import { swallow } from './util'

/** 寒暄判定词表（与旧链路 main.ts 同源；两边都要改时，以这里为单一来源）。 */
const TRIVIAL_TOKEN = /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在|你是谁|你是什么|你能干什么|你能做什么|你会什么|你能做些什么|介绍下自己|介绍一下自己|自我介绍|谢谢|多谢|辛苦了|早上好|中午好|下午好|晚上好|早安|晚安|好的|收到|ok|再见|拜拜)$/i

/**
 * 一句寒暄/自我介绍类消息 → 值得跳过整条管线（知识库检索 + 全套工具的一轮）。
 *
 * 按**分段词元**判定而非整句枚举：标点切段后每段都是寒暄词才算。
 * 曾经整句枚举，「你好，你是谁」这种组合句漏掉，照走全管线等半分钟只为一句问候。
 */
export function isTrivialMessage(content: string): boolean {
  const t = (content || '').trim()
  if (!t || t.length > 16) return false
  const segs = t.split(/[\s,，。.!！?？~～、;；]+/).filter(Boolean)
  return segs.length > 0 && segs.every(s => TRIVIAL_TOKEN.test(s))
}

export interface KnowledgeToolHandle {
  spec: ToolSpec
  /** 本轮所有命中的片段（供溯源角标）。 */
  hits: () => CorporateChunk[]
}

/**
 * search_knowledge 工具：查企业/个人知识库。
 *
 * 命中的片段累积在闭包里——溯源角标要的是"这次回答参考了哪些资料"，
 * 而模型可能查好几次，所以按调用顺序累积、去重后由调用方取走。
 */
export function makeKnowledgeTool(expertId: string): KnowledgeToolHandle {
  const collected: CorporateChunk[] = []
  const seen = new Set<string>()

  const spec: ToolSpec = {
    name: 'search_knowledge',
    description: '检索企业知识库与你的个人知识库，返回相关制度、流程、产品资料的片段。'
      + '当问题涉及公司规定、报销/请假/审批标准、内部流程、产品说明、历史材料时**先用它查**，别凭常识回答。'
      + '这是内部资料，与联网检索是两回事：公司自己的规定只可能在这里。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查的内容，用具体的名词（如「差旅住宿标准」而不是「报销」）' } },
      required: ['query'],
    },
    metadata: { label: '查企业知识库', risk: 'low', category: 'knowledge' },
    run: async (args, ctx) => {
      const q = String(args.query || '').trim()
      if (!q) return '（search_knowledge 需要 query 参数）'
      let chunks: CorporateChunk[] = []
      try {
        chunks = await queryCorporateKnowledge(q, expertId)
      } catch (e) { swallow(e, 'turn-knowledge-query'); return '知识库检索失败（服务不可达），请如实告知用户，不要凭猜测作答。' }

      if (!chunks.length) {
        return `企业知识库里没有检索到与「${q}」相关的资料。`
          + '如果这个问题本该有内部规定，请如实说明没查到、建议用户到「知识库」页确认资料是否已上传，不要用通用常识冒充公司规定。'
      }
      for (const c of chunks) {
        const key = `${(c as any).filename || ''}|${String(c.text || '').slice(0, 60)}`
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(c)
      }
      ctx.sendLog('observing', `企业知识库命中 ${chunks.length} 条与「${q}」相关的资料`)
      const body = chunks.map((c: any, i: number) =>
        `[${i + 1}] 《${c.filename || '未命名'}》${c.scope === 'PERSONAL' ? '（个人知识）' : ''}\n${String(c.text || '').slice(0, 800)}`
      ).join('\n\n')
      // 图文并茂（与旧链路 attachRagImages 配套）：片段含插图时教模型保留【图N】占位，
      // 轮次收尾会把占位替换成知识库真实插图——占位丢了也有兜底附图，但保留占位排版最好。
      const hasImages = chunks.some((c) => c.images && c.images.length)
      return hasImages
        ? body + '\n\n（部分片段含插图占位标记，如【图1】。回答引用相应内容时请在恰当位置**原样保留标记**，系统会自动替换为真实插图；不要改写或编造不存在的标记。）'
        : body
    },
  }

  return { spec, hits: () => collected }
}

/** 命中片段 → 渲染层的溯源角标形状。 */
export function toSourceBadges(chunks: CorporateChunk[]) {
  return chunks.map((c: any, i: number) => ({
    seq: i + 1,
    name: c.filename || '未命名',
    scope: c.scope,
    score: c.score ?? 0,
    excerpt: String(c.text || '').slice(0, 120),
  }))
}
