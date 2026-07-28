// 结果卡的两种「来源」展示（从 DialoguePanel 拆出——体检 P2-20：单组件 1052 行）。
// 这两块是纯展示（只读 msg 字段、无本地 state、无回调），拆出来零风险；
// 其余卡片（登录/表单/权限闸/删除/时间线）都带交互回调与本地态，按 B4 原则留给"下次触碰顺手拆"。
//
// 为什么两种来源要分开展示：知识来源=企业/个人知识库命中（角标+悬浮卡看相似度与命中段落），
// 联网来源=公网检索（可点开原网页核对）。混在一起用户分不清"这句话是内部规范还是网上说的"。
import { Globe } from 'lucide-react'

export interface KnowledgeSourceItem { seq: number; name: string; scope?: string; score: number; excerpt?: string }
export interface WebSourceItem { title: string; url: string }

/** 联网来源缺标题时兜底展示域名。 */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/** 知识溯源角标：悬浮显示来源卡（文件名/相似度/命中段落）。 */
export function KnowledgeSources({ sources }: { sources?: KnowledgeSourceItem[] }) {
  if (!sources || !sources.length) return null
  return (
    <div className="msg-sources">
      <span className="msg-sources-label">知识来源</span>
      {sources.map(s => (
        <span key={s.seq} className="src-badge">
          {s.seq}
          <span className="src-pop">
            <span className="src-pop-name">《{s.name}》{s.scope === 'PERSONAL' ? '（个人知识）' : ''}</span>
            <span className="src-pop-score">相似度 {(s.score * 100).toFixed(0)}%</span>
            {s.excerpt && <span className="src-pop-excerpt">“{s.excerpt}…”</span>}
          </span>
        </span>
      ))}
    </div>
  )
}

/** 联网来源：地球图标 + 标签，下面是可点开原网页的链接列表（字号从小、与正文区分）。 */
export function WebSources({ sources }: { sources?: WebSourceItem[] }) {
  if (!sources || !sources.length) return null
  return (
    <div className="msg-sources web">
      <span className="msg-sources-label"><Globe size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />联网来源</span>
      <ol className="web-src-list">
        {sources.map((s, i) => (
          <li key={i}>
            <button type="button" className="web-src-link" title={s.url}
              onClick={() => window.api.invoke('window:open-url', s.url)}>{s.title || hostOf(s.url)}</button>
          </li>
        ))}
      </ol>
    </div>
  )
}
