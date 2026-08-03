import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import './style.css'

// window.api 缺席时的兜底。分两种，**绝不混用**：
//
// · 浏览器里开 vite 调样式 → 给假数据，让界面能画出来；
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

if (typeof window !== 'undefined' && !window.api && !IS_ELECTRON) {
  (window as any).api = {
    invoke: (channel: string, ...args: any[]) => {
      console.warn(`[API Mock] invoke: ${channel}`, args)
      if (channel === 'files:list') {
        return Promise.resolve([
          { name: "2026_q2_sales_plan.pdf", path: "/documents/2026_q2_sales_plan.pdf", summary: "Q2销售规划，目标拓展北方市场客户", synced: true },
          { name: "company_policy.docx", path: "/documents/company_policy.docx", summary: "企业考勤与报销管理规定细则", synced: false }
        ])
      }
      // 未知通道返回 null 而不是 {success:true}：编造一个"成功"对象会让调用方拿到错类型数据，
      // 比拿不到更难查（白屏根因就是这么来的）。
      return Promise.resolve(null)
    },
    on: (channel: string, _callback: (...args: any[]) => void) => {
      console.warn(`[API Mock] on: ${channel}`)
      return () => {}
    },
    send: () => {},
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
)
