// 本体运行时（P0）：用户意图 → 解析对象+动作 → 确认策略 → 真实读取/回放 → 事件回写。
// 平台只存 Schema + 对象引用 + 业务事件；对象实例由此现查现用、留本地、绝不上传、绝不虚构。
// 纯搬迁自 main.ts，不改逻辑。真实读取/回放驱动业务系统，冒烟测不到，正确性需真实技能验证。
import { BrowserWindow, session } from 'electron'
import { extractFieldsByLabels, replayActionScript } from './browser-automation'
import { afetch, getAdminBaseUrl } from './http'
import { type LlmConfig, callLlm } from './llm'
import { type SendLog, type VisitField, type RecStep } from './types'
import { type SystemInfo, type ConnectorActionDetail, type SkillDetail } from './agent-types'
import { sleep, swallow } from './util'
import { runningState, requestFormConfirmation } from './automation-runtime'

// ================= 本体运行时（P0：解析对象+动作 → 策略 → 事件回写）=================
// 平台只存 Schema + 对象引用 + 业务事件；对象实例由此现查现用、留本地、不上传。

// 管理端 resolve-hints 下发的本体提示（Schema 面）。索引签名兼容后端 Schema 演进：
// 新增字段不需要客户端发版，但已知字段有类型保护。
export interface OntologyActionHint {
  actionKey: string; label: string; domain?: string; objectType?: string
  description?: string; capability?: string; policyJson?: string
  fromState?: string; toState?: string; connectorActionId?: string
  [k: string]: unknown
}
export interface OntologyTypeHint {
  typeKey: string; label: string; domain?: string
  relationsJson?: string; stateMachineJson?: string; resolveListPath?: string
  boundSystemId?: string
  [k: string]: unknown
}
/** 业务事件回写载荷（平台只收 Schema/引用/事件，不含实例数据）。 */
export interface BusinessEventPayload {
  objectType?: string; objectRefId?: string; systemId?: string; actionKey?: string
  eventType: string; fromState?: string; toState?: string; riskLevel?: string; note?: string
}
interface OntologyHints { types: OntologyTypeHint[]; actions: OntologyActionHint[] }

let ontologyHintsCache: OntologyHints | null = null
let ontologyHintsAt = 0
async function fetchOntologyHints(): Promise<OntologyHints> {
  if (ontologyHintsCache && Date.now() - ontologyHintsAt < 60000) return ontologyHintsCache
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/ontology/resolve-hints`)
    if (r.ok) { ontologyHintsCache = await r.json(); ontologyHintsAt = Date.now() }
  } catch (e) { swallow(e) }
  return ontologyHintsCache || { types: [], actions: [] }
}
interface OntologyResolution {
  matched: boolean; domain?: string; objectType?: string; actionKey?: string
  displayName?: string; externalId?: string; amount?: number | null; reason?: string
}
// 便宜的预门：指令里没有任何本体标签/关键动词就直接跳过 LLM 解析，避免拖慢普通对话
function ontologyMightMatch(userMsg: string, hints: OntologyHints): boolean {
  const words = new Set<string>(['审批', '通过', '驳回', '拜访', '录入', '商机', '推进', '风险', '合同', '赢单'])
  for (const t of hints.types || []) if (t.label) words.add(t.label)
  for (const a of hints.actions || []) if (a.label) words.add(a.label)
  for (const w of words) if (w && userMsg.includes(w)) return true
  return false
}
// expertDomains：当前岗位的业务域侧重（管理端「岗位专家」配置）。有侧重时优先只用侧重域的本体提示，
// 让"生产计划岗说工单、销售岗说商机"各自命中；无侧重或侧重域无内容则退回全量。
export async function resolveOntology(userMsg: string, cfg: LlmConfig, expertDomains?: string[]): Promise<{ res: OntologyResolution; action: OntologyActionHint | null; type: OntologyTypeHint | null }> {
  const none = { res: { matched: false } as OntologyResolution, action: null, type: null }
  const all = await fetchOntologyHints()
  let hints = all
  if (expertDomains && expertDomains.length) {
    const scoped = {
      types: (all.types || []).filter(t => t.domain && expertDomains.includes(t.domain)),
      actions: (all.actions || []).filter(a => a.domain && expertDomains.includes(a.domain)),
    }
    if (scoped.actions.length) hints = scoped
  }
  if (!hints.actions?.length || !ontologyMightMatch(userMsg, hints)) return none
  const typeList = hints.types.map(t => {
    let rel = ''
    try { const rs = t.relationsJson ? JSON.parse(t.relationsJson) : []; rel = rs.map((r: any) => `${r.name}→${r.targetType}`).join(',') } catch (e) { swallow(e) }
    return `- domain=${t.domain} objectType=${t.typeKey} 标签=${t.label}${rel ? ' 关系=' + rel : ''}`
  }).join('\n')
  // 动作目录带 description——语料由 FDE 建模时维护在本体动作描述里（数据驱动，不在代码里写死领域示例）
  const actionList = hints.actions.map(a =>
    `- domain=${a.domain} objectType=${a.objectType} actionKey=${a.actionKey} 标签=${a.label} 能力=${a.capability}${a.description ? ` 说明=${String(a.description).replace(/\s+/g, ' ').slice(0, 80)}` : ''}`).join('\n')
  const domainLine = expertDomains && expertDomains.length ? `\n当前岗位业务域侧重：${expertDomains.join('、')}（优先在该域内匹配）。` : ''
  const prompt = `你是企业本体解析器。\n【对象类型】\n${typeList}\n\n【对象动作】\n${actionList}\n${domainLine}\n用户指令："${userMsg}"\n\n判断该指令是否明确对应上面某一个对象动作。注意：\n- 用户常用关联对象指代动作——"审批合同"是对合同关联的审批任务(ApprovalTask)执行 approve。\n- 用户也常用「对象的名字/编号 + 类型词 + 动作词」表达（如"把〈产品名〉工单〈动作〉""把〈零件名〉〈动作〉""把〈单号〉〈动作〉"）——结合动作的标签与说明理解对应关系。\n- displayName 抽指令里的对象名：客户/合同/商机/产品/零件名或单号（如 PO-2026-0115 / WO-2026-0301）。\n只输出 JSON（不要任何解释）：\n{"matched":true或false,"domain":"","objectType":"该动作所属的 objectType","actionKey":"","displayName":"","amount":金额数字或null,"reason":"一句话理由"}\nmatched=true 仅当明确对应某 actionKey；objectType 必须填动作真正所属的类型；amount 抽取金额(元)否则 null。`
  try {
    const out = await callLlm(prompt, cfg)
    const m = out.match(/\{[\s\S]*\}/)
    const res: OntologyResolution = m ? JSON.parse(m[0]) : { matched: false }
    if (!res.matched) return none
    const action = hints.actions.find(a => a.domain === res.domain && a.objectType === res.objectType && a.actionKey === res.actionKey) || null
    if (!action) return none
    const type = hints.types.find(t => t.domain === res.domain && t.typeKey === res.objectType) || null
    return { res, action, type }
  } catch (_) { return none }
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
// 用「本体解析出的对象名 + 金额 + 原始指令」在候选里匹配。
// 先按名字关键词命中；若指令带了金额，再用金额（同行文本里的金额列）把同名的进一步收敛到唯一。
export function matchOntologyCandidates(cands: OntologyCandidate[], displayName: string, userMsg: string, amount?: number | null): OntologyCandidate[] {
  const strip = (s: string) => (s || '').replace(/[0-9\s]/g, '').replace(/(万元|万|元|合同|审批|商机|客户|拜访|记录|的|那个|个|服务|采购|项目|平台|系统|建设|升级)/g, '')
  const key = strip(displayName)
  const msgKey = strip(userMsg)
  const probe = key || msgKey
  let hit: OntologyCandidate[] = []
  if (probe && probe.length >= 2) {
    hit = cands.filter(c => (c.text || '').replace(/\s/g, '').includes(probe))
  }
  if (!hit.length) hit = cands.filter(c => { const tk = strip(c.text); return tk.length >= 2 && msgKey.includes(tk) })
  // 金额收敛：指令里给了金额时，用同行文本中的金额把同名候选筛到唯一
  if (hit.length > 1 && amount != null && Number(amount) > 0) {
    const n = Number(amount)
    const variants = [
      n.toLocaleString('en-US'),                 // 60,000,000
      String(n),                                  // 60000000
      (n % 10000 === 0 ? (n / 10000) + '万' : ''), // 6000万
    ].filter(Boolean) as string[]
    const byAmount = hit.filter(c => { const rt = (c.rowText || c.text || '').replace(/\s/g, ''); return variants.some(v => rt.includes(v.replace(/\s/g, ''))) })
    if (byAmount.length) return byAmount
  }
  return hit
}
// ===== 双形态执行器：API 接口直调（与录制回放并列的另一条执行通道） =====
export interface ExecutorApi { method: string; path: string; bodyTemplate: string; outputDesc: string }
const fillTpl = (tpl: string, vars: Record<string, string>) =>
  (tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => vars[k] !== undefined ? String(vars[k]) : '')

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
  sendLog('acting', `[API 直调] ${method} ${url}`)
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
    sendLog(ok ? 'observing' : 'observing', `[API 直调] HTTP ${res.status}${ok ? '' : ' · 失败'}`)
    return { ok, status: res.status, text }
  } catch (e: any) {
    return { ok: false, status: 0, text: String(e?.message || e) }
  }
}

export async function loadExecutorSteps(executorId: string): Promise<{ found: boolean; steps: RecStep[]; fieldDefs: VisitField[]; systemId: string; kind: 'replay' | 'api'; api?: ExecutorApi }> {
  let steps: RecStep[] = [], fieldDefs: VisitField[] = [], systemId = '', found = false
  let kind: 'replay' | 'api' = 'replay'
  let api: ExecutorApi | undefined
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/connector-actions/${executorId}`)
    if (r.ok) { const ca = await r.json() as ConnectorActionDetail; found = true; systemId = ca.systemId || ''
      if (ca.kind === 'api') { kind = 'api'; api = { method: ca.apiMethod || 'POST', path: ca.apiPath || '', bodyTemplate: ca.apiBodyTemplate || '', outputDesc: ca.outputDesc || '' } }
      try { const s = JSON.parse(ca.stepsJson || '[]'); steps = Array.isArray(s) ? s : (s.steps || s.rawSteps || []) } catch (e) { swallow(e) }
      try { const f = JSON.parse(ca.fieldsJson || '[]'); const arr = Array.isArray(f) ? f : (f.fields || []); fieldDefs = arr.map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  if (!found) {
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${executorId}`)
      if (r.ok) { const sk = await r.json() as SkillDetail; found = true; systemId = sk.targetSystemId || ''
        try { const p = JSON.parse(sk.actionScript || '{}'); steps = (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.steps) ? p.steps : [])); fieldDefs = (Array.isArray(p.fields) ? p.fields : []).map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
      }
    } catch (e) { swallow(e) }
  }
  return { found, steps, fieldDefs, systemId, kind, api }
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
interface OntologyExecResult { status: 'ok' | 'notLoggedIn' | 'noSystem' | 'noSteps' | 'notFound' | 'fail' | 'partial' | 'cancelled'; outcome: string; confirmed: Record<string, string>; fields: VisitField[] }
export async function executeOntologyConnectorAction(executorId: string, userMsg: string, cfg: LlmConfig, sendLog: SendLog, requireConfirm?: boolean, summaryFields?: VisitField[]): Promise<OntologyExecResult> {
  const empty = { confirmed: {}, fields: [] as VisitField[] }
  // 绑定的执行器既可能是「连接器动作」（replay/api 双形态）也可能是 FDE 录制上架的「技能」（含 actionScript）。
  let steps: RecStep[] = []
  let fieldDefs: VisitField[] = []
  let systemId = ''
  let found = false
  let kind: 'replay' | 'api' = 'replay'
  let api: ExecutorApi | undefined
  // ① 连接器动作
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/connector-actions/${executorId}`)
    if (r.ok) {
      const ca = await r.json() as ConnectorActionDetail
      found = true; systemId = ca.systemId || ''
      if (ca.kind === 'api') { kind = 'api'; api = { method: ca.apiMethod || 'POST', path: ca.apiPath || '', bodyTemplate: ca.apiBodyTemplate || '', outputDesc: ca.outputDesc || '' } }
      try { const s = JSON.parse(ca.stepsJson || '[]'); steps = Array.isArray(s) ? s : (s.steps || s.rawSteps || []) } catch (e) { swallow(e) }
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
        try { const p = JSON.parse(sk.actionScript || '{}'); steps = (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.steps) ? p.steps : [])); fieldDefs = (Array.isArray(p.fields) ? p.fields : []).map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
      }
    } catch (e) { swallow(e) }
  }
  if (!found) return { status: 'notFound', outcome: '绑定的执行器（连接器动作/技能）不存在或不可读。', ...empty }
  if (kind !== 'api' && !steps.length) return { status: 'noSteps', outcome: '该执行器没有可回放的录制步骤。', ...empty }
  if (kind === 'api' && !(api && api.path)) return { status: 'noSteps', outcome: '该 API 执行器未配置路径（到 FDE「系统连接 → 连接器动作」补全）。', ...empty }

  // 解析绑定系统地址
  let sysName = '业务系统', baseUrl = ''
  try {
    const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (ir.ok) { const list = await ir.json() as SystemInfo[]; const sys = Array.isArray(list) ? list.find((x) => x.id === systemId) : null; if (sys) { sysName = sys.name ?? sysName; baseUrl = sys.baseUrl ?? baseUrl } }
  } catch (e) { swallow(e) }
  if (!baseUrl) baseUrl = steps[0]?.url || ''
  if (!baseUrl) return { status: 'noSystem', outcome: '该执行器未绑定可访问的业务系统地址。', confirmed: {}, fields: fieldDefs }

  // 抽取字段值 → 人工确认（签名）；无表单字段但策略要求确认时，也弹一次摘要确认（人工签名闸不被跳过）
  const filled = fieldDefs.length ? await extractFieldsByLabels(userMsg, fieldDefs, cfg, sendLog) : []
  let confirmed: Record<string, string> = {}
  if (filled.length) {
    sendLog('acting', '已整理出待写入字段，请在下方表单核对并确认（人工签名）…')
    confirmed = await requestFormConfirmation(filled)
    if (!confirmed || Object.keys(confirmed).length === 0) return { status: 'cancelled', outcome: '🚫 已取消，未写入任何数据。', confirmed: {}, fields: filled }
  } else if (requireConfirm) {
    sendLog('acting', '该动作命中确认策略：请你人工确认（签名）后执行…')
    const rc = await requestFormConfirmation(summaryFields && summaryFields.length ? summaryFields : [{ name: 'confirm', label: '确认执行', value: '是', type: 'text' }])
    if (!rc || Object.keys(rc).length === 0) return { status: 'cancelled', outcome: '🚫 已取消该操作，未执行、未改动状态。', confirmed: {}, fields: [] }
  }

  if (runningState.aborted) return { status: 'cancelled', outcome: '🚫 已终止，未写入任何数据。', confirmed: {}, fields: filled }

  // ===== API 形态：确认后的字段值填入路径/请求体占位，带本地登录 cookie 直调接口 =====
  if (kind === 'api' && api) {
    const r = await callSystemApi(systemId, baseUrl, api, confirmed, sendLog)
    if (!r.ok && r.status === 0) return { status: 'fail', outcome: `❌ API 直调【${sysName}】失败：${r.text}`, confirmed, fields: filled }
    if (!r.ok) return { status: 'partial', outcome: `⚠️ API 直调【${sysName}】返回 HTTP ${r.status}：${r.text.slice(0, 200) || '（无响应体）'}`, confirmed, fields: filled }
    return { status: 'ok', outcome: `🤖 已经由 API 接口在【${sysName}】完成操作（HTTP ${r.status}）。${api.outputDesc ? `\n\n**接口输出说明：** ${api.outputDesc}` : ''}`, confirmed, fields: filled }
  }

  const fieldByStep: Record<number, string> = {}
  steps.forEach((s: any, i: number) => { const fn = s.param || s.fieldName; if (fn) fieldByStep[i] = fn })
  // create/填表类：录制步骤第一步带了页面 URL 时，直接从该表单页开始回放（导航由此代劳）
  const entryUrl = (steps[0]?.url && /^https?:/i.test(steps[0].url)) ? steps[0].url : baseUrl
  const rep = await replayActionScript(systemId || 'onto', entryUrl, sysName, steps, confirmed, fieldByStep, sendLog)
  if (!rep.ok) return { status: 'fail', outcome: `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`, confirmed, fields: filled }
  if (!rep.loggedIn) return { status: 'notLoggedIn', outcome: `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`, confirmed, fields: filled }
  if (rep.failedAt >= 0) return { status: 'partial', outcome: `已回放前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」中断（${rep.error || '元素未找到'}）。`, confirmed, fields: filled }
  return { status: 'ok', outcome: `🤖 已在【${sysName}】完整回放 ${rep.done}/${rep.total} 步，完成写入。`, confirmed, fields: filled }
}
