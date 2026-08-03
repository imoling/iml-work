// 厂商预设与品牌图标：设置页（LlmTab）与多提供商管理（ProviderList）共用。
//
// 抽成独立模块是为了断循环依赖——ProviderList 要用 vendorLogo，而它本身被 LlmTab 渲染；
// 留在 LlmTab 里就是 A→B→A。顺带也让"加一个厂商预设"只需要改这一个文件。
import React from 'react'
import { Moon, Settings2, Sparkles } from 'lucide-react'

// 网络模型服务的厂商预设（选了自动带出接口地址 / 协议 / 默认模型）。
export interface VendorDef { key: string; name: string; baseUrl: string; apiMode: 'chat' | 'anthropic'; model: string; doc?: string }
export const NETWORK_VENDORS: VendorDef[] = [
  { key: 'agnes', name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiMode: 'chat', model: 'agnes-2.0-flash', doc: 'https://apihub.agnes-ai.com' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiMode: 'chat', model: 'deepseek-chat', doc: 'https://platform.deepseek.com' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiMode: 'chat', model: 'gpt-4o', doc: 'https://platform.openai.com/docs' },
  { key: 'anthropic', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', apiMode: 'anthropic', model: 'claude-3-5-sonnet-latest', doc: 'https://docs.anthropic.com' },
  { key: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiMode: 'chat', model: 'qwen-plus', doc: 'https://help.aliyun.com/zh/dashscope' },
  { key: 'moonshot', name: 'Moonshot · Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiMode: 'chat', model: 'moonshot-v1-8k', doc: 'https://platform.moonshot.cn' },
  { key: 'custom', name: '自定义 · OpenAI 兼容', baseUrl: '', apiMode: 'chat', model: '' },
]

// 本地模型服务的预设。
export const LOCAL_VENDORS: VendorDef[] = [
  { key: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiMode: 'chat', model: 'qwen2.5', doc: 'https://ollama.com' },
  { key: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiMode: 'chat', model: '', doc: 'https://lmstudio.ai' },
  { key: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', apiMode: 'chat', model: '', doc: 'https://docs.vllm.ai' },
  { key: 'custom', name: '自定义本地端点', baseUrl: 'http://localhost:11434/v1', apiMode: 'chat', model: '' },
]

// 厂商标识：品牌色圆角底 + 风格化字形（非官方 LOGO 精确复刻，仅作辨识）。
const VENDOR_BRAND: Record<string, { bg: string; node: React.ReactNode }> = {
  agnes: { bg: 'linear-gradient(135deg,#62E0B1,#37C98B)', node: <Sparkles size={16} color="#fff" /> },
  deepseek: { bg: '#4D6BFE', node: <span style={{ fontSize: 15 }}>🐳</span> },
  openai: {
    bg: '#0B0B0B', node: (
      <svg width="16" height="16" viewBox="0 0 24 24">
        {[0, 60, 120, 180, 240, 300].map(a => (
          <ellipse key={a} cx="12" cy="6.5" rx="2.1" ry="4.2" fill="#fff" transform={`rotate(${a} 12 12)`} />
        ))}
      </svg>
    )
  },
  anthropic: {
    bg: '#D97757', node: (
      <svg width="16" height="16" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" />
        <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /><line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
      </svg>
    )
  },
  qwen: { bg: '#615CED', node: <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>通</span> },
  moonshot: { bg: '#101426', node: <Moon size={15} color="#fff" /> },
  ollama: { bg: '#111111', node: <span style={{ fontSize: 15 }}>🦙</span> },
  lmstudio: { bg: '#4F46E5', node: <span style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>LM</span> },
  vllm: { bg: '#FF6B35', node: <span style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>vL</span> },
  custom: { bg: 'var(--bg-subtle)', node: <Settings2 size={15} color="var(--text-secondary)" /> },
}
export function vendorLogo(key: string): React.ReactNode {
  const b = VENDOR_BRAND[key] || VENDOR_BRAND.custom
  return <span className="vendor-logo" style={{ background: b.bg }}>{b.node}</span>
}

