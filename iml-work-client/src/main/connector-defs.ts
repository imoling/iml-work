// ================= 服务连接器目录（声明式描述符设计）=================
//
// 「服务连接器」= 第三方 SaaS/API 集成（飞书消息、GitHub Issue、Jira 工单、群机器人、Webhook…），
// 与既有的「连接器动作」（企业自有 Web 系统的 replay/api/sop 动作，见 ontology-runtime）是两个概念：
// 前者对接**有公开 API 的服务**，后者对接**没有 API 的企业内部系统**。命名上用 saas 前缀区隔。
//
// 设计要点（业界同类连接器目录的通行做法）：
// · 声明式目录：每个连接器一个描述符（凭证字段/验证方式/说明），UI 与 IPC 都由数据驱动，零硬编码分支；
// · 一次性探活验证：保存凭证时真调一次目标 API，成功则带回身份标识（如 GitHub 登录名）；
// · 工具门控：只有「已启用且验证过」的连接器，其工具才注册进 AgentCore——目录即许可清单。
//
// 红线：凭证只存本地（config 键 saasConnectors，safeStorage 加密 + 按账号分库），绝不上传平台。
// 叶子纪律：纯数据 + 类型，零依赖（连 util 都不引），可被主进程任意模块 import。

/** 凭证/配置字段描述符（UI 表单与校验由它驱动）。 */
export interface ConnectorField {
  key: string
  label: string
  /** 密钥字段：UI 密码框显示、IPC 出站掩码、留空保存=保留旧值。 */
  secret?: boolean
  /** 默认必填；显式 false 才是可选。 */
  optional?: boolean
  placeholder?: string
  /** 字段下方的一行帮助文案。 */
  help?: string
}

/** 连接器描述符——目录里的一个条目。 */
export interface ConnectorDef {
  key: string
  name: string
  /** 认证方式标签（卡片右上角）。 */
  tag: string
  /** 一句话说明（卡片正文）。 */
  desc: string
  fields: ConnectorField[]
  /** 品牌色（渲染层图标底色；图标本体由渲染层按 key 映射）。 */
  brandColor: string
  platformUrl?: string
  platformName?: string
  docUrl?: string
  /** 「测试连接」会产生可见副作用时的提示（群机器人测试会真发一条测试消息）。 */
  testNotice?: string
  /** 该连接器暴露给分身的工具清单（展示用元数据；执行体在 connector-tools.ts）。 */
  tools: { name: string; label: string; op: 'read' | 'write' }[]
}

/** 连接器目录（声明式单一来源：主进程验证/工具与渲染层 UI 都从这里读）。 */
export const CONNECTOR_DEFS: ConnectorDef[] = [
  {
    key: 'feishu', name: '飞书', tag: '应用凭证', brandColor: '#3370FF',
    desc: '通过自建应用向同事/群组发送消息、查看机器人所在群列表。与远程机器人共用同一个应用（「IM 机器人」页一并配置）。',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxx' },
      { key: 'appSecret', label: 'App Secret', secret: true, placeholder: '输入 App Secret' },
    ],
    platformUrl: 'https://open.feishu.cn', platformName: '飞书开放平台',
    docUrl: 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process',
    tools: [
      { name: 'feishu_send_message', label: '发送飞书消息', op: 'write' },
      { name: 'feishu_list_chats', label: '查看机器人所在群', op: 'read' },
    ],
  },
  {
    key: 'dingtalk_bot', name: '钉钉群机器人', tag: 'Webhook', brandColor: '#3296FA',
    desc: '向指定钉钉群发送消息（群设置 → 智能群助手 → 自定义机器人，建议开启加签）。',
    fields: [
      { key: 'webhook', label: 'Webhook 地址', secret: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
      { key: 'signSecret', label: '加签密钥', secret: true, optional: true, placeholder: 'SEC 开头（安全设置选「加签」时必填）' },
    ],
    docUrl: 'https://open.dingtalk.com/document/orgapp/custom-robot-access',
    testNotice: '测试连接会向该群真实发送一条「连接测试」消息。',
    tools: [{ name: 'dingtalk_send_group', label: '发送钉钉群消息', op: 'write' }],
  },
  {
    key: 'wecom_bot', name: '企业微信群机器人', tag: 'Webhook', brandColor: '#07C160',
    desc: '向指定企业微信群发送消息（群设置 → 群机器人 → 添加）。',
    fields: [
      { key: 'webhook', label: 'Webhook 地址', secret: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
    ],
    docUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
    testNotice: '测试连接会向该群真实发送一条「连接测试」消息。',
    tools: [{ name: 'wecom_send_group', label: '发送企业微信群消息', op: 'write' }],
  },
  {
    key: 'github', name: 'GitHub', tag: '访问令牌', brandColor: '#24292F',
    desc: '查询与创建 Issue、追加评论。支持 GitHub 企业版（自定义 API 地址）。',
    fields: [
      { key: 'token', label: 'Personal Access Token', secret: true, placeholder: 'ghp_… / github_pat_…', help: '建议只授予 repo → issues 权限' },
      { key: 'apiBase', label: 'API 地址', optional: true, placeholder: '默认 https://api.github.com（企业版填 https://ghe.example.com/api/v3）' },
    ],
    platformUrl: 'https://github.com/settings/tokens', platformName: 'GitHub Token 设置',
    tools: [
      { name: 'github_list_issues', label: '查询 GitHub Issue', op: 'read' },
      { name: 'github_create_issue', label: '创建 GitHub Issue', op: 'write' },
      { name: 'github_comment_issue', label: '评论 GitHub Issue', op: 'write' },
    ],
  },
  {
    key: 'gitee', name: 'Gitee', tag: '访问令牌', brandColor: '#C71D23',
    desc: '查询与创建码云仓库的 Issue。',
    fields: [
      { key: 'token', label: '私人令牌', secret: true, placeholder: '在 设置 → 私人令牌 生成（勾选 issues）' },
    ],
    platformUrl: 'https://gitee.com/profile/personal_access_tokens', platformName: 'Gitee 私人令牌',
    tools: [
      { name: 'gitee_list_issues', label: '查询 Gitee Issue', op: 'read' },
      { name: 'gitee_create_issue', label: '创建 Gitee Issue', op: 'write' },
    ],
  },
  {
    key: 'jira', name: 'Jira', tag: '账号+令牌', brandColor: '#0052CC',
    desc: '按 JQL 查询工单、创建工单、追加评论。兼容 Jira Cloud 与 Server/Data Center。',
    fields: [
      { key: 'baseUrl', label: 'Jira 地址', placeholder: 'https://your-domain.atlassian.net 或私有部署地址' },
      { key: 'email', label: '账号（邮箱/用户名）', placeholder: 'Cloud 填邮箱；Server 填用户名' },
      { key: 'apiToken', label: 'API Token / 密码', secret: true, placeholder: 'Cloud 在 id.atlassian.com 生成 API Token' },
    ],
    platformUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens', platformName: 'Atlassian API Token',
    tools: [
      { name: 'jira_search', label: '查询 Jira 工单', op: 'read' },
      { name: 'jira_create_issue', label: '创建 Jira 工单', op: 'write' },
      { name: 'jira_comment', label: '评论 Jira 工单', op: 'write' },
    ],
  },
  {
    key: 'webhook', name: '通用 Webhook', tag: 'HTTP POST', brandColor: '#6366F1',
    desc: '把任务结果以 JSON POST 到你自己的接收端（自动化平台/自研服务/n8n 等）。',
    fields: [
      { key: 'url', label: '接收地址', secret: true, placeholder: 'https://…（将以 POST JSON 调用）' },
      { key: 'authHeader', label: 'Authorization 头', secret: true, optional: true, placeholder: '如 Bearer xxxxx（可选）' },
    ],
    testNotice: '测试连接会向该地址真实 POST 一条 {"type":"connection_test"} 消息。',
    tools: [{ name: 'webhook_post', label: '推送到 Webhook', op: 'write' }],
  },
]

export function connectorDefOf(key: string): ConnectorDef | undefined {
  return CONNECTOR_DEFS.find(d => d.key === key)
}

/** 必填字段是否全部有值（连接器「配置完整」的唯一判据）。 */
export function connectorFieldsComplete(def: ConnectorDef, values: Record<string, string>): boolean {
  return def.fields.filter(f => !f.optional).every(f => (values[f.key] || '').trim() !== '')
}
