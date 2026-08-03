// composer 的上下文控件（Token 用量与「整理上下文」的合并形态）：
// 圆环 = 上下文窗口占比，数字 = 会话累计 token；hover 看细节浮层，点击执行整理上下文。
// 数据源是主进程 recordLlmUsage 的真实 usage（计费审计同源），不是字符估算。
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { swallowUi } from '../../lib/ui-util'

interface UsageStats {
  prompt: number
  completion: number
  byModel: Record<string, { prompt: number; completion: number }>
  last: { prompt: number; completion: number; model: string }
  contextWindow: number
}

const fmt = (n: number) => n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export default function TokenPill({ convId, isGenerating, compacting, onCompact }: {
  convId: string | null
  isGenerating: boolean
  compacting: boolean
  onCompact: () => void
}) {
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [open, setOpen] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = () => {
    // 统计按会话分桶（主进程 usageByConv）：没有会话（欢迎态）就是零，不发 IPC
    if (!convId) { setStats(null); return }
    window.api.invoke('llm:usage-stats', convId)
      .then((r: any) => { if (r && typeof r.prompt === 'number') setStats(r) })
      .catch(e => swallowUi(e, 'token-pill'))
  }
  // 切会话立即刷新；生成结束时刷新（一轮任务的 usage 已落齐）
  useEffect(() => { if (!isGenerating) refresh() }, [isGenerating, convId])

  const enter = () => { if (hideTimer.current) clearTimeout(hideTimer.current); refresh(); setOpen(true) }
  const leave = () => { hideTimer.current = setTimeout(() => setOpen(false), 200) }

  const total = (stats?.prompt || 0) + (stats?.completion || 0)
  const ctxUsed = (stats?.last.prompt || 0) + (stats?.last.completion || 0)
  const ctxWindow = stats?.contextWindow || 128_000
  const ctxPct = Math.min(100, Math.round((ctxUsed / ctxWindow) * 100))
  // 圆环：r=7 → 周长 ≈ 44
  const C = 2 * Math.PI * 7

  return (
    <div style={{ position: 'relative' }} onMouseEnter={enter} onMouseLeave={leave}>
      <button type="button" className="token-pill" disabled={compacting}
        title="上下文占用 · 点击整理上下文（把早前轮次压成要点摘要）"
        onClick={onCompact}>
        {compacting
          ? <Loader2 size={14} className="drawer-spin" />
          : (
            <svg width="16" height="16" viewBox="0 0 16 16" className="token-ring">
              <circle cx="8" cy="8" r="7" fill="none" stroke="var(--bg-hover)" strokeWidth="2" />
              <circle cx="8" cy="8" r="7" fill="none" stroke="var(--brand-primary)" strokeWidth="2"
                strokeDasharray={`${(ctxPct / 100) * C} ${C}`} strokeLinecap="round"
                transform="rotate(-90 8 8)" />
            </svg>
          )}
        {total > 0 && <span>{fmt(total)}</span>}
      </button>
      {open && (
        <div className="composer-popover token-pop" onMouseEnter={enter} onMouseLeave={leave}>
          <div className="token-pop-sec">上下文窗口</div>
          <div className="token-bar"><div className="token-bar-fill" style={{ width: `${Math.max(ctxPct, 2)}%` }} /></div>
          <div className="token-pop-line">{fmt(ctxUsed)} / {fmt(ctxWindow)} · {ctxPct}%</div>
          {stats && Object.keys(stats.byModel).length > 0 && (
            <>
              <div className="token-pop-sec" style={{ marginTop: 10 }}>本次会话累计</div>
              {Object.entries(stats.byModel).map(([model, u]) => (
                <div key={model} className="token-pop-model">
                  <div className="token-pop-model-name">{model}</div>
                  <div className="token-pop-row"><span>输入</span><span>{fmt(u.prompt)}</span></div>
                  <div className="token-pop-row"><span>输出</span><span>{fmt(u.completion)}</span></div>
                </div>
              ))}
              <div className="token-pop-total"><span>合计</span><span>{fmt(total)} tokens</span></div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
