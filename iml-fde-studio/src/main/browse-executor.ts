// 统一 browse 执行器：企业系统操作的**主引擎**。
//
// 定位（2026-07-20 改造）：把「录制回放（replayActionScript）/ SOP 智能体（runSopAgent）」两套执行器
// 收敛到一条 browse 主链路——分身用 browse 工具读实时页面、语义定位、多步自适应把事办成。
// · 登录态复用：按**连接器动作绑定的系统 id** 走 `persist:bizsys-<systemId>` 分区（「设置→企业系统连接」里的
//   受管登录态）——凭证只在本地、绝不上传，也不必对话传密码（安全红线）。
// · 录制步骤 / SOP 文案降为**提示（hint）**拼进任务：提效增准但不绑死，页面结构/标签一变 agent 能自适应
//   （对比录制回放依赖标签、页面一变就废）。
// · 写操作安全红线不变：确认闸 + 一次性签名令牌仍由调用方（本体钩子 / 连接器动作执行）在调用**前**完成，
//   本执行器只负责「已确认后如何在页面上把事办成」。
//
// 叶子模块：只 import agent-browse / agent-loop / util / types（llm 仅 type-only），绝不 import main / ontology / skill-*
// （被 ontology-runtime、agent-ontology、skill-custom 复用，反向依赖会成环）。
// 模型调用由**调用方传入** callModel（生产传 callLlm，真机 bench 传直连网关的桩）——与 agent-loop 同款叶子纪律，
// 使本模块不静态依赖 llm.ts（llm→db→app.getPath 会污染纯 harness）。
import { makeBrowseTool } from './agent-browse'
import type { WriteConfirm } from './agent-browse'
import { runAgentLoop } from './agent-loop'
import { swallow } from './util'
import type { LlmConfig } from './llm'
import type { SendLog, RecStep } from './types'

/** 模型调用签名（与 runAgentLoop.callModel 同）——生产传 callLlm，单测/真机 bench 传 mock/直连网关桩。 */
export type CallModel = (prompt: string, cfg: LlmConfig, opts?: { temperature?: number; longRunning?: boolean }) => Promise<string>

export interface BrowseExecResult {
  ok: boolean          // 任务办成（模型主动 finish；步数耗尽被迫收尾算未办成）
  loggedIn: boolean    // 是否已登录该系统（false 时调用方沿用既有「请先到设置→企业系统连接登录」提示）
  outcome: string      // 人话结论（模型最终答案），或未登录/出错的说明
  steps: number        // agent 实际步数
  failLabel?: string   // 未办成时的简述（供审计/回复）
  pageText?: string    // 只读模式：agent 最后一次 read 读到的**目标页真实正文**——交调用方按 SOP 严格整理（绝不编造，护栏不弱化）
}

// 登录页特征：正文极短 + 含登录/账号/密码类字样（与 runSopAgent 同款启发式，保持行为一致）。
const LOGIN_RE = /(登录|登陆|login|sign in|账号|帐号|密码|password)/i

/**
 * 把录制步骤渲染成**人话操作提示**（browse 主引擎的 hint）。
 * 一切以页面实际渲染为准、不绑死——所以只保留「做什么」的语义，丢弃 selector/fp 等易失效的机械定位。
 * fill 类优先用确认后的字段值（fieldValues[fieldName]），其次录制原值。
 */
export function renderStepsHint(steps: RecStep[], fieldValues?: Record<string, string>): string {
  if (!steps || !steps.length) return ''
  const lines: string[] = []
  steps.forEach((s) => {
    const act = (s.action || '').toLowerCase()
    const label = (s.label || '').trim()
    const fv = ((s.fieldName && fieldValues && fieldValues[s.fieldName]) || s.value || '').trim()
    let line = ''
    if (/fill|search|input|type/.test(act)) line = `在「${label || '对应输入框'}」填入${fv ? `：${fv}` : '对应的值'}`
    else if (/select|pickoption|choose|searchselect/.test(act)) line = `在「${label || '对应控件'}」选择${fv ? `：${fv}` : '对应选项'}`
    else if (/click|tap/.test(act)) line = `点击「${label || '目标按钮/链接'}」`
    else if (act === 'upload') line = `在「${label || '上传控件'}」上传文件`
    else if (act === 'hover') line = `悬停展开「${label || '菜单入口'}」`
    else if (act === 'agent') line = label || s.value || '按意图完成这一步'
    else if (label) line = `${act || '操作'}「${label}」`
    // 录制选择器（B 路线：确定性直达）：agent 对检索/拾取类控件可把 [sel=…] 原样传给 browse 的 sel 参数精确定位
    const selHint = s.selector && (act === 'click' || /fill|search/.test(act)) ? ` [sel=${String(s.selector).slice(0, 80)}]` : ''
    if (line) lines.push(`${lines.length + 1}. ${line}${selHint}`)
  })
  return lines.join('\n')
}

export interface BrowseExecOpts {
  systemId: string                       // → 登录态分区 persist:bizsys-<systemId>
  systemName: string
  entryUrl: string                       // 入口页（审批类=对象详情页；create 类=功能页/系统首页）
  task: string                           // 人话目标（把这件事办成）
  hint?: string                          // 录制步骤/SOP 渲染出的操作提示（可空）
  fieldValues?: Record<string, string>   // 确认后的待写入字段值（只用这些，勿臆造）
  cfg: LlmConfig
  callModel: CallModel                    // 模型调用（生产 callLlm；真机 bench 直连网关桩）
  sendLog: SendLog
  maxSteps?: number
  budgetMs?: number
  onWriteConfirm?: WriteConfirm          // 写前签字钩子（写入类技能传入：点提交/同意/删除前读单据给用户签字）
  visible?: boolean                      // 可视化执行窗：用户亲眼看 agent 操作（调试/信任）；默认离屏
  readonly?: boolean                     // 只读模式（读取/查询类技能）：导航到目标页 + read 读真实正文，绝不写入；结果 pageText 回传
}

/**
 * 运行 browse 主引擎把一件企业系统操作办成。
 * 流程：① 用绑定系统的登录态分区开离屏浏览器 → ② 预检登录态（落在登录页直接回 loggedIn:false）→
 * ③ 拼「目标 + 字段值 + 录制/SOP 提示」为任务，交 runAgentLoop 驱动 browse 多步自适应执行 →
 * ④ 归一化返回（runAgentLoop 的 finally 已统一 cleanup 关窗，不泄漏离屏窗口）。
 */
export async function runBrowseExecutor(o: BrowseExecOpts): Promise<BrowseExecResult> {
  const tool = makeBrowseTool({ partition: `persist:bizsys-${o.systemId}`, onWriteConfirm: o.onWriteConfirm, visible: o.visible })
  try {
    // ① 预检登录态：先导航到入口读一眼正文。落在登录页 → 直接回 loggedIn:false（保留调用方既有「请先登录」提示）。
    //    复用同一个持久离屏窗口（makeBrowseTool 的 window 跨 run 复用），预检后无缝交给 agent 循环，不重复开窗。
    if (o.entryUrl) {
      try {
        const landing = await tool.run({ action: 'goto', url: o.entryUrl }, o.sendLog)   // observe 文本：【当前页】title | url
        const landedUrl = (/\|\s*(https?:\/\/[^\s]+)/.exec(landing || '') || [])[1] || ''
        const read = await tool.run({ action: 'read' }, o.sendLog)
        const body = (read || '').replace(/^【页面正文】\s*/, '')
        // 未登录判定：① **落地 URL 仍停在登录/SSO/认证页**——登录态有效时 SSO 会重定向离开登录页（讯飞 sso/login → 门户 in.iflytek.com），
        //            失效则停在 login/sso/passport/cas；② 或正文短 + 登录字样。比单纯"正文<400"更可靠（SSO 登录页正文常超 400 字会漏判）。
        const onLoginUrl = /\/(sso\/)?login|signin|passport|casLogin|authserver|\/cas\b|\/auth\//i.test(landedUrl)
        const shortLogin = body.length < 500 && LOGIN_RE.test(body)
        if (onLoginUrl || shortLogin) {
          await tool.cleanup?.()
          return { ok: false, loggedIn: false, outcome: `尚未登录【${o.systemName}】`, steps: 0, failLabel: '未登录' }
        }
      } catch (e) { swallow(e, 'browse-exec-preflight') }
    }

    const fieldsBlock = o.fieldValues && Object.keys(o.fieldValues).length
      ? `\n【待写入/使用的字段值（只用这里给的，勿臆造）】\n${Object.entries(o.fieldValues).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n`
      : ''
    const hintBlock = o.hint && o.hint.trim()
      ? `\n【参考操作流程（录制/SOP，只示意"操作步骤 / 字段位置"，作指引提效）——⚠️ 流程里出现的具体业务值（人名 / 日期 / 类型 / 单号 / 金额 / 审批人等）多是**录制当时的旧样例**，**一律以上面【需求】/【字段值】里给的为准**；只有需求完全没提到的字段，才沿用流程里的值。一切以页面实际渲染为准，页面变了以你 observe 到的为准】\n${o.hint.trim()}\n`
      : ''
    const task = o.readonly
      ? `你是企业员工的工作分身，请在企业系统里**读取/查询**下面这件事需要的真实信息（**只读**：绝不点提交/保存/确定/删除等任何写按钮，不做任何改动）：
【需求】${o.task}
【目标系统】${o.systemName}，入口 ${o.entryUrl}（你已登录该系统，无需再登录）。${hintBlock}
用 browse 工具：先 goto ${o.entryUrl} 进入，observe/inspect 看清导航，按需求导航到**目标列表/详情页**；到达目标页后**必须用 read 把该页面真实正文读出来**（这一步关键，不能省），确认读到目标内容后再 finish。答案里如实转述读到的真实内容（如列表逐条列出可见字段），绝不编造任何数据。`
      : `你是企业员工的工作分身，请在企业系统里把下面这件事**办成**：
【需求】${o.task}
【目标系统】${o.systemName}，入口 ${o.entryUrl}（你已登录该系统，无需再登录）。${fieldsBlock}${hintBlock}
用 browse 工具：先 goto ${o.entryUrl} 进入，observe 看清导航/元素，导航到对应功能页，**严格按【需求】/【字段值】给的值填写每个字段**（人名 / 日期 / 类型 / 原因 / 审批人等——需选人或选下拉的用 select/search 现场按名把需求里的值选中，**绝不照搬参考流程里录制时的旧值**）；需求没提到的字段才沿用流程默认。每一步都依据上一步 observe 到的元素文本来操作，办完确认页面确实已生效后再 finish。`

    const res = await runAgentLoop({
      task, tools: [tool], cfg: o.cfg, sendLog: o.sendLog, callModel: o.callModel,
      maxSteps: o.maxSteps ?? 18, budgetMs: o.budgetMs ?? 220000,
    })
    // ⚠️ runAgentLoop 的 finally 已 cleanup(tool) 关窗——此后不可再用 tool。
    // 只读模式：从 agent 步骤里取**最后一次 read 的目标页真实正文**回传（供调用方按 SOP 严格整理，绝不编造）。
    const lastRead = [...res.steps].reverse().find(s => s.tool === 'browse' && String((s.args as Record<string, unknown> | undefined)?.action || '').toLowerCase() === 'read')
    const pageText = (lastRead?.observation || '').replace(/^【页面正文】\s*/, '').trim()
    return {
      ok: res.finished,
      loggedIn: true,
      outcome: res.answer || '（无产出）',
      steps: res.steps.length,
      failLabel: res.finished ? undefined : '多步未办成/步数耗尽',
      pageText,
    }
  } catch (e: any) {
    try { await tool.cleanup?.() } catch (e2) { swallow(e2, 'browse-exec-cleanup') }
    return { ok: false, loggedIn: true, outcome: `browse 执行出错：${e?.message || e}`, steps: 0, failLabel: e?.message || 'error' }
  }
}
