// 错误边界：任何组件在渲染时抛错，都不该让整个应用变成一块白屏。
//
// React 的默认行为是卸载整棵树——屏幕全白、终端日志一片正常，用户和排查者都拿不到任何线索。
// 实测踩过：登录页 `username.trim is not a function`（启动竞态下 window.api 被 mock 顶替，
// db:config-get 返回了对象）直接白屏，查了很久才定位。
//
// 有了这层，同样的故障会显示成一张带错误信息的卡片，并给出「重新加载」——
// 用户能自救，排查者一眼看到是哪个组件、什么错。
import React from 'react'

interface State { err: Error | null }

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { err: null }

  static getDerivedStateFromError(err: Error): State { return { err } }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    // 转发到主进程日志（dev 下 main.ts 会把 renderer console 打到终端）
    console.error('[ErrorBoundary]', err?.message, info?.componentStack)
  }

  render(): React.ReactNode {
    const { err } = this.state
    if (!err) return this.props.children
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', gap: 14, padding: 32, textAlign: 'center',
        font: '14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      }}>
        <div style={{ fontSize: 34 }}>😵</div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>界面出错了</div>
        <div style={{ fontSize: 13, color: '#8a8a8a', maxWidth: 520, wordBreak: 'break-all' }}>
          {err.message || String(err)}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 6, padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid #16a34a', background: '#16a34a', color: '#fff', fontSize: 13,
          }}>
          重新加载
        </button>
        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
          反复出现请把上面这行错误信息告诉管理员。
        </div>
      </div>
    )
  }
}
