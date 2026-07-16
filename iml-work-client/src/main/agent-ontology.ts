// 本体钩子：agent:send-message 的第一道编排——先把指令解析为「对象+动作」，
// 命中则走语义执行（策略闸→确认→真实读取/回放→事件回写），返回统一结果；未命中返回 null 让主链路继续。
// 纯搬迁自 main.ts。真实读取/回放驱动业务系统，冷启动冒烟测不到，正确性需真实技能跑一遍验证。
import { resolveOntology, recordObjectRef, ontologyNeedsConfirm, resolveSystemBaseUrl, readObjectDetail, siblingWriteActions, browseAndExtractLinks, matchOntologyCandidates, recordBusinessEvent, loadExecutorSteps, executeOntologyConnectorAction, callSystemApi } from './ontology-runtime'
import { replayActionScript, runSopAgent } from './browser-automation'
import { requestFormConfirmation, requestPermissionChoice, runningState } from './automation-runtime'
import { afetch, getAdminBaseUrl } from './http'
import { swallow } from './util'
import type { SendLog, VisitField, RecStep } from './types'
import type { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'
import { renderOntologyDetail, renderOntologyReply, type OntologyDetailParts } from './ontology-view'
import { expertMayRun } from './ontology-core'
import { focusTouch, focusRecent } from './db'
import { rankByFocus } from './focus-core'
import { maybeRefreshProfile } from './focus-profile'

// 连接器三形态的人话名——卡片要说清"怎么做到的"，而不是甩个 kind 枚举。
const EXECUTOR_NAME: Record<string, string> = { replay: '录制回放', api: 'API 直调', sop: 'SOP 智能体' }

// 从候选行文本里解析金额（元）。支持 "¥5,000"/"6000万"/"6,000万"/"60,000,000元"。
//
// ⚠️ 血泪：旧版直接拿 /([\d,，]{4,})/ 去抓"第一串 4 位以上的数字"，结果在
// "CL-2026-0010 北京 … 2026-07-13 ~ 2026-07-14 ¥5,000 待审批" 这行里**第一个撞上的是单号里的 2026**，
// 于是人工确认卡上赫然写着「金额(元)·系统读取：2026」——摆一个假金额让人签字，比不摆更危险；
// 批量自动审批还拿它当"金额≤上限"的筛选依据，直接可能批错单。
//
// 现在：先剔除日期/单号这类"看着像数字其实不是钱"的片段，再**优先认货币标记**（¥/￥/元/万），
// 没有标记时只接受带千分位或 ≥5 位的数字，且拒绝裸年份。解析不出一律返回 null
// ——批量审批里「读不到金额」的一律不批（保守、不虚构）。
function parseAmountFromText(text: string): number | null {
  let s = (text || '').replace(/\s/g, '')
  s = s.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '')   // 日期 2026-07-13
    .replace(/[A-Za-z]+[-_]?\d{4}[-_]\d+/g, '')       // 单号 CL-2026-0010 / PO_2026_0115

  const wan = s.match(/([\d,，.]+)\s*万/)
  if (wan) { const n = Number(wan[1].replace(/[,，]/g, '')); if (!isNaN(n) && n > 0) return Math.round(n * 10000) }

  // 带货币标记的最可信：¥5,000 / 5000元
  const marked = s.match(/[¥￥]\s*([\d,，.]+)/) || s.match(/([\d,，.]+)\s*元/)
  if (marked) { const n = Number(marked[1].replace(/[,，]/g, '')); if (!isNaN(n) && n > 0) return n }

  // 无标记兜底：必须带千分位，或 ≥5 位（4 位裸数字太容易是年份/编号，不认）
  const bare = s.match(/(\d{1,3}(?:[,，]\d{3})+|\d{5,})/)
  if (bare) { const n = Number(bare[1].replace(/[,，]/g, '')); if (!isNaN(n) && n >= 1000) return n }
  return null
}
const fmtYuan = (n: number) => n.toLocaleString('en-US') + '元'

// 岗位业务域侧重（管理端「岗位专家 · 业务域侧重」配置）：本体解析优先在侧重域内匹配。60s 缓存。
let expertDomainsCache: { id: string; domains: string[]; at: number } | null = null
export async function getExpertOntologyDomains(expertId: string): Promise<string[]> {
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

// 把岗位 id 说成人话（拒绝信息里要告诉用户"该找谁"，甩一串 expert-plant-leader 没人看得懂）。
const expertNameCache = new Map<string, string>()
async function describeAllowedExperts(ids: string[]): Promise<string> {
  if (!ids.length) return '（未限定岗位）'
  const names: string[] = []
  for (const id of ids) {
    if (expertNameCache.has(id)) { names.push(expertNameCache.get(id)!); continue }
    let nm = id
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${id}`)
      if (r.ok) { const e = await r.json() as { title?: string }; if (e.title) nm = e.title }
    } catch (e) { swallow(e, 'expert-name') }
    expertNameCache.set(id, nm)
    names.push(nm)
  }
  return names.map(n => `【${n}】`).join('、')
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

        // ===== 岗位授权闸（安全红线，第一道）=====
        // 在读候选、在任何执行之前就拦住。此前本体动作**没有权限概念**：只要岗位的业务域侧重
        // 命中（如 PLANT），一线「装置操作工」的分身就能执行 ProductionOrder.approve、批准生产指令。
        // 危化行业里这是事故级漏洞——职权必须在本体里显式声明，而不是靠"没人会这么说"来兜底。
        if (!expertMayRun(a, data.expertId)) {
          const who = await describeAllowedExperts(a.allowedExperts || [])
          const content = `🔒 **无权执行**：「${a.label}」（${t?.label || r.objectType}）不在当前岗位【${data.expertName || '本岗位'}】的职权范围内，未做任何读取或改动。\n\n该动作属于 ${who} 的职权。如确需执行，请切换到对应岗位分身，或联系管理员在「本体建模 → 动作 → 允许岗位」中授权。`
          trace.spans.push({ type: 'ontology', name: `授权拒绝·${r.objectType}.${a.actionKey}`, status: 'warn' })
          await trace.submit(content, 'BLOCKED', `岗位授权拒绝：${data.expertId || '(无岗位)'} 无权执行 ${r.objectType}.${a.actionKey}（限 ${(a.allowedExperts || []).join('/')}）。`)
          return { content, success: true, traceId: trace.id }
        }

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
        // 对象的**业务名**：用户指名的 → 本体类型 label（如「差旅审批单」）→ 兜底才用 typeKey。
        // 曾直接 `displayName || objectType`，新建类没有 displayName，于是回复里出现了「已对『TravelApproval』完成…」。
        const objName = r.displayName || t?.label || r.objectType || '业务对象'
        // 状态的人话名来自本体状态机的 labels（数据驱动；没配就退回状态键，代码不写死领域词表）
        const stName = (st?: string): string => (st && sm && sm.labels && typeof sm.labels[st] === 'string') ? sm.labels[st] : ''
        const stateLabel: string = stName(toState)
        // 岗位画像沉淀：真实接触过的对象落一笔（本地 SQLite 按账号分库，绝不上传）。
        // 范围按**岗位侧重域**收敛（用户拍板）：配了侧重域的岗位只沉淀域内对象；没配的不过滤。
        // 只在「对象身份来自真实读取」的路径调用（读驱动消解/批量）——connector 直调和语义登记的
        // 对象名是用户口述+伪 externalId，身份未经系统证实，不入画像（红线：对象只能来自真实读取）。
        const sinkFocus = (x: { externalId: string; displayName: string; state?: string; fieldsJson?: string; summary: string }) => {
          try {
            if (expertDomains.length && r.domain && !expertDomains.includes(r.domain)) return
            focusTouch({ expertId: data.expertId || '', objectType: r.objectType!, systemId: sys, kind: 'action', traceId: trace.id, ...x })
            // 画像摘要低频异步重生成——fire-and-forget，绝不阻塞执行链路
            void maybeRefreshProfile(data.expertId || '', r.objectType!, x.displayName, data.llmConfig)
          } catch (e) { swallow(e, 'focus-sink') }
        }
        // 对象关系一行内联表达（如 `targets → Contract`）。原先画 ASCII 关系图塞进 markdown 列表后面，
        // 代码围栏渲染坏掉——卡片里只剩两个孤零零的反引号加一片空白。单节点的图本来也没信息量。
        let relText = ''
        try {
          const rels = t?.relationsJson ? JSON.parse(t.relationsJson) : []
          relText = (rels as { name: string; targetType: string }[]).map(x => `${x.name} → ${x.targetType}`).join('、')
        } catch (e) { swallow(e, 'onto-relations') }

        // ===== P1·B：读驱动消解 —— 对象类型配了列表页时，先从真实系统读候选、消解/人工指认，再导航到该对象执行写 =====
        //
        // 但「新建一张本类型单子」的动作（如提交差旅申请）不该走这里：那张单子**还不存在**，
        // 去列表页找它必然找不到，只会把用户已有的旧单子摆出来让他选——荒谬且危险。
        // 这个语义猜不出来（capability=create 的 Part.replenish 恰恰要挑一个现有零件来补货；
        // fromState 为空的 Opportunity.advanceStage 也要挑现有商机），所以由建模时**显式声明**：
        // policy.createsNew = true 表示"产出一张新的本类型对象"，跳过读驱动消解，走字段抽取+确认+回放。
        const createsNew = policy.createsNew === true
        const listPath: string = (t && t.resolveListPath) || ''
        if (isWrite && a.connectorActionId && listPath && !createsNew) {
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
          // 消解加权：最近接触过的对象排前面（只排序不改文案、绝不代选——指认必须是人做的）
          let focusRows: ReturnType<typeof focusRecent> = []
          try { focusRows = focusRecent(data.expertId || '', r.objectType) } catch (e) { swallow(e, 'focus-rank') }
          const matches = rankByFocus(matchOntologyCandidates(read.links, r.displayName || '', data.content, r.amount), focusRows)
          // 状态漂移提醒：本地画像是快照——真实读到的状态与快照不同就说一句（只提醒不改库，改库只在真实接触时）
          try {
            const smLabels: string[] = sm && sm.labels ? (Object.values(sm.labels).filter(v => typeof v === 'string') as string[]) : []
            for (const f of focusRows) {
              if (!f.lastState || !f.displayName) continue
              const link = read.links.find(l => (l.text || '').includes(f.displayName) || f.displayName.includes((l.text || '').trim()))
              if (!link || !link.rowText) continue
              const nowState = smLabels.find(lb => lb && (link.rowText || '').includes(lb))
              if (nowState && nowState !== f.lastState) sendLog('observing', `留意：「${f.displayName}」当前状态是「${nowState}」，与你上次接触时（${f.lastState}）不同。`)
            }
          } catch (e) { swallow(e, 'focus-drift') }
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
          // 匹配为 0 有两种含义，必须分开处理（红线：曾把二者混为一谈——用户说"审批王磊的差旅"，
          // 系统里全是合同、匹配为 0，却被当成"泛指"摆出 8 份合同并默认选中「批量同意」，
          // 一路确认就会把无关合同全批了）：
          //   ① 用户【泛指】（未点名具体对象，如"审批合同"）→ 摆出真实候选供下拉指定/批量。
          //   ② 用户【点名了】具体对象（displayName 非空，如"王磊的差旅"）但没匹配上
          //      → 说明系统里没有这份单子（或读的不是它的列表页）。必须如实告知、不摆无关候选、不给批量项。
          let pickPool = matches
          const namedTarget = (r.displayName || '').trim()
          const isGenericPick = matches.length === 0 && !namedTarget
          if (matches.length === 0) {
            if (pool.length === 0) {
              await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ResolutionFailed', fromState: a.fromState, toState: a.fromState, riskLevel: 'LOW', note: `【${sysName}】无候选「${r.objectType}」` })
              const content = `🧩 **本体语义执行**\n\n🔎 在【${sysName}】未读取到任何可处理的「**${r.displayName || r.objectType}**」条目,未执行任何写操作(不虚构)。请确认系统内是否有待处理项,或换个说法重试。`
              await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：无候选。`); return { content, success: true, traceId: trace.id }
            }
            if (namedTarget) {
              // 点名了却没匹配上 → 绝不拿无关候选顶替（那会导致批错单子）。如实告知并列出实际读到的前几项供参考。
              await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ResolutionFailed', fromState: a.fromState, toState: a.fromState, riskLevel: 'LOW', note: `【${sysName}】未找到指名对象「${namedTarget}」` })
              const preview = pool.slice(0, 5).map(c => `- ${c.text}`).join('\n')
              const content = `🧩 **本体语义执行**\n\n🔎 在【${sysName}】的待处理列表里**没有找到**「**${namedTarget}**」，未执行任何写操作（不会拿其它单子顶替）。\n\n当前该列表里实际读到的待处理项是：\n${preview}${pool.length > 5 ? `\n…等共 ${pool.length} 项` : ''}\n\n请确认该单据是否存在、是否在别的列表页（如差旅审批与合同审批分属不同入口），或改用它在系统里的准确名称/单号重试。`
              await trace.submit(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：指名对象「${namedTarget}」未在候选中找到，未执行。`)
              return { content, success: true, traceId: trace.id }
            }
            pickPool = rankByFocus(pool, focusRows)
          }
          // 未指定 / 多候选 → 人工指认（下拉选真实候选）；泛指时额外提供「全部符合自动审批条件」批量项
          let chosen = pickPool[0]
          const ALL_OPT = `▶ 全部符合自动审批条件（批量同意）`
          if (isGenericPick || pickPool.length > 1) {
            sendLog('acting', isGenericPick ? `未点名具体「${r.objectType}」,已从【${sysName}】读到 ${pickPool.length} 个待处理项,请下拉指定或批量…` : `匹配到 ${pickPool.length} 个候选对象,请人工指认…`)
            // 批量项排在【最后】、且默认值为空——批量同意是高危动作，绝不能是"打开就已选中、一路回车即执行"的默认项。
            const options = isGenericPick ? [...pickPool.map(m => m.text), ALL_OPT] : pickPool.map(m => m.text)
            const pick = await requestFormConfirmation([{ name: '_pick', label: isGenericPick ? `未指定具体「${r.objectType}」——请从【${sysName}】待处理列表中选一份（真实读取），或选最后一项批量处理` : `匹配到多个「${r.objectType}」,请选择目标对象`, value: '', type: 'select', options }])
            if (!pick || Object.keys(pick).length === 0 || !String(pick['_pick'] || '').trim()) {
              const content = `🚫 已取消该操作（未指认目标对象），未执行、未改动状态。`
              await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消指认。`); return { content, success: true, traceId: trace.id }
            }
            const pv = pick['_pick']
            // ===== 批量：全部符合「自动审批条件」（金额≤上限）→ 过滤真实金额 → 汇总确认 → 逐个执行 =====
            if (pv === ALL_OPT) {
              const policyMax = Number(policy.autoApproveMaxAmount) || 0
              const crit = await requestFormConfirmation([{ name: '_maxAmount', label: `自动审批条件：仅同意「金额 ≤ 上限」的「${r.objectType}」（元）。读不到金额的一律不批。`, value: policyMax ? String(policyMax) : '10000000', type: 'text' }])
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
                sinkFocus({ externalId: exId, displayName: c.text, state: ok ? (stateLabel || toState) : '', summary: `批量${a.label}（${fmtYuan(amt)}）：${ok ? '成功' : '失败'}` })
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
          // ===== 审批确认卡（安全红线：写操作一律人工确认）=====
          //
          // 审批的本质是「看清单据 → 做出裁决 → 留下意见」，所以这张卡分三层：
          //   ① 单据内容：**从详情页真实读取**，只读——摆出来是给人核对的，不该被改
          //      （改了也不会写回系统，只会让人误以为改生效了）。曾经这里只摆了三行，
          //      其中「金额」还是从单号 CL-2026-0010 里抠出来的 2026 —— 拿假数字让人签字，比不摆更危险。
          //   ② 审批动作：同一对象上有第二个可执行动作时（同意/退回）才给下拉；只有一个就只读展示。
          //   ③ 审批意见：可填，随执行写回业务系统。
          sendLog('acting', '正在读取单据详情，准备人工审批…')
          const detailKv = await readObjectDetail(sys, chosen.href, sendLog)
          const siblings = await siblingWriteActions(r.domain, r.objectType, a.fromState)
          const actOptions = siblings.map(x => x.label).filter(Boolean)
          const canPickAction = actOptions.length > 1

          const roFields: VisitField[] = detailKv.length
            ? detailKv.map((kv, i) => ({ name: `_d${i}`, label: kv.label, value: kv.value, type: 'text', readonly: true }))
            // 详情页读不到就退回列表行里的真实文本——仍是真实读取，不虚构
            : [{ name: '_obj', label: '目标对象', value: chosen.text, type: 'text', readonly: true }]

          const confirmFields: VisitField[] = [
            ...roFields,
            canPickAction
              ? { name: '_act', label: '审批动作', value: a.label, type: 'select', options: actOptions }
              : { name: '_act', label: '审批动作', value: a.label, type: 'text', readonly: true },
            { name: '_opinion', label: '审批意见', value: '', type: 'textarea' },
          ]
          sendLog('acting', needConfirm ? '该动作命中确认策略：请你人工确认（签名）后执行…' : '这是写操作，请人工确认后执行…')
          const rc = await requestFormConfirmation(confirmFields)
          if (!rc || Object.keys(rc).length === 0) {
            const content = `🚫 已取消该操作，未执行、未改动状态。`
            await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消确认。`); return { content, success: true, traceId: trace.id }
          }
          // 用户可能把动作从「审批通过」改成「退回」——按**他最后选的**那个执行，而不是模型最初解析的那个。
          const act = (canPickAction ? siblings.find(x => x.label === String(rc['_act'] || '').trim()) : null) || a
          const actPolicy = act.policyJson ? JSON.parse(act.policyJson) : policy
          const actToState = act.toState || toState
          const actEvent = actPolicy.eventType || eventType
          const actStateLabel: string = (sm && sm.labels && typeof sm.labels[actToState] === 'string') ? sm.labels[actToState] : ''
          const opinion = String(rc['_opinion'] || '').trim()

          // 导航到该对象详情页 → 执行写操作步（取录制的最后一步操作，如「同意」；导航步由消解代劳）
          if (runningState.aborted) { const content = `🚫 已终止,未对「${chosen.text}」执行任何写操作。`; await trace.submit(content, 'BLOCKED', `本体 ${r.objectType}.${act.actionKey}：用户终止。`); return { content, success: true, traceId: trace.id } }
          const exSteps = await loadExecutorSteps(act.connectorActionId || '')
          // 回放形态：审批意见先填进去再点按钮。填不到不算失败（有的系统没有意见框）——标 optional。
          const opSteps: RecStep[] = [
            ...(opinion ? [{ action: 'fill' as const, selector: '', value: opinion, label: '审批意见', tag: 'textarea', url: '', optional: true }] : []),
            ...exSteps.steps.slice(-1),
          ]
          const externalId = decodeURIComponent((chosen.href.split('?')[0].split('#')[0].replace(/\/$/, '').split('/').pop()) || '')
          await afetch(`${getAdminBaseUrl()}/api/v1/ontology/object-refs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objectType: r.objectType, systemId: sys, externalId, displayName: chosen.text, currentState: a.fromState }) }).catch(() => {})
          let executed = false, outcome = ''
          if (exSteps.kind === 'api' && exSteps.api) {
            // API 形态：{{externalId}} 占位直调（登录 cookie 取自本地系统分区）
            const rr = await callSystemApi(sys, baseUrl, exSteps.api, { externalId, opinion }, sendLog)
            executed = rr.ok
            outcome = rr.ok
              ? `🤖 已在【${sysName}】对「${chosen.text}」完成写入（接口直调 · HTTP ${rr.status}）。${exSteps.api.outputDesc ? `\n\n**接口输出说明：** ${exSteps.api.outputDesc}` : ''}`
              : (rr.status === 0 ? `❌ 无法连接【${sysName}】：${rr.text}` : `⚠️ 【${sysName}】未受理本次提交（HTTP ${rr.status}）：${(rr.text || '').slice(0, 160) || '（无响应体）'}`)
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
          const evType = executed ? actEvent : 'ExecutionFailed'
          await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: act.actionKey, eventType: evType, fromState: act.fromState, toState: executed ? actToState : act.fromState, riskLevel: actPolicy.risk || (needConfirm ? 'MEDIUM' : 'LOW'), note: executed ? `经读驱动消解定位「${chosen.text}」并在真实系统执行（${exSteps.kind === 'api' ? 'API 直调' : exSteps.kind === 'sop' ? 'SOP 智能体' : '录制回放'}）${opinion ? `；审批意见：${opinion}` : ''}` : '执行未完成' })
          sinkFocus({
            externalId, displayName: chosen.text,
            state: executed ? (actStateLabel || actToState) : stName(act.fromState) || act.fromState,
            fieldsJson: JSON.stringify(detailKv).slice(0, 4000),
            summary: `${act.label}：${executed ? '成功' : '未完成'}${opinion ? `（意见：${opinion.slice(0, 60)}）` : ''}`,
          })
          // 回复正文：只给业务人员一句话；技术细节进「本体执行」折叠区（ontology）
          const parts: OntologyDetailParts = {
            outcome: executed ? 'ok' : 'partial',
            headline: executed ? `已在【${sysName}】完成「${act.label}」` : `未完成「${act.label}」，未改动状态`,
            objectLabel: chosen.text, domain: r.domain, typeKey: r.objectType, typeLabel: t?.label || '', externalId, relations: relText,
            actionLabel: act.label, actionKey: act.actionKey, capability: act.capability,
            fromState: act.fromState, fromStateLabel: stName(act.fromState), toState: executed ? actToState : '', stateLabel: actStateLabel,
            executor: EXECUTOR_NAME[exSteps.kind], systemName: sysName,
            resolveNote: `从列表页真实读到 ${read.links.length} 个候选，${matchNote}`,
            detail: executed ? '' : outcome,
            fields: [
              ...detailKv.map(kv => ({ label: kv.label, value: kv.value })),
              ...(opinion ? [{ label: '审批意见', value: opinion }] : []),
            ],
            eventType: evType,
          }
          const plain = renderOntologyReply(parts)
          const detail = renderOntologyDetail(parts)
          await trace.submit(detail, executed ? 'SUCCESS' : 'PARTIAL', `本体 ${r.objectType}.${act.actionKey} 读驱动消解→${chosen.text}：${executed ? '执行' : '未完成'}。`)
          return { content: plain, ontology: detail, success: true, traceId: trace.id }
        }

        // ===== P1：绑定了连接器动作的写操作（无列表页/create 类）→ 抽取字段 + 人工确认（签名）+ 真实系统回放 =====
        if (isWrite && a.connectorActionId) {
          const summaryFields: VisitField[] = [
            { name: '_obj', label: '对象', value: r.displayName || r.objectType!, type: 'text' },
            { name: '_act', label: '动作', value: a.label, type: 'text' },
            { name: '_state', label: '状态迁移', value: `${stName(a.fromState) || a.fromState || '当前'} → ${stName(toState) || toState}`, type: 'text' },
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
          // 正文与详情卡由同一份 parts 产出——两者永不脱节。
          // 对象名一律用**业务名**（用户指名的 → 本体类型 label → 兜底才用 typeKey）：
          // 曾直接 `r.displayName || r.objectType`，新建类没有 displayName，于是把「TravelApproval」甩给用户看了。
          const parts: OntologyDetailParts = {
            outcome: executed ? 'ok' : 'partial',
            headline: executed
              ? `已在【${ex.systemName || '业务系统'}】完成「${a.label}」`
              : `未完成「${a.label}」，未改动状态`,
            objectLabel: objName, domain: r.domain, typeKey: r.objectType, typeLabel: t?.label || '', relations: relText,
            actionLabel: a.label, actionKey: a.actionKey, capability: a.capability,
            fromState: a.fromState, fromStateLabel: stName(a.fromState), toState: executed ? toState : '', stateLabel,
            executor: (ex.kind ? EXECUTOR_NAME[ex.kind] : '') || '连接器动作', systemName: ex.systemName,
            stepsDone: ex.stepsDone, stepsTotal: ex.stepsTotal,
            detail: executed ? '' : ex.outcome,
            fields: ex.fields.map(f => ({ label: f.label, value: ex.confirmed[f.name] || '' })),
            eventType: evType,
          }
          const plain = renderOntologyReply(parts)
          const detail = renderOntologyDetail(parts)
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
            { label: '状态迁移', value: `${stName(a.fromState) || a.fromState || '当前'} → ${stName(toState) || toState}` },
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
        const registerParts: OntologyDetailParts = {
          outcome: 'partial',
          headline: '已在本体登记状态迁移，但尚未写入真实系统',
          objectLabel: objName, domain: r.domain, typeKey: r.objectType, typeLabel: t?.label || '', relations: relText,
          actionLabel: a.label, actionKey: a.actionKey, capability: a.capability,
          fromState: a.fromState, fromStateLabel: stName(a.fromState), toState, stateLabel,
          executor: '语义登记（未绑定连接器动作）',
          detail: `该动作**未绑定连接器动作**，分身知道"该做什么"却不知道"怎么在系统里点"。请到管理端「本体建模 → 动作」为它绑定一个连接器动作（录制回放 / API 直调 / SOP 智能体），真实写入才会生效。`,
          eventType,
        }
        const plain = renderOntologyReply(registerParts)
        const detail = renderOntologyDetail(registerParts)
        await trace.submit(detail, 'SUCCESS', `本体动作 ${r.objectType}.${a.actionKey} 语义登记，事件 ${eventType}。`)
        return { content: plain, ontology: detail, success: true, traceId: trace.id }
      }
    } catch (e: any) { console.error('[ontology hook] err:', e?.message) }
  return null
}
