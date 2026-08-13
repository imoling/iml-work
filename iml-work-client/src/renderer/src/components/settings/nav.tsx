import { User, Brain, FolderOpen, Info, Database, ShieldCheck, Mic, Plug, Server, MessagesSquare } from 'lucide-react'

// 设置导航的定义（App 侧栏与 SettingsPanel 共用）。
//
// 进入设置时，**左侧应用导航整体切换成这份设置导航**（顶部「← 返回应用」回去），
// 而不是在应用侧栏旁边再挂一列——两列并排的信息层级是乱的：用户分不清哪一列是"现在在哪"。
// 同一时刻侧栏只表达一件事：要么在用应用，要么在配置应用。

export type SettingsTab = 'profile' | 'llm' | 'robot' | 'folder' | 'voice' | 'sbx' | 'about' | 'memory' | 'systems' | 'connectors' | 'mcp'

export interface SettingsNavItem { key: SettingsTab; label: string; icon: React.ReactNode }

export const SETTINGS_GROUPS: { title: string; tabs: SettingsNavItem[] }[] = [
  {
    title: '我', tabs: [
      { key: 'profile', label: '账号与画像', icon: <User size={15} /> },
      { key: 'memory', label: '资料与记忆', icon: <Database size={15} /> },
    ]
  },
  {
    title: '分身能力', tabs: [
      { key: 'llm', label: '模型服务', icon: <Brain size={15} /> },
      { key: 'voice', label: '语音输入', icon: <Mic size={15} /> },
      { key: 'folder', label: '工作空间', icon: <FolderOpen size={15} /> },
    ]
  },
  {
    title: '连接与安全', tabs: [
      { key: 'systems', label: '企业系统连接', icon: <ShieldCheck size={15} /> },
      { key: 'robot', label: 'IM 机器人', icon: <MessagesSquare size={15} /> },
      { key: 'connectors', label: '服务连接器', icon: <Plug size={15} /> },
      { key: 'mcp', label: 'MCP 连接器', icon: <Server size={15} /> },
      { key: 'sbx', label: '安全沙箱', icon: <ShieldCheck size={15} /> },
    ]
  },
  { title: '其他', tabs: [{ key: 'about', label: '关于', icon: <Info size={15} /> }] },
]
