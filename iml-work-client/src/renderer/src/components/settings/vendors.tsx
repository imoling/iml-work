// 厂商预设与品牌图标：设置页（LlmTab）与多提供商管理（ProviderList）共用。
//
// 抽成独立模块是为了断循环依赖——ProviderList 要用 vendorLogo，而它本身被 LlmTab 渲染；
// 留在 LlmTab 里就是 A→B→A。顺带也让"加一个厂商预设"只需要改这一个文件。
import React from 'react'
import { BRAND_ICONS } from './brand-icons'

// 网络模型服务的厂商预设（选了自动带出接口地址 / 协议 / 默认模型）。
export interface VendorDef { key: string; name: string; baseUrl: string; apiMode: 'chat' | 'anthropic'; model: string; doc?: string }
export const NETWORK_VENDORS: VendorDef[] = [
  // Agnes 分中国站(.cn)与国际站(.com)：接口域名不同、密钥不通用，模型命名一致（agnes-2.0-flash 系）。
  { key: 'agnes-cn', name: 'Agnes 中国站', baseUrl: 'https://api.agnes-ai.cn/v1', apiMode: 'chat', model: 'agnes-2.0-flash', doc: 'https://www.agnes-ai.cn/zh-Hans/docs/overview' },
  { key: 'agnes', name: 'Agnes 国际站', baseUrl: 'https://apihub.agnes-ai.com/v1', apiMode: 'chat', model: 'agnes-2.0-flash', doc: 'https://apihub.agnes-ai.com' },
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
/**
 * 厂商标记：有官方 SVG 的用官方（BRAND_ICONS），没有的用字母标。
 *
 * 原来是 emoji 与通用图标拼的（🦙 当 Ollama、十字星当 Anthropic、月亮当 Moonshot），
 * 一眼就看得出不是真 logo。现在换成各家官方路径。
 *
 * OpenAI 用字母标：simple-icons 应品牌方要求下架了它的标记，凭记忆临摹只会画歪——
 * 一个不准的 logo 比一个规规矩矩的字母标更糟。
 */
const LETTER_MARK: Record<string, { bg: string; text: string; size?: number; badge?: string }> = {
  openai: { bg: '#000000', text: 'AI' },
  // 中国站与国际站同一品牌色，用角标区分（badge 渲染见 vendorLogo）
  agnes: { bg: '#10B981', text: 'A' },
  'agnes-cn': { bg: '#10B981', text: 'A', badge: 'CN' },
  custom: { bg: 'var(--bg-subtle)', text: '·' },
}

export function vendorLogo(key: string): React.ReactNode {
  const icon = BRAND_ICONS[key]
  if (icon) {
    // 深色品牌色直接用；白字标在品牌底色上，与其余卡片一致
    return (
      <span className="vendor-logo" style={{ background: icon.hex }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <path d={icon.path} />
        </svg>
      </span>
    )
  }
  const m = LETTER_MARK[key] || LETTER_MARK.custom
  const light = m.bg.startsWith('var(')
  return (
    <span className="vendor-logo" style={{ background: m.bg, position: 'relative' }}>
      <span style={{ fontSize: m.text.length > 1 ? 11 : 13, fontWeight: 800, color: light ? 'var(--text-secondary)' : '#fff', letterSpacing: '.02em' }}>
        {m.text}
      </span>
      {m.badge && (
        <span style={{ position: 'absolute', right: -3, bottom: -3, background: '#DC2626', color: '#fff', fontSize: 7, fontWeight: 800, lineHeight: 1, padding: '2px 3px', borderRadius: 4 }}>
          {m.badge}
        </span>
      )}
    </span>
  )
}

