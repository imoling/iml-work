// 一级导航（文档 §7.1）
export const NAV = [
  { path: '/', label: '项目交付驾驶舱', ic: 'dashboard', end: true },
  { path: '/projects', label: '项目总览', ic: 'briefcase' },
  { path: '/scenarios', label: '场景库', ic: 'layers' },
  { path: '/templates', label: '模板库', ic: 'package' }
]

// 项目阶段
export const PROJECT_STAGE = {
  discovery: '场景发现', modeling: '流程建模', skill_generation: '技能生成',
  testing: '试运行', delivery: '交付上架', completed: '已完成'
}

// 场景状态机（文档 §6.2）——含展示标签与流水线分段归属
export const SCENARIO_STATUS = {
  draft: { label: '草稿', tag: 'gray', step: 0 },
  collected: { label: '已采集', tag: 'blue', step: 1 },
  scored: { label: '已评分', tag: 'blue', step: 1 },
  modeled: { label: '已建模', tag: 'blue', step: 2 },
  blueprint_ready: { label: '蓝图就绪', tag: 'blue', step: 3 },
  orchestrated: { label: '已编排', tag: 'blue', step: 4 },
  package_generated: { label: '技能包已生成', tag: 'amber', step: 4 },
  testing: { label: '试运行中', tag: 'amber', step: 5 },
  test_failed: { label: '试运行失败', tag: 'red', step: 5 },
  test_passed: { label: '试运行通过', tag: 'green', step: 5 },
  submitted: { label: '已提交', tag: 'green', step: 6 },
  published: { label: '已发布', tag: 'green', step: 6 },
  templated: { label: '已模板化', tag: 'green', step: 7 }
}

// 场景转化流水线分段（驾驶舱/项目页用）
export const PIPELINE = ['采集', '评分', '建模', '蓝图', '编排', '试运行', '上架', '模板']

// 执行器类型（文档 §8.6）
export const EXECUTOR_TYPES = {
  browser_automation: { label: '浏览器自动化', ic: '🌐', real: true, desc: 'OA/CRM/ERP 等网页系统操作（Playwright 真执行）' },
  desktop_automation: { label: '桌面自动化', ic: '🖥️', real: false, desc: '操作桌面客户端、本地应用' },
  api_call: { label: 'API 调用', ic: '🔌', real: false, desc: '已有业务系统接口' },
  file_processing: { label: '文件处理', ic: '📄', real: false, desc: 'Excel / PDF / Word / 附件整理' },
  knowledge_lookup: { label: '知识检索', ic: '📚', real: false, desc: '企业制度 / SOP / 历史案例检索' },
  script_runner: { label: '脚本执行', ic: '⌨️', real: false, desc: '命令行 / Python / Node 脚本任务' },
  human_confirmation: { label: '人工确认', ic: '✅', real: true, desc: '提交/付款/删除/复核/审批等风险动作确认' },
  scheduled_task: { label: '定时任务', ic: '⏰', real: false, desc: '周期巡检 / 日报 / 月报 / 同步任务' },
  notification: { label: '通知', ic: '🔔', real: false, desc: '发送消息 / 邮件 / 企业 IM 通知' }
}

// 流程节点类型（文档 §8.4）
export const NODE_TYPES = {
  start: '开始', user_input: '用户输入', system_action: '系统操作', data_extract: '数据提取',
  knowledge_lookup: '知识检索', rule_check: '规则判断', human_confirm: '人工确认',
  file_generate: '文件生成', notification: '通知', exception: '异常处理', end: '结束'
}

export const FREQUENCY = { daily: '每天', weekly: '每周', monthly: '每月', occasional: '偶发' }
export const RISK = { low: '低', medium: '中', high: '高' }
export const REUSE = { low: '低', medium: '中', high: '高' }

export function safeParse(json, fallback) {
  if (json == null || json === '') return fallback
  if (typeof json === 'object') return json
  try { return JSON.parse(json) } catch (_) { return fallback }
}
