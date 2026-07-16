// 本体运行时（P0）：用户意图 → 解析对象+动作 → 确认策略 → 真实读取/回放 → 事件回写。
// 平台只存 Schema + 对象引用 + 业务事件；对象实例由此现查现用、留本地、绝不上传、绝不虚构。
// 纯搬迁自 main.ts，不改逻辑。真实读取/回放驱动业务系统，冒烟测不到，正确性需真实技能验证。
import { BrowserWindow, session } from 'electron'
import { extractFieldsByLabels, replayActionScript, runSopAgent } from './browser-automation'
import { afetch, getAdminBaseUrl } from './http'
import { type LlmConfig, callLlm } from './llm'
import { type SendLog, type VisitField, type RecStep } from './types'
import { type SystemInfo, type ConnectorActionDetail, type SkillDetail } from './agent-types'
import { sleep, swallow, checkDateOrder } from './util'
import { runningState, requestFormConfirmation } from './automation-runtime'
import {
  type OntologyActionHint, type OntologyTypeHint, type OntologyHints, type OntologyResolution,
  ontologyMightMatch, scopeHintsByDomains, buildOntologyPrompt, parseOntologyOutput,
} from './ontology-core'
import { extractRecSteps } from './rec-steps'
import { READ_DETAIL_FN } from './browser-scripts'

// ================= 本体运行时（P0：解析对象+动作 → 策略 → 事件回写）=================
// 平台只存 Schema + 对象引用 + 业务事件；对象实例由此现查现用、留本地、不上传。

// 本体提示（Schema 面）的类型与解析 prompt 统一由叶子模块 ontology-core 提供——
// 运行时与离线评测（scripts/eval-ontology.ts）共用同一套 prompt，杜绝"测试与执行两套逻辑"。
export type { OntologyActionHint, OntologyTypeHint, OntologyHints, OntologyResolution } from './ontology-core'

/** 业务事件回写载荷（平台只收 Schema/引用/事件，不含实例数据）。 */
export interface BusinessEventPayload {
  objectType?: string; objectRefId?: string; systemId?: string; actionKey?: string
  eventType: string; fromState?: string; toState?: string; riskLevel?: string; note?: string
}

let ontologyHintsCache: OntologyHints | null = null
let ontologyHintsAt = 0
export async function fetchOntologyHints(): Promise<OntologyHints> {
  if (ontologyHintsCache && Date.now() - ontologyHintsAt < 60000) return ontologyHintsCache
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/ontology/resolve-hints`)
    if (r.ok) { ontologyHintsCache = await r.json(); ontologyHintsAt = Date.now() }
  } catch (e) { swallow(e) }
  return ontologyHintsCache || { types: [], actions: [] }
}
// expertDomains：当前岗位的业务域侧重（管理端「岗位专家」配置）。有侧重时优先只用侧重域的本体提示，
// 让"生产计划岗说工单、销售岗说商机"各自命中；无侧重或侧重域无内容则退回全量。
// prompt 与解析都在 ontology-core（离线评测 eval:ontology 用的是同一套，改 prompt 后必须跑一遍）。
export async function resolveOntology(userMsg: string, cfg: LlmConfig, expertDomains?: string[]): Promise<{ res: OntologyResolution; action: OntologyActionHint | null; type: OntologyTypeHint | null }> {
  const none = { res: { matched: false } as OntologyResolution, action: null, type: null }
  const hints = scopeHintsByDomains(await fetchOntologyHints(), expertDomains)
  if (!hints.actions?.length || !ontologyMightMatch(userMsg, hints)) return none
  try {
    const out = await callLlm(buildOntologyPrompt(userMsg, hints, expertDomains), cfg)
    return parseOntologyOutput(out, hints)
  } catch (e) { swallow(e, 'ontology-resolve'); return none }
}
/** 同一对象类型上、从当前状态出发的其它写动作（如「审批通过」旁边的「驳回」）。
 *  审批卡要让人能改审批动作——但只有真的存在第二个动作时才给选，否则不该摆一个假的下拉。 */
export async function siblingWriteActions(domain: string | undefined, objectType: string | undefined, fromState: string | undefined): Promise<OntologyActionHint[]> {
  const hints = await fetchOntologyHints()
  return (hints.actions || []).filter(x =>
    x.domain === domain && x.objectType === objectType &&
    x.capability && x.capability !== 'read' &&
    (x.fromState || '') === (fromState || '') &&
    !!x.connectorActionId)      // 没绑连接器的动作执行不了，不该出现在选项里
}

export function ontologyNeedsConfirm(action: OntologyActionHint | null | undefined, amount?: number | null): boolean {
  try {
    const p = action?.policyJson ? JSON.parse(action.policyJson) : {}
    if (p.confirmIf === 'always') return true
    if (typeof p.confirmIf === 'string') {
      const mm = p.confirmIf.match(/amount\s*>\s*(\d+)/)
      if (mm && amount != null) return Number(amount) > Number(mm[1])
    }
    if (p.auto === false) return true
    return false
  } catch (_) { return false }
}
export async function recordObjectRef(objectType: string, systemId: string, externalId: string, displayName: string, currentState: string): Promise<string> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/ontology/object-refs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectType, systemId, externalId, displayName, currentState })
    })
    if (r.ok) { const d = await r.json(); return d.id || '' }
  } catch (e) { swallow(e) }
  return ''
}
export async function recordBusinessEvent(ev: BusinessEventPayload): Promise<void> {
  try {
    await afetch(`${getAdminBaseUrl()}/api/v1/ontology/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev)
    })
  } catch (e) { swallow(e) }
}
export function buildOntologyGraphText(type: OntologyTypeHint, res: OntologyResolution, toState: string): string {
  try {
    const rels = type.relationsJson ? JSON.parse(type.relationsJson) : []
    let s = '```\n' + `${type.typeKey}: ${res.displayName || ''}  [${toState}]\n`
    for (const r of rels) s += `  └─ ${r.name} → ${r.targetType}\n`
    return s + '```'
  } catch (_) { return '' }
}

// ===== P1·B 读驱动消解：从对象列表页抓取候选对象（身份来自真实系统，不由录制写死）=====
interface OntologyCandidate { text: string; href: string; rowText?: string; inTable?: boolean }
export async function browseAndExtractLinks(systemId: string, url: string, sendLog: SendLog): Promise<{ ok: boolean; loggedIn: boolean; links: OntologyCandidate[]; error?: string }> {
  return new Promise((resolve) => {
    sendLog('observing', `读取候选对象列表：${url}`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const done = (r: any) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve(r) }
    const run = async () => {
      try {
        await sleep(2500)
        const info = await win.webContents.executeJavaScript(`(function(){
          var txt = document.body ? document.body.innerText : '';
          var loginLike = txt.length < 400 && /(登录|登陆|login|sign in|密码|password|账号)/i.test(txt.toLowerCase());
          var out = [], seen = {};
          var as = document.querySelectorAll('a[href]');
          for (var i = 0; i < as.length; i++){ var a = as[i]; var t = (a.innerText||'').trim(); if (!t || t.length < 2) continue; if (seen[t]) continue; seen[t] = 1;
            // 排除导航/菜单/页眉页脚里的链接——它们是站点骨架，不是业务对象候选（否则「退出/门户首页/合同台账…」会混进指认下拉）
            if (a.closest && a.closest('nav, aside, header, footer, .menu, .sidebar, .nav, .tabbar, [role="navigation"], [role="menu"]')) continue;
            var row = a.closest ? a.closest('tr, li, .row, .card, .item') : null;
            var rowText = row ? (row.innerText||'').replace(/\\s+/g,' ').trim() : t;
            out.push({ text: t, href: a.href, rowText: rowText, inTable: !!(a.closest && a.closest('table, .list, .table')) }); }
          return { loginLike: !!loginLike, links: out };
        })()`)
        if (info.loginLike) { done({ ok: true, loggedIn: false, links: [] }); return }
        done({ ok: true, loggedIn: true, links: info.links || [] })
      } catch (e: any) { done({ ok: false, loggedIn: false, links: [], error: e?.message }) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, c, d) => done({ ok: false, loggedIn: false, links: [], error: `加载失败(${c}):${d}` }))
    win.loadURL(url).catch(() => {})
    setTimeout(() => done({ ok: false, loggedIn: false, links: [], error: '页面加载超时（30秒）' }), 30000)
  })
}
/** 读取单据详情页的键值对——审批前把**真实单据内容**摆给人看（只读）。读不到就返回空，绝不编。 */
export async function readObjectDetail(systemId: string, url: string, sendLog: SendLog): Promise<{ label: string; value: string }[]> {
  return new Promise((resolve) => {
    sendLog('observing', `读取单据详情：${url}`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const done = (r: { label: string; value: string }[]) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve(r) }
    win.webContents.once('did-finish-load', async () => {
      try { await sleep(1500); done(await win.webContents.executeJavaScript(`(${READ_DETAIL_FN})()`) || []) }
      catch (e) { swallow(e, 'read-detail'); done([]) }
    })
    win.webContents.once('did-fail-load', () => done([]))
    win.loadURL(url).catch(() => {})
    setTimeout(() => done([]), 20000)
  })
}

// 用「本体解析出的对象名 + 金额 + 原始指令」在候选里匹配。
// 先按名字关键词命中；若指令带了金额，再用金额（同行文本里的金额列）把同名的进一步收敛到唯一。
export function matchOntologyCandidates(cands: OntologyCandidate[], displayName: string, userMsg: string, amount?: number | null): OntologyCandidate[] {
  // ⚠️ 两个血泪坑，都在这里踩过：
  //   ① **只看链接文字**：差旅列表里链接文字是「目的地」（"上海 · 宝钢集团"），申请人「王磊」在另一列。
  //      用户说"审批下王磊的差旅"→ 明明列表里就有那条，却报"没找到王磊"。业务对象的名字/申请人/单号
  //      **可能出现在任何一列**，必须拿**整行文本**当草垛。
  //   ② **strip() 剥掉了数字**：单号 CL-2026-0007 被剥成 "CL--"，于是按单号点名永远匹配不上。
  //      单号必须走独立通道，不能和中文名共用一套清洗规则。
  const norm = (x: string) => (x || '').replace(/\s/g, '')
  const hay = (c: OntologyCandidate) => norm(`${c.text || ''}${c.rowText || ''}`)   // 整行都算

  // ① 单号/编号优先（形如 CL-2026-0007 / HT-2026-0028 / PO_2026_0115）——最精确，命中即返回。
  //    正则要求**字母打头**，避免把日期 2026-07-08 当成单号。
  const ID_RE = /[A-Za-z]{1,6}[-_]?\d{4}[-_]\d{2,6}/
  const idm = (displayName || '').match(ID_RE) || (userMsg || '').match(ID_RE)
  if (idm) {
    const id = norm(idm[0]).toUpperCase()
    const byId = cands.filter(c => (hay(c) + norm(c.href || '')).toUpperCase().includes(id))
    if (byId.length) return byId
  }

  // ② 名字/关键词：清洗掉纯修饰词与数字后取探针
  const strip = (x: string) => (x || '').replace(/[0-9\s]/g, '').replace(/(万元|万|元|合同|审批|商机|客户|拜访|记录|的|那个|个|服务|采购|项目|平台|系统|建设|升级)/g, '')
  const key = strip(displayName)
  const msgKey = strip(userMsg)
  const probe = key || msgKey
  let hit: OntologyCandidate[] = []
  if (probe && probe.length >= 2) hit = cands.filter(c => hay(c).includes(probe))

  // ③ 整串没命中时按「二字窗口」打分（"王磊差旅" → 王磊/磊差/差旅）：
  //    取命中窗口最多的那些行。**不写死任何领域词**——"王磊"只命中王磊那行，"差旅"两行都命中，
  //    所以王磊那行得 2 分胜出。比"整串包含"宽容，又比"命中任一窗口"精确。
  if (!hit.length && probe.length >= 2) {
    const wins: string[] = []
    for (let i = 0; i + 1 < probe.length; i++) wins.push(probe.slice(i, i + 2))
    const scored = cands.map(c => { const h = hay(c); return { c, n: wins.filter(w => h.includes(w)).length } })
    const best = Math.max(0, ...scored.map(x => x.n))
    if (best > 0) hit = scored.filter(x => x.n === best).map(x => x.c)
  }

  // ④ 反向包含兜底：候选名整个出现在用户话里（"审批宝钢钢铁数字化项目采购合同"）
  if (!hit.length) hit = cands.filter(c => { const tk = strip(c.text); return tk.length >= 2 && msgKey.includes(tk) })

  // ⑤ 金额收敛：指令里给了金额时，用同行文本中的金额把同名候选筛到唯一
  if (hit.length > 1 && amount != null && Number(amount) > 0) {
    const n = Number(amount)
    const variants = [
      n.toLocaleString('en-US'),                  // 60,000,000
      String(n),                                  // 60000000
      (n % 10000 === 0 ? (n / 10000) + '万' : ''), // 6000万
    ].filter(Boolean) as string[]
    const byAmount = hit.filter(c => { const rt = norm(c.rowText || c.text || ''); return variants.some(v => rt.includes(norm(v))) })
    if (byAmount.length) return byAmount
  }
  return hit
}
// ===== 双形态执行器：API 接口直调（与录制回放并列的另一条执行通道） =====
export interface ExecutorApi { method: string; path: string; bodyTemplate: string; outputDesc: string }
const fillTpl = (tpl: string, vars: Record<string, string>) =>
  // 变量键含中文，勿用 \w（\w 只含 ASCII，中文占位会漏替换）
  (tpl || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, k) => vars[k] !== undefined ? String(vars[k]) : '')

/** HTTP 状态码 → 业务人话。裸状态码对业务人员毫无意义，而 302 还会被误读成失败
 *  （传统系统写接口提交成功后几乎都回 302 跳详情页——那恰恰是成功的标志）。 */
function httpMeaning(status: number): string {
  if (status === 302 || status === 303 || status === 301) return '业务系统已受理并跳转到详情页（提交成功）'
  if (status >= 200 && status < 300) return '业务系统已受理（提交成功）'
  if (status === 401 || status === 403) return '业务系统拒绝：登录态失效或无权限'
  if (status === 404) return '业务系统找不到该接口或该单据'
  if (status === 400 || status === 422) return '业务系统认为提交的数据不合法'
  if (status >= 500) return '业务系统内部错误'
  if (status === 0) return '无法连接业务系统'
  return '业务系统返回了未预期的结果'
}

/** 用系统分区里的登录 cookie 直调业务系统 API（登录态只在本地分区，绝不上传）。302/2xx 视为成功。 */
export async function callSystemApi(systemId: string, baseUrl: string, api: ExecutorApi, vars: Record<string, string>, sendLog: SendLog): Promise<{ ok: boolean; status: number; text: string }> {
  const url = baseUrl.replace(/\/$/, '') + fillTpl(api.path, vars)
  const body = fillTpl(api.bodyTemplate || '', vars)
  const method = (api.method || 'POST').toUpperCase()
  let cookieHeader = ''
  try {
    const cookies = await session.fromPartition(`persist:bizsys-${systemId}`).cookies.get({ url: baseUrl })
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  } catch (e) { swallow(e, 'api-cookies') }
  const isJson = body.trim().startsWith('{') || body.trim().startsWith('[')
  // 执行日志是**给业务人员看的**：先说在干什么，技术细节（方法/地址/状态码）放到括号里。
  // 演示时客户看到裸的「HTTP 302」只会以为出错了——302 恰恰是成功（传统系统提交后跳详情页）。
  sendLog('acting', `正在向业务系统提交…（${method} ${url}）`)
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',   // 传统系统写接口常回 302 跳详情页——视为成功，不跟随
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(method !== 'GET' && body ? { 'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method !== 'GET' && body ? { body } : {}),
    })
    const ok = res.status >= 200 && res.status < 400
    let text = ''
    try { text = (await res.text()).slice(0, 800) } catch (e) { swallow(e) }
    sendLog('observing', `${ok ? '✅ ' : '❌ '}${httpMeaning(res.status)}（HTTP ${res.status}）`)
    return { ok, status: res.status, text }
  } catch (e: any) {
    return { ok: false, status: 0, text: String(e?.message || e) }
  }
}

export async function loadExecutorSteps(executorId: string): Promise<{ found: boolean; steps: RecStep[]; fieldDefs: VisitField[]; systemId: string; kind: 'replay' | 'api' | 'sop'; api?: ExecutorApi; sop?: string; entryHash?: string }> {
  let steps: RecStep[] = [], fieldDefs: VisitField[] = [], systemId = '', found = false
  let kind: 'replay' | 'api' | 'sop' = 'replay'
  let api: ExecutorApi | undefined
  let sop = '', entryHash = ''
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/connector-actions/${executorId}`)
    if (r.ok) { const ca = await r.json() as ConnectorActionDetail; found = true; systemId = ca.systemId || ''
      if (ca.kind === 'api') { kind = 'api'; api = { method: ca.apiMethod || 'POST', path: ca.apiPath || '', bodyTemplate: ca.apiBodyTemplate || '', outputDesc: ca.outputDesc || '' } }
      else if (ca.kind === 'sop') { kind = 'sop'; sop = ca.sopHint || ''; entryHash = ca.entryHash || '' }
      try { steps = extractRecSteps(JSON.parse(ca.stepsJson || '[]')) } catch (e) { swallow(e) }
      try { const f = JSON.parse(ca.fieldsJson || '[]'); const arr = Array.isArray(f) ? f : (f.fields || []); fieldDefs = arr.map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  if (!found) {
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${executorId}`)
      if (r.ok) { const sk = await r.json() as SkillDetail; found = true; systemId = sk.targetSystemId || ''
        try { const p = JSON.parse(sk.actionScript || '{}'); steps = extractRecSteps(p); fieldDefs = (Array.isArray(p.fields) ? p.fields : []).map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
      }
    } catch (e) { swallow(e) }
  }
  return { found, steps, fieldDefs, systemId, kind, api, sop, entryHash }
}
export async function resolveSystemBaseUrl(systemId: string): Promise<{ sysName: string; baseUrl: string }> {
  let sysName = '业务系统', baseUrl = ''
  try {
    const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (ir.ok) { const list = await ir.json() as SystemInfo[]; const sys = Array.isArray(list) ? list.find((x) => x.id === systemId) : null; if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl } }
  } catch (e) { swallow(e) }
  return { sysName, baseUrl }
}

// P1：执行绑定到本体动作的「连接器动作」——抽取字段 → 人工确认（签名）→ 对真实系统回放。
// 复用现有 extractFieldsByLabels / requestFormConfirmation / replayActionScript，不另造执行引擎。
// 执行结果 + 供「本体执行」详情卡渲染的元信息（执行形态/系统/步数）——
// 卡片要说清"怎么做到的"（录制回放 11/11 步 / API 直调 / SOP 智能体），不能只给一句"成功了"。
export interface OntologyExecResult {
  status: 'ok' | 'notLoggedIn' | 'noSystem' | 'noSteps' | 'notFound' | 'fail' | 'partial' | 'cancelled'
  outcome: string; confirmed: Record<string, string>; fields: VisitField[]
  kind?: 'replay' | 'api' | 'sop'; systemName?: string; stepsDone?: number; stepsTotal?: number
}
export async function executeOntologyConnectorAction(executorId: string, userMsg: string, cfg: LlmConfig, sendLog: SendLog, requireConfirm?: boolean, summaryFields?: VisitField[]): Promise<OntologyExecResult> {
  const empty = { confirmed: {}, fields: [] as VisitField[] }
  // 绑定的执行器既可能是「连接器动作」（replay/api 双形态）也可能是 FDE 录制上架的「技能」（含 actionScript）。
  let steps: RecStep[] = []
  let fieldDefs: VisitField[] = []
  let systemId = ''
  let found = false
  let kind: 'replay' | 'api' | 'sop' = 'replay'
  let api: ExecutorApi | undefined
  let sop = '', entryHash = ''
  // ① 连接器动作
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/connector-actions/${executorId}`)
    if (r.ok) {
      const ca = await r.json() as ConnectorActionDetail
      found = true; systemId = ca.systemId || ''
      if (ca.kind === 'api') { kind = 'api'; api = { method: ca.apiMethod || 'POST', path: ca.apiPath || '', bodyTemplate: ca.apiBodyTemplate || '', outputDesc: ca.outputDesc || '' } }
      else if (ca.kind === 'sop') { kind = 'sop'; sop = ca.sopHint || ''; entryHash = ca.entryHash || '' }
      try { steps = extractRecSteps(JSON.parse(ca.stepsJson || '[]')) } catch (e) { swallow(e) }
      try { const f = JSON.parse(ca.fieldsJson || '[]'); const arr = Array.isArray(f) ? f : (f.fields || []); fieldDefs = arr.map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  // ② 技能（FDE 录制上架的产物：actionScript = {rawSteps|steps, fields}）
  if (!found) {
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${executorId}`)
      if (r.ok) {
        const sk = await r.json() as SkillDetail
        found = true; systemId = sk.targetSystemId || ''
        try { const p = JSON.parse(sk.actionScript || '{}'); steps = extractRecSteps(p); fieldDefs = (Array.isArray(p.fields) ? p.fields : []).map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
      }
    } catch (e) { swallow(e) }
  }
  if (!found) return { status: 'notFound', outcome: '绑定的执行器（连接器动作/技能）不存在或不可读。', ...empty }
  if (kind === 'replay' && !steps.length) return { status: 'noSteps', outcome: '该执行器没有可回放的录制步骤。', ...empty }
  if (kind === 'api' && !(api && api.path)) return { status: 'noSteps', outcome: '该 API 执行器未配置路径（到 FDE「系统连接 → 连接器动作」补全）。', ...empty }
  if (kind === 'sop' && !sop.trim()) return { status: 'noSteps', outcome: '该 SOP 智能体动作未填写标准流程描述（到 FDE「系统连接 → 连接器动作」补全）。', ...empty }

  // 解析绑定系统地址
  let sysName = '业务系统', baseUrl = ''
  try {
    const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (ir.ok) { const list = await ir.json() as SystemInfo[]; const sys = Array.isArray(list) ? list.find((x) => x.id === systemId) : null; if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl } }
  } catch (e) { swallow(e) }
  if (!baseUrl) baseUrl = steps[0]?.url || ''
  if (!baseUrl) return { status: 'noSystem', outcome: '该执行器未绑定可访问的业务系统地址。', confirmed: {}, fields: fieldDefs, kind }

  // 抽取字段值 → 人工确认（签名）；无表单字段但策略要求确认时，也弹一次摘要确认（人工签名闸不被跳过）
  const filled = fieldDefs.length ? await extractFieldsByLabels(userMsg, fieldDefs, cfg, sendLog) : []
  let confirmed: Record<string, string> = {}
  if (filled.length) {
    sendLog('acting', '已整理出待写入字段，请在下方表单核对并确认（人工签名）…')
    confirmed = await requestFormConfirmation(filled)
    if (!confirmed || Object.keys(confirmed).length === 0) return { status: 'cancelled', outcome: '🚫 已取消，未写入任何数据。', confirmed: {}, fields: filled, kind, systemName: sysName }
  } else if (requireConfirm) {
    sendLog('acting', '该动作命中确认策略：请你人工确认（签名）后执行…')
    const rc = await requestFormConfirmation(summaryFields && summaryFields.length ? summaryFields : [{ name: 'confirm', label: '确认执行', value: '是', type: 'text' }])
    if (!rc || Object.keys(rc).length === 0) return { status: 'cancelled', outcome: '🚫 已取消该操作，未执行、未改动状态。', confirmed: {}, fields: [] }
  }

  if (runningState.aborted) return { status: 'cancelled', outcome: '🚫 已终止，未写入任何数据。', confirmed: {}, fields: filled, kind, systemName: sysName }
  // 写操作最后一道代码闸：日期不自洽就**不提交**。宁可退回让人改，也不往业务系统里写荒唐单据。
  const badDate = checkDateOrder(filled, confirmed)
  if (badDate) {
    return {
      status: 'partial', confirmed, fields: filled, kind, systemName: sysName,
      outcome: `⚠️ **日期不自洽，已中止提交**：${badDate}。\n\n未向【${sysName}】写入任何数据。请把日期说清楚（或在表单里改正）后重试。`,
    }
  }

  // ===== API 形态：确认后的字段值填入路径/请求体占位，带本地登录 cookie 直调接口 =====
  if (kind === 'api' && api) {
    const r = await callSystemApi(systemId, baseUrl, api, confirmed, sendLog)
    if (!r.ok && r.status === 0) return { status: 'fail', outcome: `❌ 无法连接【${sysName}】：${r.text}`, confirmed, fields: filled, kind, systemName: sysName }
    if (!r.ok) return { status: 'partial', outcome: `⚠️ ${httpMeaning(r.status)}（【${sysName}】· HTTP ${r.status}）${r.text.slice(0, 160) ? `：${r.text.slice(0, 160)}` : ''}`, confirmed, fields: filled, kind, systemName: sysName }
    return { status: 'ok', outcome: `🤖 已在【${sysName}】完成写入，${httpMeaning(r.status)}。${api.outputDesc ? `\n\n**接口输出说明：** ${api.outputDesc}` : ''}`, confirmed, fields: filled, kind, systemName: sysName }
  }

  // ===== SOP 智能体形态：确认后的字段值 + SOP 描述，智能体读实时页面逐步执行（免录制）=====
  if (kind === 'sop') {
    const sopEntry = entryHash ? baseUrl.replace(/\/$/, '') + entryHash : baseUrl
    const r = await runSopAgent(systemId || 'onto', sopEntry, sysName, sop, confirmed, sendLog, cfg)
    if (!r.ok) return { status: 'fail', outcome: `❌ SOP 智能体访问【${sysName}】失败：${r.error || '未知错误'}。`, confirmed, fields: filled, kind, systemName: sysName }
    if (!r.loggedIn) return { status: 'notLoggedIn', outcome: `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`, confirmed, fields: filled, kind, systemName: sysName }
    if (r.failedAt >= 0) return { status: 'partial', outcome: `SOP 智能体在【${sysName}】执行 ${r.done} 步后中断：${r.failLabel}。可到系统核实，或改用录制回放。`, confirmed, fields: filled, kind, systemName: sysName }
    return { status: 'ok', outcome: `🤖 已由 SOP 智能体在【${sysName}】完成操作（执行 ${r.done} 步）。`, confirmed, fields: filled, kind, systemName: sysName, stepsDone: r.done, stepsTotal: r.done }
  }

  const fieldByStep: Record<number, string> = {}
  steps.forEach((s: any, i: number) => { const fn = s.param || s.fieldName; if (fn) fieldByStep[i] = fn })
  // create/填表类：录制步骤第一步带了页面 URL 时，直接从该表单页开始回放（导航由此代劳）
  const entryUrl = (steps[0]?.url && /^https?:/i.test(steps[0].url)) ? steps[0].url : baseUrl
  const rep = await replayActionScript(systemId || 'onto', entryUrl, sysName, steps, confirmed, fieldByStep, sendLog)
  if (!rep.ok) return { status: 'fail', outcome: `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`, confirmed, fields: filled, kind, systemName: sysName }
  if (!rep.loggedIn) return { status: 'notLoggedIn', outcome: `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`, confirmed, fields: filled, kind, systemName: sysName }
  if (rep.failedAt >= 0) return { status: 'partial', outcome: `已回放前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」中断（${rep.error || '元素未找到'}）。`, confirmed, fields: filled, kind, systemName: sysName, stepsDone: rep.done, stepsTotal: rep.total }
  return { status: 'ok', outcome: `🤖 已在【${sysName}】完整回放 ${rep.done}/${rep.total} 步，完成写入。`, confirmed, fields: filled, kind, systemName: sysName, stepsDone: rep.done, stepsTotal: rep.total }
}
