import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './style.css'

// Defensive fallback mock for window.api when run outside Electron context or during startup race conditions
if (typeof window !== 'undefined' && !window.api) {
  (window as any).api = {
    invoke: (channel: string, ...args: any[]) => {
      console.warn(`[API Mock] invoke: ${channel}`, args);
      // Mock default responses for main channel events
      if (channel === 'files:list') {
        return Promise.resolve([
          { name: "2026_q2_sales_plan.pdf", path: "/documents/2026_q2_sales_plan.pdf", summary: "Q2销售规划，目标拓展北方市场客户", synced: true },
          { name: "company_policy.docx", path: "/documents/company_policy.docx", summary: "企业考勤与报销管理规定细则", synced: false }
        ]);
      }
      return Promise.resolve({ success: true });
    },
    on: (channel: string, _callback: (...args: any[]) => void) => {
      console.warn(`[API Mock] on: ${channel}`);
      return () => {};
    },
    send: (channel: string, ...args: any[]) => {
      console.warn(`[API Mock] send: ${channel}`, args);
    }
  };
}


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
