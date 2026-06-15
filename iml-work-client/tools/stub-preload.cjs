const { contextBridge } = require('electron')
let logCb = null
const STEPS = [
  { type: 'thinking', text: '识别为「报销单检查」任务，开始构建岗位与个人上下文…' },
  { type: 'acting', text: '调用业务技能：读取《差旅报销管理规范》' },
  { type: 'observing', text: 'sandbox> matched 32 rules · version v2.1' },
  { type: 'acting', text: '检查票据金额：识别 5 张票据，合计 ¥2,850.00' },
  { type: 'thinking', text: '识别风险项：发现 2 条需确认事项（超标住宿 / 缺失发票）' },
  { type: 'observing', text: 'sandbox> risk_scan done, level=LOW' },
  { type: 'completed', text: '已生成处理建议，等待用户确认后提交 OA' },
]
contextBridge.exposeInMainWorld('api', {
  invoke: async (ch) => {
    switch (ch) {
      case 'db:config-get-all': return { theme: 'light', 'user-nickname': '张经理' }
      case 'window:is-maximized': return false
      case 'expert:claim': return { success: true, skillsSynced: [
        { id: 'web-screenshot', name: '网页截图', type: 'playwright' },
        { id: 'weather-check', name: '天气查询', type: 'python-sandbox' },
        { id: 'workspace-analyzer', name: '工作空间分析', type: 'python-sandbox' } ], knowledgeScope: ['企业合规制度'] }
      case 'systems:list': return { ok: true, adminBaseUrl: 'http://localhost:8080', systems: [
        { id: 'sys-oa', type: 'OA', name: '讯飞OA', baseUrl: 'https://sso.iflytek.com:8443/sso/login?service=http://in.iflytek.com/', status: 'CONNECTED', linked: true },
        { id: 'sys-crm', type: 'CRM', name: '讯飞CRM', baseUrl: 'https://crm.iflytek.com/XV/UI/Home', status: 'CONNECTED', linked: false },
        { id: 'sys-mail', type: 'EMAIL', name: '讯飞邮箱', baseUrl: 'https://mail.iflytek.com/', status: 'CONNECTED', linked: false } ] }
      case 'systems:check': return { ok: true, loggedIn: true }
      case 'files:list': return []
      case 'db:conv-list': return []
      case 'agent:send-message':
        STEPS.forEach((s, i) => setTimeout(() => logCb && logCb({ ...s, timestamp: '10:32:' + (10 + i) }), 140 * (i + 1)))
        await new Promise((r) => setTimeout(r, 140 * (STEPS.length + 2)))
        return { content: '已读取审批规则，发现 **2 条需确认事项**，可提交至 OA 或导出为记录。', success: true }
      default: return null
    }
  },
  on: (ch, cb) => { if (ch === 'agent:log-stream') logCb = cb; return () => {} },
  send: () => {},
  platform: 'darwin',
})
