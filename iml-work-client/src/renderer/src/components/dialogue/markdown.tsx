import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { swallow } from '../../utils'

// 对话消息的 Markdown 渲染器（分段解析：粗体/代码/链接/图片/列表/表格）与
// 配套的图片灯箱（MarkdownRenderer 内图片点击派发 iml:lightbox 事件，此处接收展示）。
// 样式沿用 DialoguePanel 的全局 <style>。

interface Segment {
  type: 'text' | 'bold' | 'code' | 'link' | 'image'
  text: string
  url?: string
}

export function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  
  let currentTable: { headers: string[]; rows: string[][] } | null = null
  // 列表项：node 是该项主体，sub 是其嵌套子条目（如有序项下挂的 * 明细 bullet）
  type ListItem = { node: React.ReactNode; sub: React.ReactNode[] }
  let currentList: { type: 'ul' | 'ol'; items: ListItem[] } | null = null

  const flushTable = (key: string) => {
    if (!currentTable) return null
    const tbl = currentTable
    currentTable = null
    return (
      <div key={key} className="markdown-table-wrapper">
        <table>
          <thead>
            <tr>
              {tbl.headers.map((h, i) => (
                <th key={i}>
                  {renderInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tbl.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const flushList = (key: string) => {
    if (!currentList) return null
    const lst = currentList
    currentList = null
    const renderItem = (it: ListItem, idx: number) => (
      <li key={idx}>
        {it.node}
        {it.sub && it.sub.length > 0 && (
          <ul>{it.sub.map((s, si) => <li key={si}>{s}</li>)}</ul>
        )}
      </li>
    )
    return lst.type === 'ul'
      ? <ul key={key}>{lst.items.map(renderItem)}</ul>
      : <ol key={key}>{lst.items.map(renderItem)}</ol>
  }

  const renderInline = (text: string): React.ReactNode => {
    let segments: Segment[] = [{ type: 'text', text }]

    // 1. Parse Images: !\[(.*?)\]\((.*?)\)
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const imgRegex = /!\[(.*?)\]\((.*?)\)/g
      let match
      while ((match = imgRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'image', text: match[1], url: match[2] })
        lastIndex = imgRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    // 2. Parse Links: \[(.*?)\]\((.*?)\)
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const linkRegex = /\[(.*?)\]\((.*?)\)/g
      let match
      while ((match = linkRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'link', text: match[1], url: match[2] })
        lastIndex = linkRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    // 2b. Bare URLs -> compact clickable links (show hostname, hide long URL)
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let last = 0
      const urlRegex = /(https?:\/\/[^\s)）]+)/g
      let m
      while ((m = urlRegex.exec(seg.text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', text: seg.text.substring(last, m.index) })
        let label = m[1]
        try { label = new URL(m[1]).hostname.replace(/^www\./, '') } catch (e) { swallow(e, 'parse citation url') }
        parts.push({ type: 'link', text: label, url: m[1] })
        last = urlRegex.lastIndex
      }
      if (last < seg.text.length) parts.push({ type: 'text', text: seg.text.substring(last) })
      return parts
    })

    // 3. Parse Bold: \*\*(.*?)\*\*
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const boldRegex = /\*\*(.*?)\*\*/g
      let match
      while ((match = boldRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'bold', text: match[1] })
        lastIndex = boldRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    // 4. Parse Inline Code: `(.*?)`
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const codeRegex = /`(.*?)`/g
      let match
      while ((match = codeRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'code', text: match[1] })
        lastIndex = codeRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    return (
      <>
        {segments.map((seg, i) => {
          switch (seg.type) {
            case 'bold':
              return <strong key={i}>{seg.text}</strong>
            case 'code':
              return <code key={i}>{seg.text}</code>
            case 'link':
              return (
                <a 
                  key={i} 
                  href={seg.url}
                  onClick={(e) => {
                    e.preventDefault()
                    if (seg.url) {
                      if (seg.url.startsWith('file://')) {
                        (window as any).api.invoke('window:open-path', seg.url.replace('file://', ''))
                      } else {
                        (window as any).api.invoke('window:open-url', seg.url)
                      }
                    }
                  }}
                >
                  {seg.text}
                </a>
              )
            case 'image':
              return (
                <span key={i} className="chat-image-container" style={{ display: 'inline-block' }}>
                  <img
                    src={seg.url}
                    alt={seg.text}
                    title="点击查看大图"
                    onClick={() => {
                      if (seg.url) window.dispatchEvent(new CustomEvent('iml:lightbox', { detail: seg.url }))
                    }}
                  />
                </span>
              )
            default: {
              // 处理 <br> / <br/>：拆成多行（LLM 在表格单元格里常用 <br> 换行）
              const parts = seg.text.split(/<br\s*\/?>/i)
              if (parts.length === 1) return <span key={i}>{seg.text}</span>
              return <span key={i}>{parts.map((p, j) => <React.Fragment key={j}>{j > 0 && <br />}{p}</React.Fragment>)}</span>
            }
          }
        })}
      </>
    )
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 1. Check Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (currentList) {
        elements.push(flushList(`list-${i}`))
      }
      
      const cells = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
      
      if (!currentTable) {
        currentTable = { headers: cells, rows: [] }
      } else {
        const isSeparator = cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c))
        if (!isSeparator) {
          currentTable.rows.push(cells)
        }
      }
      continue
    }

    if (currentTable) {
      elements.push(flushTable(`table-${i}`))
    }

    // 2. Check Unordered Lists
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('▸ ')) {
      if (currentTable) {
        elements.push(flushTable(`table-${i}`))
      }
      const itemContent = trimmed.substring(2)
      // 若当前是有序列表，则这些 bullet 视为「当前有序项的嵌套子条目」，不打断父 <ol> 的编号
      if (currentList && currentList.type === 'ol' && currentList.items.length > 0) {
        currentList.items[currentList.items.length - 1].sub.push(renderInline(itemContent))
        continue
      }
      if (!currentList || currentList.type !== 'ul') {
        if (currentList) elements.push(flushList(`list-${i}`))
        currentList = { type: 'ul', items: [{ node: renderInline(itemContent), sub: [] }] }
      } else {
        currentList.items.push({ node: renderInline(itemContent), sub: [] })
      }
      continue
    }

    // 3. Check Ordered Lists
    const olMatch = /^\d+\.\s+(.*)/.exec(trimmed)
    if (olMatch) {
      if (currentTable) {
        elements.push(flushTable(`table-${i}`))
      }
      const itemContent = olMatch[1]
      if (!currentList || currentList.type !== 'ol') {
        if (currentList) elements.push(flushList(`list-${i}`))
        currentList = { type: 'ol', items: [{ node: renderInline(itemContent), sub: [] }] }
      } else {
        currentList.items.push({ node: renderInline(itemContent), sub: [] })
      }
      continue
    }

    // 到这里是「非列表行」。若列表仍开着，需判断它与列表的关系，避免把同一个列表拆成
    // 多个单项 <ol>（那样每个都从 1 开始，于是全显示成 “1.”）。
    if (currentList) {
      const isStructural = trimmed.startsWith('#') || trimmed.startsWith('> ') || (trimmed.startsWith('|') && trimmed.endsWith('|'))
      if (trimmed === '') {
        // 空行不立即结束列表：若附近（可能夹着明细行）仍有列表项，视为同一列表，吞掉空行
        let j = i + 1, seen = 0, near = false
        while (j < lines.length && seen < 3) {
          const t = lines[j].trim()
          if (t === '') { j++; continue }
          if (/^[-*▸]\s/.test(t) || /^\d+\.\s+/.test(t)) { near = true; break }
          seen++; j++
        }
        if (near) continue
        elements.push(flushList(`list-${i}`))
        elements.push(<div key={i} style={{ height: '8px' }} />)
        continue
      }
      // 仅把「明细行」并入当前项（如“（发布单位：…）”这类括注、或缩进续行），不另起 <ol>；
      // 普通成句的过渡段落（如“此外，还检索到…”）则结束列表、单独成段。
      const isDetailLine = !isStructural && (/^[（(]/.test(trimmed) || /^\s+\S/.test(line))
      if (isDetailLine) {
        const last = currentList.items.length - 1
        if (last >= 0) {
          currentList.items[last].node = (<>{currentList.items[last].node}<br />{renderInline(trimmed)}</>)
          continue
        }
      }
      // 结构性块或普通段落 → 结束列表
      elements.push(flushList(`list-${i}`))
    }

    // 4. Check Headers（####~###### 统一按 h4 渲染：聊天气泡里更深的层级无视觉意义）
    const deepHeader = trimmed.match(/^#{4,6}\s+(.*)$/)
    if (deepHeader) {
      elements.push(<h4 key={i}>{renderInline(deepHeader[1])}</h4>)
      continue
    }
    if (trimmed.startsWith('### ')) {
      elements.push(<h3 key={i}>{renderInline(trimmed.substring(4))}</h3>)
      continue
    }
    if (trimmed.startsWith('## ')) {
      elements.push(<h2 key={i}>{renderInline(trimmed.substring(3))}</h2>)
      continue
    }
    if (trimmed.startsWith('# ')) {
      elements.push(<h1 key={i}>{renderInline(trimmed.substring(2))}</h1>)
      continue
    }

    // 5a. 水平分隔线（--- / *** / ___）
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      elements.push(<hr key={i} />)
      continue
    }

    // 5. Check Blockquote
    if (trimmed.startsWith('> ')) {
      elements.push(
        <blockquote key={i}>
          {renderInline(trimmed.substring(2))}
        </blockquote>
      )
      continue
    }

    // 6. Normal Line
    if (trimmed === '') {
      elements.push(<div key={i} style={{ height: '8px' }} />)
    } else {
      elements.push(<p key={i}>{renderInline(line)}</p>)
    }
  }

  if (currentTable) {
    elements.push(flushTable('table-final'))
  }
  if (currentList) {
    elements.push(flushList('list-final'))
  }

  return <div className="markdown-body">{elements}</div>
}

// 从当前动作文案归纳出一个简短的阶段标题（执行状态头部用），匹配不到则按日志类型兜底。
// 人类可读的文件大小（文件卡展示）

export function ImageLightbox() {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => setSrc((e as CustomEvent).detail || null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSrc(null) }
    window.addEventListener('iml:lightbox', onOpen)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('iml:lightbox', onOpen); window.removeEventListener('keydown', onKey) }
  }, [])
  if (!src) return null
  return (
    <div className="img-lightbox-overlay" onClick={() => setSrc(null)}>
      <button className="img-lightbox-close" onClick={() => setSrc(null)}><X size={18} /></button>
      <img src={src} alt="预览大图" onClick={e => e.stopPropagation()} />
    </div>
  )
}
