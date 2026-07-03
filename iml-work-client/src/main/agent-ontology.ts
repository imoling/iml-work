// 本体钩子：agent:send-message 的第一道编排——先把指令解析为「对象+动作」，
// 命中则走语义执行（策略闸→确认→真实读取/回放→事件回写），返回统一结果；未命中返回 null 让主链路继续。
// 纯搬迁自 main.ts。真实读取/回放驱动业务系统，冷启动冒烟测不到，正确性需真实技能跑一遍验证。
import { resolveOntology, recordObjectRef, ontologyNeedsConfirm, buildOntologyGraphText, resolveSystemBaseUrl, browseAndExtractLinks, matchOntologyCandidates, recordBusinessEvent, loadExecutorSteps, executeOntologyConnectorAction } from './ontology-runtime'
import { replayActionScript } from './browser-automation'
import { requestFormConfirmation, runningState } from './automation-runtime'
import { afetch, getAdminBaseUrl } from './http'
import type { SendLog, VisitField } from './types'
import type { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'

// 命中并处理 → 返回 AgentResult(早返回);未命中/用户锁定了技能 → 返回 null,主链路继续。
export async function runOntologyHook(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  if (data.forcedSkillId) return null
    try {
      const onto = await resolveOntology(data.content, data.llmConfig)
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

        // 只读模式拦截写操作
        if (isWrite && data.permMode === 'readonly') {
          const content = `🔒 本次为**只读模式**。已识别为对象动作「${a.label}」（${r.objectType}，写操作），未做任何改动。\n\n如需执行，请把「权限范围」切到 **允许操作** 后重试（写操作仍会请你人工确认）。`
          await trace.submit(content, 'BLOCKED', `只读模式拦截本体写动作 ${r.objectType}.${a.actionKey}。`)
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
          if (matches.length === 0) {
            await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ResolutionFailed', fromState: a.fromState, toState: a.fromState, riskLevel: 'LOW', note: `未在【${sysName}】匹配到「${r.displayName || ''}」` })
            const content = `🧩 **本体语义执行**\n\n🔎 在【${sysName}】未找到与「**${r.displayName || r.objectType}**」匹配的对象,未执行任何写操作(不虚构)。请确认对象名称,或换个说法重试。`
            await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：消解无匹配。`); return { content, success: true, traceId: trace.id }
          }
          // 多候选 → 人工指认
          let chosen = matches[0]
          if (matches.length > 1) {
            sendLog('acting', `匹配到 ${matches.length} 个候选对象,请人工指认…`)
            const pick = await requestFormConfirmation([{ name: '_pick', label: `匹配到多个「${r.objectType}」,请选择目标对象`, value: matches[0].text, type: 'select', options: matches.map(m => m.text) }])
            if (!pick || Object.keys(pick).length === 0) {
              const content = `🚫 已取消该操作（未指认目标对象），未执行、未改动状态。`
              await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消指认。`); return { content, success: true, traceId: trace.id }
            }
            const pv = pick['_pick']
            chosen = matches.find(m => m.text === pv) || matches[0]
          }
          // 策略确认（签名）
          if (needConfirm) {
            sendLog('acting', '该动作命中确认策略：请你人工确认（签名）后执行…')
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
          const rep = opSteps.length ? await replayActionScript(sys, chosen.href, sysName, opSteps, {}, {}, sendLog) : { ok: false, loggedIn: true, done: 0, total: 0, failedAt: -1, failLabel: '', title: '', url: '' } as any
          const executed = !!(rep.ok && rep.loggedIn && rep.failedAt < 0 && opSteps.length)
          const evType = executed ? eventType : 'ExecutionFailed'
          await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: evType, fromState: a.fromState, toState: executed ? toState : a.fromState, riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'), note: executed ? `经读驱动消解定位「${chosen.text}」并在真实系统执行` : ('执行未完成：' + (opSteps.length ? '回放失败' : '无操作步')) })
          const outcome = !opSteps.length ? '⚠️ 绑定的执行器没有可回放的操作步。' : (rep.ok && rep.loggedIn && rep.failedAt < 0 ? `🤖 已在【${sysName}】对「${chosen.text}」完成操作。` : (!rep.loggedIn ? `⚠️ 未登录【${sysName}】。` : `回放中断（${rep.error || rep.failLabel || '元素未找到'}）。`))
          const content =
            `🧩 **本体语义执行（读驱动消解）**\n\n` +
            `- 对象：**${chosen.text}**（${r.domain} · ${r.objectType}，externalId=\`${externalId}\`）\n` +
            `- 消解：从【${sysName}】读 ${read.links.length} 个候选,匹配 ${matches.length} 个${matches.length > 1 ? '（已人工指认）' : ''}\n` +
            `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability}）\n` +
            `- 状态迁移：\`${a.fromState || '当前'}\` → \`${executed ? toState : '（未变更）'}\`\n` +
            `\n**执行结果：** ${outcome}\n\n> 管理端「本体建模 · 业务事件审计」可见本次事件（\`${evType}\`,已锚定真实对象 \`${externalId}\`）。`
          await trace.submit(content, executed ? 'SUCCESS' : 'PARTIAL', `本体 ${r.objectType}.${a.actionKey} 读驱动消解→${chosen.text}：${executed ? '执行' : '未完成'}。`)
          return { content, success: true, traceId: trace.id }
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
          const content =
            `🧩 **本体语义执行**\n\n` +
            `- 对象：**${r.displayName || r.objectType}**（${r.domain} · ${r.objectType}）\n` +
            `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability} · 已绑定连接器动作）\n` +
            `- 状态迁移：\`${a.fromState || '当前'}\` → \`${executed ? toState : '（未变更）'}\`\n` +
            (graph ? `\n${graph}\n` : '') +
            `\n**执行结果：** ${ex.outcome}${fieldTable}\n\n` +
            `> 管理端「本体建模 · 业务事件审计」可见本次事件（\`${evType}\`）。`
          await trace.submit(content, executed ? 'SUCCESS' : 'PARTIAL', `本体动作 ${r.objectType}.${a.actionKey} 经连接器动作执行：${ex.status}。`)
          return { content, success: true, traceId: trace.id }
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
        const content =
          `🧩 **本体语义执行**\n\n` +
          `- 对象：**${r.displayName || r.objectType}**（${r.domain} · ${r.objectType}）\n` +
          `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability}）\n` +
          `- 状态迁移：\`${a.fromState || '当前'}\` → \`${toState}\`\n` +
          `- 策略：${needConfirm ? '**需人工确认**（已签名）' : '低风险 · 自动'}\n` +
          (graph ? `\n${graph}\n` : '') +
          `\n✅ 已在本体登记该状态迁移并回写业务事件（\`${eventType}\`）。该动作**未绑定连接器动作**，真实业务系统写入需在管理端「本体建模」为其绑定连接器动作后生效。\n\n` +
          `> 可在管理端「本体建模 · 业务事件审计 / 对象实例」查看本次事件与对象引用。`
        await trace.submit(content, 'SUCCESS', `本体动作 ${r.objectType}.${a.actionKey} 语义登记，事件 ${eventType}。`)
        return { content, success: true, traceId: trace.id }
      }
    } catch (e: any) { console.error('[ontology hook] err:', e?.message) }
  return null
}
