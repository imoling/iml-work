// 应用内文件阅读弹窗：文件卡「查看」对 .md / .csv 的默认打开方式。
//
// 为什么不用系统 Quick Look：它把 Markdown 当纯文本展示（黑底源码，表格/图表全是原始符号），
// 调研报告读起来像看代码（实测反馈）。这里用应用内已有的 MarkdownRenderer 渲染——
// 表格、```chart 图表卡、代码块全部按富文本呈现，与对话气泡同一套渲染。
import { useEffect, useState } from 'react'
import { X, FolderOpen } from 'lucide-react'
import { MarkdownRenderer } from './markdown'
import { isWebMode, openWorkspaceInBrowser } from '../../lib/ui-util'
import { parseCsvLite } from './csv-lite'

/** CSV → 概要 + 表格。「展示表格内容 + 概览」的实测诉求：CSV 用系统预览也是一坨逗号文本。 */
function CsvView({ text, name }: { text: string; name: string }) {
  const p = parseCsvLite(text)
  if (!p.headers.length) return <div className="mdp-error">（空文件或无法按 CSV 解析）</div>
  return (
    <div>
      <div className="mdp-csv-summary">
        「{name.replace(/\.csv$/i, '')}」共 {p.totalRows} 行 · {p.headers.length} 列：{p.headers.join('、')}
        {p.truncated ? `（下表展示前 ${p.rows.length} 行）` : ''}
      </div>
      <div className="mdp-csv-wrap">
        <table className="mdp-csv-table">
          <thead><tr>{p.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i}>{p.headers.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function MarkdownPreviewModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    window.api.invoke('files:read-text', name).then((r: any) => {
      if (!alive) return
      if (r?.success) setContent(String(r.content || ''))
      else setError(r?.error || '读取失败')
    }).catch(() => { if (alive) setError('读取失败') })
    return () => { alive = false }
  }, [name])

  // Esc 关闭（阅读场景的基本操作习惯）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="mdp-mask" onClick={onClose}>
      <div className="mdp-card" onClick={e => e.stopPropagation()}>
        <div className="mdp-head">
          <span className="mdp-title" title={name}>{name}</span>
          <div className="mdp-actions">
            {/* 访达定位是桌面能力：Web 形态换成「在新标签打开原文件」（正文预览本身两端都可用） */}
            {isWebMode() ? (
              <button type="button" className="mdp-btn" title="在新标签打开原文件"
                onClick={() => openWorkspaceInBrowser(name)}>
                <FolderOpen size={14} />
              </button>
            ) : (
              <button type="button" className="mdp-btn" title="在访达中显示"
                onClick={() => window.api.invoke('files:reveal', name)}>
                <FolderOpen size={14} />
              </button>
            )}
            <button type="button" className="mdp-btn" title="关闭（Esc）" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="mdp-body">
          {error
            ? <div className="mdp-error">{error}</div>
            : content === null
              ? <div className="mdp-error">加载中…</div>
              : /\.csv$/i.test(name)
                ? <CsvView text={content} name={name} />
                : <MarkdownRenderer content={content} />}
        </div>
      </div>
    </div>
  )
}
