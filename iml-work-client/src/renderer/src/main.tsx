import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import { installWebBridge } from './web-bridge'
import './style.css'

// window.api 缺席时的兜底。分两种，**绝不混用**：
//
// · 浏览器（B/S 形态）→ 接真 web-bridge，经 WS 连本机无头宿主（src/host）；
// · Electron 里 preload 没就绪（dev 下的已知竞态，见 CLAUDE.md）→ 给**明确失败**的桩。
//
// 为什么必须分开：原来只有一个桩、条件是 `!window.api`，于是 Electron 竞态时假数据顶了上去，
// db:config-get 回一个 {success:true} 对象，登录页 setUsername(对象) → username.trim() 抛错 → 白屏。
// 而如果什么都不给，window.api.invoke 又会直接 TypeError（同样白屏，只是换个错）。
// 明确失败最好：调用方拿到 rejected promise，界面照常渲染，错误信息也说得清是什么问题。
const IS_ELECTRON = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)

if (typeof window !== 'undefined' && !window.api && IS_ELECTRON) {
  const notReady = () => Promise.reject(new Error('本地服务尚未就绪（preload 未加载），请重启客户端'))
  ;(window as any).api = {
    invoke: (channel: string) => { console.error(`[preload 未就绪] invoke ${channel}`); return notReady() },
    on: () => () => {},
    send: () => {},
  }
}

// 浏览器（非 Electron）：真 web-bridge——WS 连本机宿主，原样式调试用的 API Mock 已由它取代
//（宿主没起时 invoke 排队 + 断线重连提示，比假数据诚实）。
if (typeof window !== 'undefined' && !window.api && !IS_ELECTRON) {
  installWebBridge()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
)
