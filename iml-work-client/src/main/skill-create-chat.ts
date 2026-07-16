// 会话内创建技能：对话里说「创建一个…技能」→ 后端 skill-creator 引擎（追问经表单卡确认）
// → 终确认 → 私有落库 + 本地即刻生效。与技能页「创建技能」共用同一后端引擎，
// 本模块只做会话侧编排（意图识别 → 追问表单 → 终确认 → 保存），不 import main.ts。
import { configGet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { writeSkillFile, loadLocalSkills, rememberUserSkill } from './skill-store'
import { requestFormConfirmation, type FormField } from './automation-runtime'
import { swallow } from './util'
import { type SendLog } from './types'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'
import { isSkillCreateIntent } from './skill-router-core'

function myPerms(): string[] {
  try {
    const u = JSON.parse(configGet('auth-user') || '{}')
    return Array.isArray(u.permissions) ? u.permissions : []
  } catch (e) { swallow(e, 'skill-create-perms'); return [] }
}

async function post(pathname: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await afetch(`${getAdminBaseUrl()}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), timeoutMs
  })
  const d: any = await res.json().catch(() => null)
  if (!res.ok) throw new Error((d && d.error) || `HTTP ${res.status}`)
  return d
}

/** 「创建技能」意图短路：命中返回结果，未命中返回 null（继续走常规技能路由）。 */
export async function runSkillCreate(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  if (!isSkillCreateIntent(data.content)) return null
  const ps = myPerms()
  if (!(ps.includes('*') || ps.includes('client.skill.create'))) {
    return {
      content: '识别到你想创建技能，但当前账号没有「创建技能」权限。请联系管理员在「用户与权限」里为你的角色勾选「客户端-创建技能」。',
      success: true, traceId: trace.id
    }
  }
  sendLog('thinking', '识别为「创建技能」请求，正在按 skill-creator 方法论分析…')
  try {
    let d = await post('/api/v1/skills/creator/draft', { instruction: data.content }, 200_000)

    // 关键信息缺口 → 追问经表单卡（选项下拉，可改填自定义值），用户取消即终止
    if (Array.isArray(d.questions) && d.questions.length) {
      sendLog('acting', '还差几个关键信息，请在下方表单里选择或填写…')
      const fields: FormField[] = d.questions.map((q: any) => ({
        name: String(q.id), label: String(q.question),
        value: String((q.options || [])[0] || ''), type: 'text',
        options: Array.isArray(q.options) ? q.options.map(String) : undefined
      }))
      const submitted = await requestFormConfirmation(fields)
      if (!submitted || !Object.keys(submitted).length) {
        return { content: '已取消创建技能。', success: true, traceId: trace.id }
      }
      const answers: Record<string, string> = {}
      for (const q of d.questions) {
        const v = submitted[String(q.id)]
        if (v) answers[String(q.question)] = String(v)   // 用题面做键，模型读回答时语境完整
      }
      sendLog('acting', '按你的选择继续生成技能草稿…')
      d = await post('/api/v1/skills/creator/draft', { instruction: data.content, answers }, 200_000)
    }

    const dr = d.draft
    if (!dr) return { content: '技能草稿生成失败，请把格式/规则再写细一点后重试。', success: false, traceId: trace.id }
    const kws = (dr.triggerKeywords || []).join('、')
    sendLog('observing', `草稿就绪：「${dr.name}」（触发词：${kws}）`)

    // 终确认：写库前人工确认（红线），表单卡展示关键面并让用户拍板
    const ok = await requestFormConfirmation([
      { name: 'name', label: '技能名称', value: String(dr.name || ''), type: 'text' },
      { name: 'kws', label: '触发词', value: kws, type: 'text' },
      { name: 'confirm', label: '确认创建为我的私有技能？', value: '创建', type: 'text', options: ['创建', '取消'] }
    ])
    if (!ok || !Object.keys(ok).length || ok.confirm === '取消') {
      await trace.submit(data.content, 'PARTIAL', '会话内创建技能：草稿已生成，用户在终确认取消。')
      return { content: '已取消创建技能。', success: true, traceId: trace.id }
    }
    if (ok.name && String(ok.name).trim()) dr.name = String(ok.name).trim()   // 终确认里可顺手改名

    const saved = await post('/api/v1/skills/creator/save', { draft: dr }, 60_000)
    writeSkillFile(saved)
    rememberUserSkill(String(saved.id))
    loadLocalSkills()
    await trace.submit(data.content, 'SUCCESS', `会话内创建私有技能「${saved.name}」（${saved.id}），触发词：${kws}。`)
    sendLog('completed', `[Completed] 技能「${saved.name}」已创建并生效。`)
    const example = (dr.triggerKeywords || [])[0]
    return {
      content: `✅ 已创建你的私有技能「${saved.name}」（${dr.type === 'python-sandbox' ? 'Python 数据处理' : '知识/指南'}型）。\n\n` +
        `触发词：${kws}\n\n直接在对话里说出需求即可使用${example ? `（例如"${example}"）` : ''}；「技能」页的我的技能区可查看。`,
      success: true, traceId: trace.id
    }
  } catch (err: any) {
    swallow(err, 'skill-create-chat')
    await trace.submit(data.content, 'FAILED', `会话内创建技能失败：${err?.message || err}`)
    return { content: `创建技能失败：${err?.message || String(err)}`, success: false, traceId: trace.id }
  }
}
