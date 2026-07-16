// 企业/个人分层知识 RAG：企业信息块、检索范围、pgvector 检索、prompt 块渲染、
// 图文占位替换与知识溯源。只依赖 http/db/util 叶子模块，供 agent 管线（main.ts）调用。
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch, getOwnerId } from './http'
import { swallow } from './util'

export async function getEnterpriseBlock(): Promise<string> {
  let p: any = {}
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/enterprise`)
    if (r.ok) p = await r.json()
  } catch (e) { swallow(e) }
  const lines: string[] = []
  if (p.companyName) lines.push(`- 企业名称：${p.companyName}`)
  if (p.info) lines.push(`- 其他信息：${String(p.info).replace(/\n/g, '\n  ')}`)
  return lines.length ? lines.join('\n') : '- （企业信息尚未在管理端配置）'
}

// 岗位的企业知识授权范围（哪些分类可检索）。
//
// ⚠️ 这份范围**只在「领用岗位」时下发一次**（expert:claim → configSet('kbScope:…')）。
// 于是运维在管理端给岗位加了个知识分类，**已领用的客户端根本不知道** —— 它还拿着领用当天的那份，
// 新分类下的文档既不显示、也检索不到。这是个静默失效：管理端看着改好了，员工端毫无反应。
// 现在：本地缓存作为**离线兜底**，同时按 60s TTL 从后端刷新，管理端改完最迟一分钟生效。
export function getKnowledgeScope(expertId?: string): string[] {
  if (!expertId) return []
  try {
    const raw = configGet('kbScope:' + expertId)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    }
  } catch (e) { swallow(e) }
  return []
}

// 按 TTL 从后端刷新授权范围；后端不可达时静默沿用本地缓存（离线仍可工作）。
const scopeRefreshAt = new Map<string, number>()
export async function refreshKnowledgeScope(expertId?: string): Promise<string[]> {
  if (!expertId) return []
  const last = scopeRefreshAt.get(expertId) || 0
  if (Date.now() - last < 60000) return getKnowledgeScope(expertId)
  scopeRefreshAt.set(expertId, Date.now())
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (r.ok) {
      const e = await r.json() as { knowledgeCategories?: string[] }
      if (Array.isArray(e.knowledgeCategories)) {
        const prev = getKnowledgeScope(expertId)
        const next = e.knowledgeCategories.filter(c => typeof c === 'string' && c)
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          console.log(`[Corporate RAG] 知识授权范围已更新：${prev.join('、') || '(空)'} → ${next.join('、') || '(空)'}`)
          configSet('kbScope:' + expertId, JSON.stringify(next))
        }
        return next
      }
    }
  } catch (e) { swallow(e, 'kb-scope-refresh') }
  return getKnowledgeScope(expertId)   // 后端不可达 → 沿用领用时下发的那份
}

export interface CorporateChunk { documentId: string; filename?: string; text: string; score: number; scope?: string; images?: { marker: string; dataUri: string }[] }

// Layered RAG: query the admin backend's pgvector store. Returns the union of
// ENTERPRISE chunks in the expert's knowledge categories PLUS the caller's own
// PERSONAL chunks (owner-scoped). Degrades gracefully to [] when offline.
// 知识库 RAG 相关性下限（检索注入与「知识来源」展示共用同一口径）：向量检索对任何问题都返回 top-K
// （闲聊/日期类也会捞到低相似度块），低于该值视为不相关——不注入 prompt、不报"查到 N 条制度"、不挂来源角标。
//
// ⚠️ **这条线是跟着 embedding 模型走的，换模型必须重新标定。**
// 旧值 0.45 是按"本地特征哈希兜底向量"定的。换成 bge-m3（真语义模型）后相似度分布整体上移：
//   真命中：0.655 ~ 0.790（动态虾池 0.783、三层模型 0.790、出差报销 0.655）
//   噪声：  ≤0.599（"你好"→0.599、"改简洁点"→0.569、"今天天气"→0.487）
// 沿用 0.45 的话，「今天天气怎么样」会以 0.487 命中一张图片，然后被当成"相关制度"塞进提示词。
// 实测两组干净可分，取中点略偏召回：0.62。
const RAG_MIN_SCORE = 0.62

export async function queryCorporateKnowledge(text: string, expertId?: string): Promise<CorporateChunk[]> {
  if (!text || !text.trim()) return []
  try {
    const scope = await refreshKnowledgeScope(expertId)   // 带 TTL 刷新：管理端改授权后最迟 60s 生效
    const params = new URLSearchParams({ text: text.slice(0, 500), topK: '4', clientId: expertId || 'client' })
    if (scope.length) params.set('categories', scope.join(','))
    params.set('ownerId', getOwnerId())   // 带上个人库归属 → 企业库 ∪ 我的个人库
    const url = `${getAdminBaseUrl()}/api/v1/knowledge/query?${params.toString()}`
    // 必须用 afetch(自动带登录 token):/knowledge/query 需鉴权,裸 fetch 会 403 → 知识库静默失效
    const res = await afetch(url)
    if (!res.ok) {
      console.warn(`[Corporate RAG] 检索被拒 HTTP ${res.status}(未登录或会话过期?)`)
      return []
    }
    const data: any = await res.json()
    if (!Array.isArray(data)) return []
    // 只留真相关的命中（与来源展示同一阈值）。旧阈值 0.1 形同虚设——向量相似度对任何问题都轻松超过，
    // 导致"你好"也永远"查到 4 条相关制度"（其实只是距离最近的 topK 条，并不相关）。
    return data
      .filter((c: any) => typeof c.text === 'string' && (c.score ?? 0) >= RAG_MIN_SCORE)
      .map((c: any) => ({ documentId: c.documentId, filename: c.filename, text: c.text, score: c.score ?? 0, scope: c.scope, images: Array.isArray(c.images) ? c.images : undefined }))
  } catch (err: any) {
    console.warn('[Corporate RAG] retrieval failed (offline?):', err.message)
    return []
  }
}

// Render retrieved chunks as a prompt block (empty string when none). Personal
// and enterprise hits are labelled so the agent knows which is the user's own
// material vs company policy.
export function buildCorporateRagBlock(chunks: CorporateChunk[]): string {
  if (!chunks.length) return ''
  const lines = chunks
    .map((c, i) => {
      const tag = c.scope === 'PERSONAL' ? '个人知识' : '企业制度'
      return `${i + 1}. [${tag}] (相似度 ${(c.score * 100).toFixed(0)}% · ${c.documentId}) ${c.text}`
    })
    .join('\n')
  const hasImages = chunks.some(c => c.images && c.images.length)
  const imageRule = hasImages
    ? `\n- 部分内容含插图占位标记（如【图1】）。若答案引用了对应内容，请在恰当位置**原样保留该标记**（系统会自动替换为真实插图），不要改写或删除标记，也不要编造不存在的标记。`
    : ''
  const sourceRule = `\n- 回答末尾**不要**自行编写「来源」「参考」「引用」段落，也不要把知识块里的标题拼成链接——系统会在答案后自动附加可信的「知识来源」。`
  return `\n\n【知识库检索结果 (个人+企业分层 · pgvector)】\n以下为从「我的个人知识库」与「企业云端知识库」实时检索到的最相关内容，请优先据此作答（[个人知识]=用户自己的资料，[企业制度]=公司统一规则）：\n${lines}${imageRule}${sourceRule}`
}

// 图文回答：把答案中的【图N】占位替换为知识库真实插图(markdown data-URI，渲染层可直接显示)。
// 宽松匹配【图N…】(模型常往括号里补描述)；库里没有的占位清除(绝不虚构图片)。
// 确定性兜底：模型把占位全弄丢时，把命中块的插图附在文末(最多 3 张)——图文不赌提示词遵循度。
export function attachRagImages(content: string, chunks: CorporateChunk[]): string {
  if (!content) return content
  const map = new Map<string, string>()
  for (const c of chunks) for (const im of c.images || []) if (!map.has(im.marker)) map.set(im.marker, im.dataUri)
  if (!map.size) return content
  const used = new Set<string>()
  let out = content.replace(/【图(\d+)[^】]*】/g, (_m, n) => {
    const key = `【图${n}】`
    const uri = map.get(key)
    if (!uri) return ''
    used.add(key)
    return `\n\n![图${n}](${uri})\n\n`
  })
  if (used.size === 0) {
    // 同一段落内空格相连 → 渲染层 inline-block 横向排列缩略图(点击可看大图)
    const rest = [...map.entries()].slice(0, 3)
    out += `\n\n**相关插图（来自知识库命中内容）**\n\n` + rest.map(([k, uri]) => `![${k.slice(1, -1)}](${uri})`).join(' ')
  }
  return out
}

// 知识溯源：命中文档去重(取最高相似度块),结构化返回渲染层——角标+悬浮卡展示,不污染正文。
export function buildKnowledgeSources(chunks: CorporateChunk[]): { seq: number; name: string; scope?: string; score: number; excerpt?: string }[] {
  if (!chunks.length) return []
  const seen = new Map<string, { name: string; score: number; scope?: string; excerpt?: string }>()
  for (const c of chunks) {
    if ((c.score ?? 0) < RAG_MIN_SCORE) continue   // 相关性不足 → 不作为来源展示（检索端已同阈值过滤，此处双保险）
    const cur = seen.get(c.documentId)
    if (!cur || c.score > cur.score) seen.set(c.documentId, { name: c.filename || c.documentId, score: c.score, scope: c.scope, excerpt: c.text })
  }
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({
      seq: i + 1, name: s.name, scope: s.scope, score: s.score,
      excerpt: (s.excerpt || '').replace(/【图\d+】/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }))
}
