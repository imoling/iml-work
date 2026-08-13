// ================= 服务连接器 → AgentCore 工具组装 =================
//
// 门控思想：**目录即许可清单**——只有「已启用且必填字段齐全」的连接器，
// 其工具才进注册表；一个连接器都没配时返回空数组，模型根本看不见这些工具。
//
// 风险档（写保护唯一判据，见 tool-registry.ToolMetadata.risk）：
// · 查询类（list/search）→ low，自动放行、可并发；
// · 外发类（发消息/建 Issue/推 Webhook）→ write，内核权限闸弹确认卡 + 一次性签名令牌，
//   只读档硬拒、无人值守跳过——全部由 permission-gate 统一执行，这里只声明。
import type { ToolSpec } from './tool-registry'
import {
  connectedConnectors,
  feishuSendMessage, feishuListChats,
  dingtalkSendGroup, wecomSendGroup,
  githubListIssues, githubCreateIssue, githubCommentIssue,
  giteeListIssues, giteeCreateIssue,
  jiraSearch, jiraCreateIssue, jiraComment,
  webhookPost,
} from './connector-runtime'
import { swallow } from './util'

type Vals = Record<string, string>
const str = (v: unknown) => String(v ?? '').trim()
/** 恒等标注：让数组里每个工具对象各自按 ToolSpec 检查（数组字面量合并成 union 会把空 properties 判错）。 */
const spec = (s: ToolSpec): ToolSpec => s

/** 每个连接器的工具工厂：key → 该连接器贡献的 ToolSpec[]（values 为已保存凭证）。 */
const TOOL_FACTORIES: Record<string, (values: Vals) => ToolSpec[]> = {
  feishu: (values) => [
    spec({
      name: 'feishu_send_message',
      description: '通过飞书把一段文字消息发给指定的人或群。receiver 支持：同事邮箱、open_id（ou_ 开头）、群 chat_id（oc_ 开头）。要发到群但不知道 chat_id 时，先调 feishu_list_chats 查。仅在用户明确要求「发飞书/通知某人」时使用，不要主动外发。',
      parameters: {
        type: 'object',
        properties: {
          receiver: { type: 'string', description: '接收者：邮箱 / open_id / 群 chat_id' },
          text: { type: 'string', description: '要发送的消息正文（纯文本）' },
        },
        required: ['receiver', 'text'],
      },
      metadata: { label: '发送飞书消息', risk: 'write', category: 'connector' },
      run: async (args) => feishuSendMessage(values, str(args.receiver), str(args.text)),
    }),
    spec({
      name: 'feishu_list_chats',
      description: '列出飞书机器人所在的群（群名 + chat_id）。发群消息前用它拿 chat_id。',
      parameters: { type: 'object', properties: {}, required: [] },
      metadata: { label: '查看飞书群列表', risk: 'low', category: 'connector' },
      run: async () => feishuListChats(values),
    }),
  ],
  dingtalk_bot: (values) => [
    spec({
      name: 'dingtalk_send_group',
      description: '向已配置的钉钉群发送一条文字消息（自定义群机器人 Webhook）。仅在用户明确要求「发到钉钉群/通知群里」时使用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要发送的消息正文（纯文本）' } },
        required: ['text'],
      },
      metadata: { label: '发送钉钉群消息', risk: 'write', category: 'connector' },
      run: async (args) => dingtalkSendGroup(values, str(args.text)),
    }),
  ],
  wecom_bot: (values) => [
    spec({
      name: 'wecom_send_group',
      description: '向已配置的企业微信群发送一条文字消息（群机器人 Webhook）。仅在用户明确要求「发到企微群/通知群里」时使用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要发送的消息正文（纯文本）' } },
        required: ['text'],
      },
      metadata: { label: '发送企业微信群消息', risk: 'write', category: 'connector' },
      run: async (args) => wecomSendGroup(values, str(args.text)),
    }),
  ],
  github: (values) => [
    spec({
      name: 'github_list_issues',
      description: '查询 GitHub 仓库的 Issue 列表（编号/状态/标题/作者）。repo 格式 owner/repo。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，格式 owner/repo' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态过滤，默认 open' },
        },
        required: ['repo'],
      },
      metadata: { label: '查询 GitHub Issue', risk: 'low', category: 'connector' },
      run: async (args) => githubListIssues(values, str(args.repo), str(args.state) || 'open'),
    }),
    spec({
      name: 'github_create_issue',
      description: '在 GitHub 仓库创建一个新 Issue。仅在用户明确要求提 Issue 时使用。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，格式 owner/repo' },
          title: { type: 'string', description: 'Issue 标题' },
          body: { type: 'string', description: 'Issue 正文（Markdown，可选）' },
        },
        required: ['repo', 'title'],
      },
      metadata: { label: '创建 GitHub Issue', risk: 'write', category: 'connector' },
      run: async (args) => githubCreateIssue(values, str(args.repo), str(args.title), str(args.body) || undefined),
    }),
    spec({
      name: 'github_comment_issue',
      description: '在 GitHub 仓库的指定 Issue 下追加一条评论。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，格式 owner/repo' },
          number: { type: 'number', description: 'Issue 编号' },
          body: { type: 'string', description: '评论内容（Markdown）' },
        },
        required: ['repo', 'number', 'body'],
      },
      metadata: { label: '评论 GitHub Issue', risk: 'write', category: 'connector' },
      run: async (args) => githubCommentIssue(values, str(args.repo), Number(args.number) || 0, str(args.body)),
    }),
  ],
  gitee: (values) => [
    spec({
      name: 'gitee_list_issues',
      description: '查询 Gitee（码云）仓库的 Issue 列表。repo 格式 owner/repo。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，格式 owner/repo' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态过滤，默认 open' },
        },
        required: ['repo'],
      },
      metadata: { label: '查询 Gitee Issue', risk: 'low', category: 'connector' },
      run: async (args) => giteeListIssues(values, str(args.repo), str(args.state) || 'open'),
    }),
    spec({
      name: 'gitee_create_issue',
      description: '在 Gitee（码云）仓库创建一个新 Issue。仅在用户明确要求提 Issue 时使用。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，格式 owner/repo' },
          title: { type: 'string', description: 'Issue 标题' },
          body: { type: 'string', description: 'Issue 正文（可选）' },
        },
        required: ['repo', 'title'],
      },
      metadata: { label: '创建 Gitee Issue', risk: 'write', category: 'connector' },
      run: async (args) => giteeCreateIssue(values, str(args.repo), str(args.title), str(args.body) || undefined),
    }),
  ],
  jira: (values) => [
    spec({
      name: 'jira_search',
      description: '按 JQL 查询 Jira 工单（键/状态/标题/负责人）。例：project = OPS AND status = "In Progress" ORDER BY updated DESC。用户口语化的问法（"我手上的工单"）要先翻成 JQL（assignee = currentUser() AND resolution = Unresolved）。',
      parameters: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL 查询语句' },
          max: { type: 'number', description: '最多返回条数，默认 10，上限 20' },
        },
        required: ['jql'],
      },
      metadata: { label: '查询 Jira 工单', risk: 'low', category: 'connector' },
      run: async (args) => jiraSearch(values, str(args.jql), Number(args.max) || 10),
    }),
    spec({
      name: 'jira_create_issue',
      description: '在 Jira 指定项目创建工单。仅在用户明确要求建单时使用。',
      parameters: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: '项目键（如 OPS）' },
          summary: { type: 'string', description: '工单标题' },
          description: { type: 'string', description: '工单描述（可选）' },
          issueType: { type: 'string', description: '工单类型名，默认 Task（中文环境可能是「任务」）' },
        },
        required: ['projectKey', 'summary'],
      },
      metadata: { label: '创建 Jira 工单', risk: 'write', category: 'connector' },
      run: async (args) => jiraCreateIssue(values, str(args.projectKey), str(args.summary), str(args.description) || undefined, str(args.issueType) || 'Task'),
    }),
    spec({
      name: 'jira_comment',
      description: '在指定 Jira 工单下追加一条评论。issueKey 形如 OPS-123。',
      parameters: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: '工单键，如 OPS-123' },
          body: { type: 'string', description: '评论内容' },
        },
        required: ['issueKey', 'body'],
      },
      metadata: { label: '评论 Jira 工单', risk: 'write', category: 'connector' },
      run: async (args) => jiraComment(values, str(args.issueKey), str(args.body)),
    }),
  ],
  webhook: (values) => [
    spec({
      name: 'webhook_post',
      description: '把结构化结果以 JSON POST 到用户配置的 Webhook 接收端。payload 传对象（会原样序列化）。仅在用户明确要求「推送/发到我的接口」时使用。',
      parameters: {
        type: 'object',
        properties: {
          payload: { type: 'object', description: '要推送的 JSON 对象（如 {"title":"…","content":"…"}）' },
        },
        required: ['payload'],
      },
      metadata: { label: '推送到 Webhook', risk: 'write', category: 'connector' },
      run: async (args) => webhookPost(values, args.payload ?? {}),
    }),
  ],
}

/**
 * 本轮要注册的连接器工具（门控后的结果）。任何一个连接器读配置失败都不拖垮整轮——
 * 跳过它并留痕，其余连接器照常提供。
 */
export function connectorToolSpecs(): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const { def, saved } of connectedConnectors()) {
    const factory = TOOL_FACTORIES[def.key]
    if (!factory) continue
    try { specs.push(...factory(saved.values)) } catch (e) { swallow(e, `connector-tools-${def.key}`) }
  }
  return specs
}
