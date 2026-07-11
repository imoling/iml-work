// 本体钩子：agent:send-message 的第一道编排——先把指令解析为「对象+动作」，
// 命中则走语义执行（策略闸→确认→真实读取/回放→事件回写），返回统一结果；未命中返回 null 让主链路继续。
// 纯搬迁自 main.ts。真实读取/回放驱动业务系统，冷启动冒烟测不到，正确性需真实技能跑一遍验证。
import { resolveOntology, recordObjectRef, ontologyNeedsConfirm, buildOntologyGraphText, resolveSystemBaseUrl, browseAndExtractLinks, matchOntologyCandidates, recordBusinessEvent, loadExecutorSteps, executeOntologyConnectorAction, callSystemApi } from './ontology-runtime'
import { replayActionScript, runSopAgent } from './browser-automation'
import { requestFormConfirmation, requestPermissionChoice, runningState } from './automation-runtime'
import { afetch, getAdminBaseUrl } from './http'
import { swallow } from './util'
import type { SendLog, VisitField } from './types'
import type { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'

// 从候选行文本里解析金额（元）。支持 "6000万"/"6,000万"/"60,000,000元"/"60000000"。
// 解析不出返回 null——批量自动审批时「读不到金额」的一律不批（保守、不虚构）。
function parseAmountFromText(text: string): number | null {
  const s = (text || '').replace(/\s/g, '')
  const wan = s.match(/([\d,，.]+)\s*万/)
  if (wan) { const n = Number(wan[1].replace(/[,，]/g, '')); if (!isNaN(n) && n > 0) return Math.round(n * 10000) }
  const yuan = s.match(/([\d,，]{4,})\s*元?/)
  if (yuan) { const n = Number(yuan[1].replace(/[,，]/g, '')); if (!isNaN(n) && n >= 1000) return n }
  return null
}
const fmtYuan = (n: number) => n.toLocaleString('en-US') + '元'

// 岗位业务域侧重（管理端「岗位专家 · 业务域侧重」配置）：本体解析优先在侧重域内匹配。60s 缓存。
let expertDomainsCache: { id: string; domains: string[]; at: number } | null = null
async function getExpertOntologyDomains(expertId: string): Promise<string[]> {
  if (!expertId) return []
  if (expertDomainsCache && expertDomainsCache.id === expertId && Date.now() - expertDomainsCache.at < 60000) return expertDomainsCache.domains
  let domains: string[] = []
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (r.ok) { const e: any = await r.json(); if (Array.isArray(e.ontologyDomains)) domains = e.ontologyDomains.filter((d: any) => typeof d === 'string' && d) }
  } catch (e) { swallow(e, 'expert-domains') }
  expertDomainsCache = { id: expertId, domains, at: Date.now() }
  return domains
}

// 命中并处理 → 返回 AgentResult(早返回);未命中/用户锁定了技能 → 返回 null,主链路继续。
// opts.noPermGate：编排调用时置 true——编排自己的前置权限闸已问过「继续/切档」，此处不再二次弹卡。
export async function runOntologyHook(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, opts?: { noPermGate?: boolean }): Promise<AgentResult | null> {
  if (data.forcedSkillId) return null
    try {
      const expertDomains = await getExpertOntologyDomains(data.expertId || '')
      const onto = await resolveOntology(data.content, data.llmConfig, expertDomains)
      if (onto.res.matched && onto.action) {
        const a = onto.action, t = onto.type, r = onto.res
        const sys = t?.boundSystemId || ''
        const policy = a.policyJson ? JSON.parse(a.policyJson) : {}
        const eventType = policy.eventType || 'StateChanged'
        const isWrite = a.capability && a.capability !== 'read'
        const sm = t?.stateMachineJson ? JSON.parse(t.stateMachineJson) : null
        const toState = a.toState || (sm ? sm.initial : '') || ''
        sendLog('thinking', `识别到业务对象「${r.displayName || r.objectType}」，目标动作「${a.label}」`)
        trace.spans.push({ type: 'ontology', name: `对象解析·${r.objectType}`, status: 'ok' })
        trace.spans.push({ type: 'ontology', name: `动作·${a.label}(${a.fromState || '*'}→${a.toState || '-'})`, status: 'ok' })

        // 只读模式拦截写操作：与编排的前置权限闸同款「继续 / 切到允许操作并重跑」两选一卡（编排调用时由其前置闸代问，不二次弹）
        if (isWrite && data.permMode === 'readonly') {
          if (opts?.noPermGate) {
            const content = `🔒 本次为**只读模式**。已识别为对象动作「${a.label}」（${r.objectType}，写操作），未做任何改动。\n\n如需执行，请把「权限范围」切到 **允许操作** 后重试（写操作仍会请你人工确认）。`
            await trace.submit(content, 'BLOCKED', `只读模式拦截本体写动作 ${r.objectType}.${a.actionKey}。`)
            return { content, success: true, traceId: trace.id }
          }
          sendLog('acting', `检测到写操作（${a.label}），当前为只读——请先选择如何处理…`)
          const choice = await requestPermissionChoice([`${a.label}（${r.objectType}）`])
          if (choice === 'switch') {
            await trace.submit('用户选择切到「允许操作」后重跑本任务。', 'BLOCKED', `只读拦截本体写动作 ${r.objectType}.${a.actionKey}，用户选择切档重跑。`)
            return { content: `🔄 已切到「允许操作」，正在按原任务重新执行…（写操作会请你人工确认）`, success: true, traceId: trace.id, permSwitch: true }
          }
          const content = `🔒 已选择继续保持**只读**：对象动作「${a.label}」（${r.objectType}，写操作）已跳过，未做任何改动。`
          await trace.submit(content, 'BLOCKED', `只读模式拦截本体写动作 ${r.objectType}.${a.actionKey}（用户选择继续只读）。`)
          return { content, success: true, traceId: trace.id }
        }

        const externalId = 'p0-' + String(r.displayName || r.objectType || 'obj').replace(/\s+/g, '').slice(0, 32)
        const refId = await recordObjectRef(r.objectType!, sys, externalId, r.displayName || r.objectType!, toState)

        const needConfirm = ontologyNeedsConfirm(a, r.amount)
        trace.skill = `${r.objectType}.${a.actionKey}`
        const graph = t ? buildOntologyGraphText(t, r, toState) : ''

        // ===== P1·B：读驱动消解 —— 对象类型配了列表页时，先从真实系统读候选、消解/人工指认，再导航到该对象执行写 =====
        const listPath: string = (t && t.resolveListPath) || ''
        if (isWrite && a.connectorActionId && listPath) {
          const { sysName, baseUrl } = await resolveSystemBaseUrl(sys)
          if (!baseUrl) {
            const content = `🧩 **本体语义执行**\n\n- 对象动作：**${a.label}**（${r.objectType}）\n\n⚠️ 该对象类型未绑定可访问的业务系统地址，无法读候选。请到管理端「业务系统连接」配置。`
            await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：无系统地址。`); return { content, success: true, traceId: trace.id }
          }
          const listUrl = baseUrl.replace(/\/$/, '') + listPath
          sendLog('thinking', `按本体读驱动消解：从【${sysName}】读取候选「${r.objectType}」…`)
          const read = await browseAndExtractLinks(sys, listUrl, sendLog)
          if (!read.ok) {
            const content = `🧩 **本体语义执行**\n\n❌ 读取【${sysName}】候选失败：${read.error || '未知错误'}。`
            await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：读候选失败。`); return { content, success: true, traceId: trace.id }
          }
          if (!read.loggedIn) {
            const content = `🧩 **本体语义执行**\n\n⚠️ 未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`
            await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：未登录。`); return { content, success: true, traceId: trace.id }
          }
          const matches = matchOntologyCandidates(read.links, r.displayName || '', data.content, r.amount)
          // 真实读到的候选池（去重、去空、限量），供“未指定/未精确匹配时”下拉人工指定——全部来自真实读取，不虚构。
          // 双保险：抓取端已剔除 nav/aside 菜单链接；此处再优先取表格/列表容器内的链接（业务对象几乎都在列表里），避免残余站点骨架链接混入下拉。
          const seenTxt = new Set<string>()
          const dedup = read.links.filter(c => { const t = (c.text || '').trim(); if (t.length < 2 || seenTxt.has(t)) return false; seenTxt.add(t); return true })
          const inTablePool = dedup.filter(c => (c as any).inTable)
          const basePool = inTablePool.length ? inTablePool : dedup
          // 本分支是写操作（如审批同意）——已办结的条目不该出现在待办下拉里。按行内状态过滤：
          // 优先只留明确"待处理"的行；若行内没有待处理标记，则剔除明确"已办结"的行；全无状态信息才原样保留。
          const PENDING_RE = /待审批|审批中|待处理|待审|待办|待确认|pending/i
          const DONE_RE = /已通过|已退回|已驳回|已拒绝|已审批|已同意|已完成|已批准|已办结|已处理|approved|rejected/i
          const pendingPool = basePool.filter(c => PENDING_RE.test(c.rowText || ''))
          const notDonePool = basePool.filter(c => !DONE_RE.test(c.rowText || ''))
          const pool = (pendingPool.length ? pendingPool : (notDonePool.length ? notDonePool : basePool)).slice(0, 40)
          // 匹配为 0：若系统里根本没候选 → 如实告知；若有候选（说明用户是泛指"合同"而没点名某一份）→ 摆出真实候选让其下拉指定，而非直接失败。
          let pickPool = matches
          const isGenericPick = matches.length === 0
          if (matches.length === 0) {
            if (pool.length === 0) {
              await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ResolutionFailed', fromState: a.fromState, toState: a.fromState, riskLevel: 'LOW', note: `【${sysName}】无候选「${r.objectType}」` })
              const content = `🧩 **本体语义执行**\n\n🔎 在【${sysName}】未读取到任何可处理的「**${r.displayName || r.objectType}**」条目,未执行任何写操作(不虚构)。请确认系统内是否有待处理项,或换个说法重试。`
              await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：无候选。`); return { content, success: true, traceId: trace.id }
            }
            pickPool = pool
          }
          // 未指定 / 多候选 → 人工指认（下拉选真实候选）；泛指时额外提供「全部符合自动审批条件」批量项
          let chosen = pickPool[0]
          const ALL_OPT = `▶ 全部符合自动审批条件（批量同意）`
          if (isGenericPick || pickPool.length > 1) {
            sendLog('acting', isGenericPick ? `未点名具体「${r.objectType}」,已从【${sysName}】读到 ${pickPool.length} 个待处理项,请下拉指定或批量…` : `匹配到 ${pickPool.length} 个候选对象,请人工指认…`)
            const options = isGenericPick ? [ALL_OPT, ...pickPool.map(m => m.text)] : pickPool.map(m => m.text)
            const pick = await requestFormConfirmation([{ name: '_pick', label: isGenericPick ? `未指定具体「${r.objectType}」——选「全部符合条件」批量，或从【${sysName}】待处理列表中选一份（真实读取）` : `匹配到多个「${r.objectType}」,请选择目标对象`, value: options[0], type: 'select', options }])
            if (!pick || Object.keys(pick).length === 0) {
              const content = `🚫 已取消该操作（未指认目标对象），未执行、未改动状态。`
              await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消指认。`); return { content, success: true, traceId: trace.id }
            }
            const pv = pick['_pick']
            // ===== 批量：全部符合「自动审批条件」（金额≤上限）→ 过滤真实金额 → 汇总确认 → 逐个执行 =====
            if (pv === ALL_OPT) {
              const policyMax = Number(policy.autoApproveMaxAmount) || 0
              const crit = await requestFormConfirmation([{ name: '_maxAmount', label: `自动审批条件：仅同意「金额 ≤ 上限」的合同（元）。读不到金额的一律不批。`, value: policyMax ? String(policyMax) : '10000000', type: 'text' }])
              if (!crit || !crit['_maxAmount']) {
                const content = `🚫 已取消批量审批（未设定条件），未执行、未改动状态。`
                await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：取消批量条件。`); return { content, success: true, traceId: trace.id }
              }
              const maxAmount = Number(String(crit['_maxAmount']).replace(/[,，\s]/g, '')) || 0
              const scored = pool.map(c => ({ c, amt: parseAmountFromText(c.rowText || c.text) }))
              const eligible = scored.filter(x => x.amt != null && x.amt <= maxAmount) as { c: typeof pool[number]; amt: number }[]
              const skipped = scored.filter(x => x.amt == null || (x.amt as number) > maxAmount)
              if (eligible.length === 0) {
                const content = `🧩 **本体语义执行（批量自动审批）**\n\n条件：金额 ≤ ${fmtYuan(maxAmount)}。在【${sysName}】读到 ${pool.length} 项,**无一符合**（金额超上限或未读到金额）,未执行任何写操作。`
                await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：批量无符合项。`); return { content, success: true, traceId: trace.id }
              }
              // 汇总确认（列出将批的全部合同）
              const listMd = eligible.map(x => `- ${x.c.text}（${fmtYuan(x.amt)}）`).join('\n')
              const conf = await requestFormConfirmation([{ name: '_confirm', label: `将批量「${a.label}」以下 ${eligible.length} 份合同（金额≤${fmtYuan(maxAmount)}），核对后确认执行`, value: `共 ${eligible.length} 份，另跳过 ${skipped.length} 份`, type: 'text' }])
              if (!conf || Object.keys(conf).length === 0) {
                const content = `🚫 已取消批量审批，未执行、未改动任何合同状态。\n\n**原拟批（已取消）：**\n${listMd}`
                await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：取消批量确认（${eligible.length}份）。`); return { content, success: true, traceId: trace.id }
              }
              // 逐个执行（每份都真实回放 + 逐条业务事件审计）
              sendLog('acting', `开始批量执行 ${eligible.length} 份「${a.label}」…`)
              const exStepsB = await loadExecutorSteps(a.connectorActionId)
              const opStepsB = exStepsB.steps.slice(-1)
              const results: { text: string; amt: number; ok: boolean }[] = []
              for (const { c, amt } of eligible) {
                if (runningState.aborted) { sendLog('observing', '已终止,停止后续批量。'); break }
                const exId = decodeURIComponent((c.href.split('?')[0].split('#')[0].replace(/\/$/, '').split('/').pop()) || '')
                await afetch(`${getAdminBaseUrl()}/api/v1/ontology/object-refs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objectType: r.objectType, systemId: sys, externalId: exId, displayName: c.text, currentState: a.fromState }) }).catch(() => {})
                let ok = false
                if (exStepsB.kind === 'api' && exStepsB.api) {
                  // API 形态：{{externalId}} 占位直调（登录 cookie 取自本地系统分区）
                  const rr = await callSystemApi(sys, baseUrl, exStepsB.api, { externalId: exId }, sendLog)
                  ok = rr.ok
                } else if (exStepsB.kind === 'sop') {
                  // SOP 智能体形态：逐个对象在详情页读页面执行（免录制）
                  const rs = await runSopAgent(sys, c.href, sysName, exStepsB.sop || '', {}, sendLog, data.llmConfig)
                  ok = !!(rs.ok && rs.loggedIn && rs.failedAt < 0)
                } else {
                  const rep = opStepsB.length ? await replayActionScript(sys, c.href, sysName, opStepsB, {}, {}, sendLog) : { ok: false, loggedIn: true, failedAt: 0 } as any
                  ok = !!(rep.ok && rep.loggedIn && rep.failedAt < 0 && opStepsB.length)
                }
                await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: ok ? eventType : 'ExecutionFailed', fromState: a.fromState, toState: ok ? toState : a.fromState, riskLevel: policy.risk || 'MEDIUM', note: `批量自动审批(金额≤${maxAmount}) 对「${c.text}」(${amt}元)：${ok ? '成功' : '失败'}` })
                results.push({ text: c.text, amt, ok })
                sendLog('acting', `${ok ? '✅' : '❌'} ${c.text}`)
              }
              const okN = results.filter(x => x.ok).length
              const plain =
                `✅ 已批量「${a.label}」符合条件（金额 ≤ ${fmtYuan(maxAmount)}）的 ${eligible.length} 份，成功 ${okN}/${results.length}${skipped.length ? `，另跳过 ${skipped.length} 份` : ''}。\n\n` +
                `${results.map(x => `${x.ok ? '✅' : '❌'} ${x.text}`).join('\n')}`
              const detail =
                `🧩 **本体语义执行（批量自动审批）**\n\n` +
                `- 动作：**${a.label}** \`${a.actionKey}\`（${r.objectType}）\n` +
                `- 自动审批条件：金额 ≤ **${fmtYuan(maxAmount)}**\n` +
                `- 从【${sysName}】读 ${pool.length} 项 → 符合 ${eligible.length} 份、跳过 ${skipped.length} 份 → 成功 **${okN}/${results.length}**\n\n` +
                `**执行明细：**\n${results.map(x => `${x.ok ? '✅' : '❌'} ${x.text}（${fmtYuan(x.amt)}）`).join('\n')}` +
                (skipped.length ? `\n\n**未纳入（金额超上限/未读到金额，未处理）：**\n${skipped.map(x => `- ${x.c.text}${x.amt != null ? `（${fmtYuan(x.amt)}）` : '（未读到金额）'}`).join('\n')}` : '') +
                `\n\n> 每份均已在管理端「本体建模 · 业务事件审计」逐条记录。`
              await trace.submit(detail, okN === results.length && okN > 0 ? 'SUCCESS' : 'PARTIAL', `本体 ${r.objectType}.${a.actionKey} 批量自动审批：${okN}/${results.length} 成功（条件≤${maxAmount}）。`)
              return { content: plain, ontology: detail, success: true, traceId: trace.id }
            }
            chosen = pickPool.find(m => m.text === pv) || pickPool[0]
          }
          const matchNote = isGenericPick ? `未点名，用户从真实候选中指定` : `匹配 ${matches.length} 个${matches.length > 1 ? '（已人工指认）' : ''}`
          // 策略确认（签名）
          // 写操作一律人工确认（安全红线）——不再只看策略命中与否；策略只影响风险等级标注。
          {
            sendLog('acting', needConfirm ? '该动作命中确认策略：请你人工确认（签名）后执行…' : '这是写操作，请人工确认后执行…')
            const rc = await requestFormConfirmation([
              { name: '_obj', label: '目标对象', value: chosen.text, type: 'text' },
              { name: '_act', label: '动作', value: a.label, type: 'text' },
              ...(r.amount != null ? [{ name: '_amount', label: '金额(元)', value: String(r.amount), type: 'text' }] : []),
            ])
            if (!rc || Object.keys(rc).length === 0) {
              const content = `🚫 已取消该操作，未执行、未改动状态。`
              await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消确认。`); return { content, success: true, traceId: trace.id }
            }
          }
          // 导航到该对象详情页 → 执行写操作步（取录制的最后一步操作，如「同意」；导航步由消解代劳）
          if (runningState.aborted) { const content = `🚫 已终止,未对「${chosen.text}」执行任何写操作。`; await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户终止。`); return { content, success: true, traceId: trace.id } }
          const exSteps = await loadExecutorSteps(a.connectorActionId)
          const opSteps = exSteps.steps.slice(-1)
          const externalId = decodeURIComponent((chosen.href.split('?')[0].split('#')[0].replace(/\/$/, '').split('/').pop()) || '')
          await afetch(`${getAdminBaseUrl()}/api/v1/ontology/object-refs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objectType: r.objectType, systemId: sys, externalId, displayName: chosen.text, currentState: a.fromState }) }).catch(() => {})
          let executed = false, outcome = ''
          if (exSteps.kind === 'api' && exSteps.api) {
            // API 形态：{{externalId}} 占位直调（登录 cookie 取自本地系统分区）
            const rr = await callSystemApi(sys, baseUrl, exSteps.api, { externalId }, sendLog)
            executed = rr.ok
            outcome = rr.ok
              ? `🤖 已经由 API 接口在【${sysName}】对「${chosen.text}」完成操作（HTTP ${rr.status}）。${exSteps.api.outputDesc ? `\n\n**接口输出说明：** ${exSteps.api.outputDesc}` : ''}`
              : (rr.status === 0 ? `❌ API 直调失败：${rr.text}` : `⚠️ API 直调返回 HTTP ${rr.status}：${(rr.text || '').slice(0, 200) || '（无响应体）'}`)
          } else if (exSteps.kind === 'sop') {
            // SOP 智能体形态：在对象详情页读页面逐步执行（免录制）
            const rs = await runSopAgent(sys, chosen.href, sysName, exSteps.sop || '', {}, sendLog, data.llmConfig)
            executed = !!(rs.ok && rs.loggedIn && rs.failedAt < 0)
            outcome = executed ? `🤖 已由 SOP 智能体在【${sysName}】对「${chosen.text}」完成操作（${rs.done} 步）。`
              : (!rs.loggedIn ? `⚠️ 未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`
              : `❌ SOP 智能体未能完成对「${chosen.text}」的操作：${rs.failLabel || rs.error || '多轮无进展'}。可到系统核实，或改用录制回放。`)
          } else {
            const rep = opSteps.length ? await replayActionScript(sys, chosen.href, sysName, opSteps, {}, {}, sendLog) : { ok: false, loggedIn: true, done: 0, total: 0, failedAt: -1, failLabel: '', title: '', url: '' } as any
            executed = !!(rep.ok && rep.loggedIn && rep.failedAt < 0 && opSteps.length)
            const failDetail = rep.error || rep.failLabel || '元素未找到'
            outcome = !opSteps.length ? '⚠️ 绑定的执行器没有可回放的操作步。'
              : (executed ? `🤖 已在【${sysName}】对「${chosen.text}」完成操作。`
              : (!rep.loggedIn ? `⚠️ 未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`
              : `❌ 未完成：在「${chosen.text}」页面上没有找到可点击的操作按钮（${failDetail}）。**最常见原因：该条目已经处理过**（如已审批通过，页面不再显示「同意」按钮）；也可能是页面结构变化。请在【${sysName}】打开该条目核实状态；若确实待处理，请到 FDE 工作台重新录制该操作。`))
          }
          const evType = executed ? eventType : 'ExecutionFailed'
          await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: evType, fromState: a.fromState, toState: executed ? toState : a.fromState, riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'), note: executed ? `经读驱动消解定位「${chosen.text}」并在真实系统执行（${exSteps.kind === 'api' ? 'API 直调' : exSteps.kind === 'sop' ? 'SOP 智能体' : '录制回放'}）` : '执行未完成' })
          // 回复正文：只给业务人员一句话；技术细节进「本体执行」折叠区（ontology）
          const plain = executed
            ? `✅ 已在【${sysName}】对「${chosen.text}」完成「${a.label}」。`
            : outcome
          const detail =
            `🧩 **本体语义执行（读驱动消解）**\n\n` +
            `- 对象：**${chosen.text}**（${r.domain} · ${r.objectType}，externalId=\`${externalId}\`）\n` +
            `- 消解：从【${sysName}】读 ${read.links.length} 个候选,${matchNote}\n` +
            `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability}）\n` +
            `- 状态迁移：\`${a.fromState || '当前'}\` → \`${executed ? toState : '（未变更）'}\`\n` +
            `\n**执行结果：** ${outcome}\n\n> 管理端「本体建模 · 业务事件审计」可见本次事件（\`${evType}\`,已锚定真实对象 \`${externalId}\`）。`
          await trace.submit(detail, executed ? 'SUCCESS' : 'PARTIAL', `本体 ${r.objectType}.${a.actionKey} 读驱动消解→${chosen.text}：${executed ? '执行' : '未完成'}。`)
          return { content: plain, ontology: detail, success: true, traceId: trace.id }
        }

        // ===== P1：绑定了连接器动作的写操作（无列表页/create 类）→ 抽取字段 + 人工确认（签名）+ 真实系统回放 =====
        if (isWrite && a.connectorActionId) {
          const summaryFields: VisitField[] = [
            { name: '_obj', label: '对象', value: r.displayName || r.objectType!, type: 'text' },
            { name: '_act', label: '动作', value: a.label, type: 'text' },
            { name: '_state', label: '状态迁移', value: `${a.fromState || '当前'} → ${toState}`, type: 'text' },
          ]
          if (r.amount != null) summaryFields.push({ name: '_amount', label: '金额(元)', value: String(r.amount), type: 'text' })
          const ex = await executeOntologyConnectorAction(a.connectorActionId, data.content, data.llmConfig, sendLog, needConfirm, summaryFields)
          if (ex.status === 'cancelled') {
            const content = `🚫 已取消对象动作「${a.label}」（${r.objectType}），未执行、未改动状态。`
            await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消。`); return { content, success: true, traceId: trace.id }
          }
          const executed = ex.status === 'ok'
          const evType = executed ? eventType : 'ExecutionFailed'
          await recordBusinessEvent({
            objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey,
            eventType: evType, fromState: a.fromState, toState: executed ? toState : a.fromState,
            riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'),
            note: executed ? '经绑定连接器动作在真实系统执行' : ('执行未完成：' + ex.status),
          })
          const fieldTable = ex.fields.length
            ? `\n\n**确认字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${ex.fields.map(f => `| ${f.label} | ${ex.confirmed[f.name] || '（空）'} |`).join('\n')}`
            : ''
          const plain = executed
            ? `✅ 已对「${r.displayName || r.objectType}」完成「${a.label}」。`
            : ex.outcome
          const detail =
            `🧩 **本体语义执行**\n\n` +
            `- 对象：**${r.displayName || r.objectType}**（${r.domain} · ${r.objectType}）\n` +
            `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability} · 已绑定连接器动作）\n` +
            `- 状态迁移：\`${a.fromState || '当前'}\` → \`${executed ? toState : '（未变更）'}\`\n` +
            (graph ? `\n${graph}\n` : '') +
            `\n**执行结果：** ${ex.outcome}${fieldTable}\n\n` +
            `> 管理端「本体建模 · 业务事件审计」可见本次事件（\`${evType}\`）。`
          await trace.submit(detail, executed ? 'SUCCESS' : 'PARTIAL', `本体动作 ${r.objectType}.${a.actionKey} 经连接器动作执行：${ex.status}。`)
          return { content: plain, ontology: detail, success: true, traceId: trace.id }
        }

        // ===== 未绑定连接器动作：语义登记路径（写操作命中确认策略 → 人工签名）=====
        let confirmed = true
        if (isWrite && needConfirm) {
          sendLog('acting', '该动作命中确认策略：请你人工确认（签名）…')
          const fields: any = [
            { label: '对象', value: r.displayName || r.objectType! },
            { label: '动作', value: a.label },
            { label: '状态迁移', value: `${a.fromState || '当前'} → ${toState}` },
          ]
          if (r.amount != null) fields.push({ label: '金额(元)', value: String(r.amount) })
          const ret = await requestFormConfirmation(fields)
          confirmed = !!(ret && Object.keys(ret).length > 0)
        }
        if (isWrite && needConfirm && !confirmed) {
          await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ConfirmationRejected', fromState: a.fromState, toState: a.fromState, riskLevel: 'MEDIUM', note: '用户取消人工确认' })
          const content = `🔒 已识别为对象动作「${a.label}」（${r.objectType}）。因命中确认策略需人工签名，你已取消，**未执行、未改动状态**。`
          await trace.submit(content, 'BLOCKED', `本体动作 ${r.objectType}.${a.actionKey} 需人工确认，用户取消。`)
          return { content, success: true, traceId: trace.id }
        }
        await recordBusinessEvent({
          objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey,
          eventType, fromState: a.fromState, toState,
          riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'),
          note: 'P0：本体已登记状态迁移，真实系统写入待绑定连接器动作',
        })
        const plain = `✅ 已识别为对象动作「${a.label}」并登记状态变更。该动作尚未绑定可执行连接器，真实系统写入待在管理端「本体建模」绑定后生效。`
        const detail =
          `🧩 **本体语义执行**\n\n` +
          `- 对象：**${r.displayName || r.objectType}**（${r.domain} · ${r.objectType}）\n` +
          `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability}）\n` +
          `- 状态迁移：\`${a.fromState || '当前'}\` → \`${toState}\`\n` +
          `- 策略：${needConfirm ? '**需人工确认**（已签名）' : '低风险 · 自动'}\n` +
          (graph ? `\n${graph}\n` : '') +
          `\n✅ 已在本体登记该状态迁移并回写业务事件（\`${eventType}\`）。该动作**未绑定连接器动作**，真实业务系统写入需在管理端「本体建模」为其绑定连接器动作后生效。\n\n` +
          `> 可在管理端「本体建模 · 业务事件审计 / 对象实例」查看本次事件与对象引用。`
        await trace.submit(detail, 'SUCCESS', `本体动作 ${r.objectType}.${a.actionKey} 语义登记，事件 ${eventType}。`)
        return { content: plain, ontology: detail, success: true, traceId: trace.id }
      }
    } catch (e: any) { console.error('[ontology hook] err:', e?.message) }
  return null
}
