// 一级导航：按 FDE 交付工作流排序——连接系统 → 建模本体 → 构建技能 → 真跑测试。
// （旧「项目/场景/模板」流水线剧场已移除：无真实数据支撑，混淆实际用法。）
export const NAV = [
  { path: '/', label: '工作台', ic: 'dashboard', end: true },
  { path: '/connections', label: '① 系统连接', ic: 'link' },
  { path: '/ontology', label: '② 本体建模', ic: 'grid' },
  { path: '/quick', label: '③ 技能构建', ic: 'spark' },
  { path: '/create', label: '④ 指令创建', ic: 'package' },
  { path: '/test', label: '⑤ 技能测试', ic: 'check' }
]

export function safeParse(json, fallback) {
  if (json == null || json === '') return fallback
  if (typeof json === 'object') return json
  try { return JSON.parse(json) } catch (_) { return fallback }
}
