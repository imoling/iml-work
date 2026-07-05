import { FileText, Globe, Cpu, Boxes, BookOpen } from 'lucide-react'

// 技能引擎类型 → 用户可读标签/图标 的单一来源（技能页 / 资料与记忆 / 会话技能弹层共用）。
// type 是 python-sandbox / playwright 等技术名，界面上一律展示友好标签。
export const SKILL_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  'python-sandbox': { label: '文档生成 · 安全沙箱', icon: <FileText size={18} /> },
  'playwright': { label: '浏览器自动化', icon: <Globe size={18} /> },
  'nut-js': { label: '桌面自动化', icon: <Cpu size={18} /> },
  'onnx-bge': { label: '知识推理', icon: <Boxes size={18} /> },
  'knowledge': { label: '知识指南', icon: <BookOpen size={18} /> },
}

export function skillTypeLabel(type?: string): string {
  return (type && SKILL_TYPE_META[type]?.label) || '自定义技能'
}
