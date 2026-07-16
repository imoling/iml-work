// 浏览器自动化引擎：读取类技能的离屏抓取、CRM 表单回放/录制、语义脚本(DSL)解释与自愈。
// 纯搬迁自 main.ts，不改逻辑。驱动真实业务系统——回放/自愈正确性需真实技能验证，冒烟测不到。
import { BrowserWindow, ipcMain } from 'electron'
import { VISIT_FILL_FN, RECORDER_BOOTSTRAP, REPLAY_STEP_FN, HOVER_LOCATE_FN, SEMANTIC_FN, SNAPSHOT_FN, PAGE_SETTLE_FN, READ_DETAIL_FN } from './browser-scripts'
import { type LlmConfig, callLlm } from './llm'
import { type SendLog, type VisitField, type RecStep, type DslStep } from './types'
import { sleep, swallow, pickFieldValue } from './util'
import { buildFieldExtractPrompt } from './field-extract-core'
import { emitToRenderer } from './window-ref'

// 跨所有 iframe 抓取「文本最多」的那一帧正文（读取类技能的目标列表常渲染在子 iframe，
// 只读顶层 document.body 往往为空）。对齐 FDE 的"取最丰富 frame"策略。
async function scrapeRichestText(wc: Electron.WebContents, max = 6000): Promise<{ title: string; text: string; url: string }> {
  let title = '', url = '', best = ''
  try {
    const m = await wc.executeJavaScript(`({t:document.title||'',u:location.href,x:(document.body?document.body.innerText:'')})`) as { t?: string; u?: string; x?: string }
    title = m.t || ''; url = m.u || ''; best = m.x || ''
  } catch (e) { swallow(e) }
  try {
    const frames: Electron.WebFrameMain[] = wc.mainFrame && wc.mainFrame.framesInSubtree ? wc.mainFrame.framesInSubtree : []
    for (const f of frames) {
      try {
        const t = await f.executeJavaScript(`(document.body?document.body.innerText:'')`) as string
        if (t && t.trim().length > best.trim().length) best = t
      } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  return { title, text: (best || '').replace(/\s+\n/g, '\n').slice(0, max), url }
}

interface SystemExtractResult { ok: boolean; loggedIn: boolean; title: string; text: string; error?: string }

/**
 * 真实驱动一个业务系统：在带持久化登录态的浏览器窗口中打开系统地址，等待加载后
 * 抓取页面真实文本。员工首次需在弹出的窗口里登录（登录态按系统隔离持久保存），
 * 之后即可复用。返回真实页面内容，绝不臆造——若未登录或加载失败则如实反馈。
 */
export async function openSystemAndExtract(systemId: string, baseUrl: string, systemName: string, sendLog: SendLog, navHash: string = ''): Promise<SystemExtractResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在打开【${systemName}】，沿用你之前的登录…`)
    // 技能执行全程在后台静默运行（离屏），不弹出可见窗口。登录在"设置 → 企业系统连接"完成。
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true }
    })

    let settled = false
    const finish = async () => {
      if (settled) return
      settled = true
      try {
        sendLog('observing', `页面打开了，等它加载一下…`)
        await sleep(3500)
        // 直达路由：抓取前先跳到目标子页，再等二次渲染——否则读取类技能只会抓到首页。
        //
        // 支持两种路由形态（曾只支持 hash，把传统路径路由的系统拼成 `http://host#/monitor/units` 直接打不开
        // ——而企业里的老系统绝大多数正是传统路径路由，这一处会让整类系统接不进来）：
        //   · 路径路由（以 / 开头）：http://host/monitor/units —— 传统 Web / 服务端渲染
        //   · hash 路由（#/xxx 或裸 xxx）：http://host/#/todo —— Vue/React SPA
        if (navHash) {
          sendLog('acting', `正在直达目标页面…`)
          try {
            const isPath = navHash.startsWith('/')
            const origin = baseUrl.replace(/#.*$/, '').replace(/\/+$/, '')
            const h = isPath ? navHash : (navHash.startsWith('#') ? navHash : '#' + navHash)
            const full = origin + h
            await win.webContents.loadURL(full)
            await sleep(isPath ? 2500 : 3500)
            // hash 路由兜底：整页加载有时不触发 SPA 路由，再用 location.hash 推一次。
            // 路径路由不需要——loadURL 就是最终形态，服务端直接返回该页。
            if (!isPath) {
              try {
                const cur: string = await win.webContents.executeJavaScript('location.href')
                if (typeof cur === 'string' && cur.indexOf(h.replace('#', '')) < 0) {
                  await win.webContents.executeJavaScript(`(function(){location.hash=${JSON.stringify(h)};return 1})()`)
                  await sleep(2500)
                }
              } catch (e) { swallow(e) }
            }
          } catch (e) { swallow(e) }
        }
        const data = await scrapeRichestText(win.webContents, 6000)
        const text: string = (data.text || '').trim()
        const lower = text.toLowerCase()
        // 登录态判断：内容很短且像登录页，视为未登录
        const loginish = text.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证)/.test(lower)
        sendLog('stdout', `拿到【${systemName}】的页面内容了（约 ${text.length} 字），正在看…`)
        win.close()
        if (loginish) {
          // 后台静默执行，不弹窗；如未登录则提示去设置里登录。
          sendLog('observing', `好像还没登录【${systemName}】，先去「设置 → 企业系统连接」登录一下吧…`)
          resolve({ ok: true, loggedIn: false, title: data.title, text })
        } else {
          sendLog('completed', `已经从【${systemName}】拿到内容啦。`)
          resolve({ ok: true, loggedIn: true, title: data.title, text })
        }
      } catch (e: any) {
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: false, loggedIn: false, title: '', text: '', error: e.message })
      }
    }

    win.webContents.once('did-finish-load', finish)
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
      resolve({ ok: false, loggedIn: false, title: '', text: '', error: `页面加载失败(${code}): ${desc}` })
    })
    win.loadURL(baseUrl).catch(() => {})

    setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, loggedIn: false, title: '', text: '', error: '页面加载超时（30秒）' })
    }, 30000)
  })
}

// =====================================================================
// 客户拜访记录录入 CRM：① 抽取字段 → ② 对话框表单确认 → ③ 无头浏览器录入
// =====================================================================


// CRM 拜访记录的必填字段（与技能 SOP 对齐）。
const VISIT_RECORD_FIELDS: Array<{ name: string; label: string; type: string }> = [
  { name: 'visitType', label: '拜访类型', type: 'text' },
  { name: 'visitDate', label: '拜访日期', type: 'date' },
  { name: 'visitForm', label: '拜访形式', type: 'text' },
  { name: 'visitResult', label: '本次拜访结果', type: 'text' },
  { name: 'customerName', label: '客户名称', type: 'text' },
  { name: 'contact', label: '联系人', type: 'text' },
  { name: 'salesPlatform', label: '销售平台归属', type: 'text' },
  { name: 'regionPlatform', label: '区域平台归属', type: 'text' },
  { name: 'currentProgress', label: '当前进展', type: 'textarea' },
  { name: 'nextPlan', label: '下一步计划', type: 'textarea' }
]

// 用大模型从用户的自然语言拜访描述中抽取结构化字段，绝不编造关键信息（缺失留空）。
export async function extractVisitFields(userContent: string, cfg: LlmConfig, sendLog: SendLog): Promise<VisitField[]> {
  sendLog('thinking', '[拜访记录] 正在用大模型从您的描述中抽取要录入 CRM 的必填字段...')
  const today = new Date().toISOString().slice(0, 10)
  const prompt = `你是 CRM 拜访记录信息抽取助手。请从下面这段用户提供的拜访记录中抽取字段，输出严格 JSON 对象，键名固定为：${VISIT_RECORD_FIELDS.map(f => f.name).join(', ')}。
字段含义：${VISIT_RECORD_FIELDS.map(f => `${f.name}=${f.label}`).join('；')}。
规则：
- 拜访日期输出 YYYY-MM-DD 格式；若用户说“今天”则用 ${today}。
- 找不到的字段输出空字符串；绝对不要编造客户名称、联系人等关键信息，缺失就留空。
- 当前进展、下一步计划可在忠于原文的前提下做简洁客观的归纳。
- 只输出 JSON，不要任何解释或代码块标记。

拜访记录：
${userContent}`
  let values: Record<string, unknown> = {}
  try {
    const out = await callLlm(prompt, cfg)
    const s = (out || '').replace(/```json/g, '').replace(/```/g, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) values = JSON.parse(s.slice(a, b + 1))
  } catch (e: any) {
    sendLog('observing', `[拜访记录] 字段自动抽取失败（${e.message}），将给出空白表单供您手动填写。`)
  }
  const filledCount = VISIT_RECORD_FIELDS.filter(f => values[f.name]).length
  sendLog('stdout', `[拜访记录] 已抽取 ${filledCount}/${VISIT_RECORD_FIELDS.length} 个字段，未识别的字段留空待您确认。`)
  return VISIT_RECORD_FIELDS.map(f => ({ name: f.name, label: f.label, type: f.type, value: pickFieldValue(values, f.name) }))
}

interface VisitEntryResult { ok: boolean; loggedIn: boolean; filled: string[]; missing: string[]; title: string; url: string; error?: string }

// 在页面上下文里按字段标签就近定位表单控件并填充（best-effort，覆盖 antd/element/原生表单）。

// 复用本地登录态在后台静默打开 CRM，按确认后的参数尽力填充拜访记录表单，如实回报实际结果。
export async function fillCrmVisitForm(systemId: string, baseUrl: string, systemName: string, confirmed: Record<string, string>, fields: VisitField[], sendLog: SendLog): Promise<VisitEntryResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用本地登录态，准备录入拜访记录：${baseUrl}`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => {
      if (settled) return; settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
      resolve({ ok: false, loggedIn: false, filled: [], missing: fields.map(f => f.label), title: '', url: '', error })
    }
    const finish = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3500)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        const loginish = (pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)
        if (loginish) {
          sendLog('observing', `检测到尚未登录【${systemName}】，无法录入。请先在「设置 → 企业系统连接」完成登录。`)
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, filled: [], missing: fields.map(f => f.label), title: pre.title, url: pre.url })
          return
        }
        sendLog('acting', '页面已就绪，正在按字段标签逐项定位并填充表单控件...')
        const payload = JSON.stringify(fields.map(f => ({ label: f.label, value: confirmed[f.name] || '' })).filter(x => x.value))
        const report = await win.webContents.executeJavaScript(`(${VISIT_FILL_FN})(${payload})`)
        await sleep(600)
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        sendLog('stdout', `[拜访记录] 已填充 ${(report.filled || []).length} 个字段：${(report.filled || []).join('、') || '无'}`)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, filled: report.filled || [], missing: report.missing || [], title: after.title, url: after.url })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', finish)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => fail('页面加载超时（30秒）'), 30000)
  })
}

// =====================================================================
// 浏览器实操录制（Record & Replay）：用户在监控下操作业务系统，捕获稳健选择器与步骤，
// 生成可确定性回放的技能脚本。录制复用 persist:bizsys-<id> 登录态，所见即所录。
// =====================================================================


let recorderWin: BrowserWindow | null = null
let recorderSteps: RecStep[] = []

// 注入到被录制页面里的脚本：计算稳健选择器并监听 click / change，通过 console 通道上报。

function injectRecorder(wc: Electron.WebContents) {
  wc.executeJavaScript(RECORDER_BOOTSTRAP).catch(() => {})
}

ipcMain.handle('recorder:start', async (_e, payload: { systemId: string; baseUrl: string; systemName: string }) => {
  try {
    if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (e) { swallow(e) } }
    recorderSteps = []
    const win = new BrowserWindow({
      show: true, width: 1280, height: 860, title: `实操录制 · ${payload.systemName}`,
      webPreferences: { partition: `persist:bizsys-${payload.systemId}` }
    })
    recorderWin = win
    const onStep = (_ev: any, _level: any, message: string) => {
      if (typeof message === 'string' && message.startsWith('__REC__')) {
        try {
          const step: RecStep = JSON.parse(message.slice('__REC__'.length))
          // 合并连续对同一控件的 fill（取最后值），避免重复步骤
          const last = recorderSteps[recorderSteps.length - 1]
          if (step.action === 'fill' && last && last.action === 'fill' && last.selector === step.selector) {
            last.value = step.value
          } else {
            recorderSteps.push(step)
          }
          emitToRenderer('recorder:step', step)
        } catch (e) { swallow(e) }
      }
    }
    win.webContents.on('console-message', onStep)
    win.webContents.on('did-finish-load', () => injectRecorder(win.webContents))
    win.webContents.on('did-frame-navigate', () => injectRecorder(win.webContents))
    win.on('closed', () => { recorderWin = null })
    await win.loadURL(payload.baseUrl)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('recorder:stop', async () => {
  const steps = recorderSteps.slice()
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (e) { swallow(e) } }
  recorderWin = null
  return { ok: true, steps }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (e) { swallow(e) } }
  recorderWin = null
  return { ok: true }
})

// 用大模型按给定字段标签从用户描述抽取值（通用版，配合录制脚本的字段清单）。
export async function extractFieldsByLabels(userContent: string, fields: VisitField[], cfg: LlmConfig, sendLog: SendLog): Promise<VisitField[]> {
  if (!fields.length) return []
  sendLog('thinking', '[录制技能] 正在用大模型从您的描述中抽取待填写字段...')
  const prompt = buildFieldExtractPrompt(userContent, fields, new Date())
  let values: Record<string, unknown> = {}
  try {
    const out = await callLlm(prompt, cfg)
    const s = (out || '').replace(/```json/g, '').replace(/```/g, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) values = JSON.parse(s.slice(a, b + 1))
  } catch (e) { swallow(e) }
  return fields.map(f => ({ ...f, value: pickFieldValue(values, f.name) }))
}


// 在页面上下文中执行单个录制步骤（带等待重试），返回是否成功。
// 支持 kind:'search' —— 纷享销客等"带 + 检索选择框"：填入关键词→等待异步结果→点击匹配项。

// 在页面里定位元素并返回其视口中心坐标（供主进程派发真实指针移动，驱动纯 CSS :hover 菜单）。
// 优先用录制选择器 sel，其次按文本 arg。

// 真实指针 hover：先把鼠标移到元素中心（触发 CSS :hover），再派发合成事件（兜底 JS 框架）。
async function realHover(wc: Electron.WebContents, arg: string, sel?: string): Promise<{ ok: boolean; error?: string }> {
  let loc: any = null
  try { loc = await wc.executeJavaScript(`(${HOVER_LOCATE_FN})(${JSON.stringify(arg)}, ${JSON.stringify(sel || '')})`) } catch (e) { swallow(e) }
  if (loc && loc.ok) {
    try {
      wc.sendInputEvent({ type: 'mouseMove', x: loc.x, y: loc.y } as any)
      await sleep(80)
      wc.sendInputEvent({ type: 'mouseMove', x: loc.x, y: loc.y } as any)
    } catch (e) { swallow(e) }
  }
  let syn: any = null
  try { syn = await wc.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify({ op: 'hover', arg, value: '', sel: sel || '' })})`) } catch (e) { swallow(e) }
  await sleep(350)
  if ((loc && loc.ok) || (syn && syn.ok)) return { ok: true }
  return { ok: false, error: (syn && syn.error) || '未找到悬停目标' }
}

interface ReplayResult { ok: boolean; loggedIn: boolean; done: number; total: number; failedAt: number; failLabel: string; title: string; url: string; error?: string }

// 复用登录态在后台静默回放录制脚本，把确认后的字段值替换进绑定步骤，如实回报执行结果。
export async function replayActionScript(systemId: string, baseUrl: string, systemName: string, steps: RecStep[], fieldValues: Record<string, string>, fieldByStep: Record<number, string>, sendLog: SendLog): Promise<ReplayResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用登录态，按录制脚本回放 ${steps.length} 步操作...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve({ ok: false, loggedIn: false, done: 0, total: steps.length, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, done: 0, total: steps.length, failedAt: -1, failLabel: '', title: pre.title, url: pre.url }); return
        }
        let done = 0
        for (let i = 0; i < steps.length; i++) {
          const step = { ...steps[i] }
          const boundField = fieldByStep[i]
          if (boundField && fieldValues[boundField] !== undefined) step.value = fieldValues[boundField]
          // 回放等待：用户为该步标注的等待（如等异步检索/页面跳转渲染）。
          const waitBefore = Number(step.waitBefore) || 0
          if (waitBefore > 0) { sendLog('observing', `[回放] 等待 ${waitBefore}ms（${step.label || ''}）`); await sleep(waitBefore) }
          const kindLabel = step.kind === 'search' ? '检索选择' : ((step as any).action || (step as any).act || 'click')
          sendLog('stdout', `[回放 ${i + 1}/${steps.length}] ${kindLabel} · ${step.label || step.selector}`)
          const r = await win.webContents.executeJavaScript(`(${REPLAY_STEP_FN})(${JSON.stringify(step)})`)
          if (!r || !r.ok) {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
            resolve({ ok: true, loggedIn: true, done, total: steps.length, failedAt: i, failLabel: step.label || step.selector, title: after.title, url: after.url, error: r && r.error }); return
          }
          done++
          await sleep(700)
        }
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, done, total: steps.length, failedAt: -1, failLabel: '', title: after.title, url: after.url })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => fail('页面加载超时（30秒）'), 30000)
  })
}

// =====================================================================
// 语义化技能脚本（DSL）解释执行 —— 比录制原始步骤更灵活、可读可改。
// 支持动词：click "文本" / fill "标签"=值 / select "标签"=值 / dropdown "标签"=值
//          searchSelect "标签"=值 / wait <ms> / waitText "文本"
// =====================================================================


// 解析 DSL 文本为步骤数组。支持行尾可选的 ` @sel=<css选择器>`（录制时的稳健定位，回放优先用它）。
export function parseDsl(code: string): DslStep[] {
  const out: DslStep[] = []
  for (const raw of (code || '').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let sel = ''
    const sm = line.match(/\s@sel=(.+)$/)
    if (sm) { sel = sm[1].trim(); line = line.slice(0, (sm as any).index).trim() }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^wait\s+(\d+)/i))) { out.push({ op: 'wait', arg: '', valueExpr: m[1] }); continue }
    if ((m = line.match(/^waitText\s+"([^"]*)"/i))) { out.push({ op: 'waitText', arg: m[1], valueExpr: '', sel }); continue }
    if ((m = line.match(/^(\w+)\s+"([^"]*)"\s*(?:=\s*(.+))?$/))) { out.push({ op: m[1], arg: m[2], valueExpr: (m[3] || '').trim(), sel }); continue }
  }
  return out
}

// 把 valueExpr（{{字段}} 或 "字面量"）解析成最终值。
function resolveDslValue(valueExpr: string, fieldValues: Record<string, string>): string {
  if (!valueExpr) return ''
  // 参数键含中文（目的地/出差事由…），不能用 \w（\w 只含 ASCII，中文占位会匹配失败被当字面量原样填入表单）。
  const pm = valueExpr.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
  if (pm) return fieldValues[pm[1]] !== undefined ? fieldValues[pm[1]] : ''
  return valueExpr.replace(/^"|"$/g, '')
}

// 在页面上下文中按语义定位执行一个动作（含等待/检索/下拉轮询）。

// 抓取当前页面"可交互元素"清单（供自愈智能体看页面决策）。

// 等待页面"稳定"：readyState 完成 + 无加载指示 + DOM 安静一小段，避免 SPA 导航未完成就误点上一个视图。

async function settlePage(wc: Electron.WebContents, maxMs = 9000): Promise<void> {
  try { await wc.executeJavaScript(`(${PAGE_SETTLE_FN})(${maxMs})`) } catch (e) { swallow(e) }
}

// 统一执行一个步骤（hover 走真实指针，其余走语义解释器）。
async function execStep(wc: Electron.WebContents, step: any): Promise<{ ok: boolean; error?: string }> {
  if (step.op === 'hover') return realHover(wc, step.arg, step.sel)
  try { return await wc.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify(step)})`) } catch (e: any) { return { ok: false, error: e.message } }
}

interface HealOpts {
  llmConfig?: LlmConfig; sop?: string; script?: string
  /** 终笔确认：执行到第 pauseBeforeIndex 步（写入终笔，如「同意」）之前暂停，
   *  读当前页面的单据详情（KV）交给回调让用户过目签字；回调返回 false = 取消，剩余步骤不执行。
   *  审批的本质是「看清单据再裁决」——只确认"目标对象=X"一行字就签，等于闭眼批。 */
  pauseBeforeIndex?: number
  onPause?: (detail: { label: string; value: string }[]) => Promise<boolean>
}

// 自愈：某步按录制定位失败时，让大模型看当前页面 + SOP 意图，修正定位/关掉遮挡弹窗/或如实停止。
async function selfHeal(wc: Electron.WebContents, opts: HealOpts, step: any, sendLog: SendLog): Promise<{ ok: boolean; reason?: string }> {
  const cfg = opts.llmConfig
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.modelName) return { ok: false, reason: '未配置大模型，无法智能自愈' }
  for (let round = 0; round < 3; round++) {
    let els: any[] = []
    try { els = await wc.executeJavaScript(`(${SNAPSHOT_FN})()`) } catch (e) { swallow(e) }
    if (!els.length) { await sleep(800); continue }
    const list = els.map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`).join('\n')
    const intent = `${step.op}${step.arg ? ' “' + step.arg + '”' : ''}${step.value ? ' 值=' + step.value : ''}`
    const prompt = `你在浏览器里执行一个业务自动化技能。整体标准流程(SOP)/脚本如下：\n${(opts.sop || opts.script || '').slice(0, 1500)}\n\n当前要完成的这一步意图：${intent}\n（录制时的定位提示：选择器 \`${(step.sel || '无')}\`，仅供参考；请以当前页面真实元素清单为准来定位）\n按录制提示未命中。下面是当前页面"可交互元素"清单（带编号）：\n${list}\n\n请决定如何完成这一步。规则：\n- 很多菜单要先把鼠标悬停在某个图标/模块入口上才会展开（左侧边栏图标、顶部一级菜单等）。目标项当前清单里看不到时，**不要急着 stop**：先在清单里挑一个最可能展开出目标的图标/模块入口，action 用 "hover"、completed=false（系统会把真实指针移上去展开后重试原步骤），可多次 hover 不同入口尝试。例如：目标是「客户管理」就 hover 清单里的「CRM」「客户」等模块入口；目标是某二级项就 hover 其一级菜单。\n- 若有遮挡弹窗（权限提示/确认框/引导层）挡住目标，先选关闭它的元素（如"我知道了"/"确定"/关闭），并设 completed=false。\n- 若能直接完成这一步，选对应元素并设 completed=true；需要填值时给 value。\n- 仅当已尝试过 hover 展开相关入口、仍确实无法完成（如明确提示无权限、目标确不存在）时，才用 action "stop" 并在 reason 说明。\n只输出严格 JSON：{"action":"click|fill|select|hover|stop","index":<编号或-1>,"value":"<可选>","completed":true|false,"reason":"<简述>"}`
    let d: any = null
    try {
      const out = await callLlm(prompt, cfg)
      const s = (out || '').replace(/```json/g, '').replace(/```/g, '')
      const a = s.indexOf('{'), b = s.lastIndexOf('}')
      if (a >= 0 && b > a) d = JSON.parse(s.slice(a, b + 1))
    } catch (e) { swallow(e) }
    if (!d) return { ok: false, reason: '自愈决策解析失败' }
    const tgt = (typeof d.index === 'number' && d.index >= 0 && els[d.index]) ? els[d.index] : null
    sendLog('thinking', `[自愈] ${d.action}${tgt ? ' 「' + (tgt.text || '') + '」' : ''} — ${d.reason || ''}`)
    if (d.action === 'stop') return { ok: false, reason: d.reason || '智能体判定无法继续' }
    if (!tgt) return { ok: false, reason: '自愈未指定有效元素' }
    await execStep(wc, { op: d.action, arg: '', value: d.value || '', sel: tgt.sel })
    await sleep(700)
    if (d.completed) return { ok: true }
    const rr = await execStep(wc, step)   // 关闭遮挡后重试原步骤
    if (rr && rr.ok) return { ok: true }
  }
  return { ok: false, reason: '多轮自愈仍未完成' }
}

interface InterpretResult { ok: boolean; loggedIn: boolean; done: number; total: number; failedAt: number; failLabel: string; title: string; url: string; text?: string; error?: string }

// 复用登录态在后台静默打开系统，按语义脚本逐步解释执行；失败步触发 SOP 智能自愈。
export async function interpretSkillScript(systemId: string, baseUrl: string, systemName: string, dsl: DslStep[], fieldValues: Record<string, string>, sendLog: SendLog, opts: HealOpts = {}): Promise<InterpretResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用登录态，按语义脚本执行 ${dsl.length} 步...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve({ ok: false, loggedIn: false, done: 0, total: dsl.length, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, done: 0, total: dsl.length, failedAt: -1, failLabel: '', title: pre.title, url: pre.url }); return
        }
        let done = 0
        let prevOp = ''
        for (let i = 0; i < dsl.length; i++) {
          const value = resolveDslValue(dsl[i].valueExpr, fieldValues)
          // arg 位参数（click "{{目标对象}}"）：录制治本产物——目标由用户点名，不写死。
          // 替换后必须丢掉 @sel：录制的选择器指向"录制时点的那一行"，换了目标行就是精准点错。
          let arg = dsl[i].arg
          let sel = dsl[i].sel || ''
          const am = (arg || '').match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
          if (am) {
            arg = (fieldValues[am[1]] || '').trim()
            sel = ''
            if (!arg) {
              try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
              resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: i, failLabel: `参数「${am[1]}」未提供`, title: '', url: '', error: `目标参数「${am[1]}」为空——请在确认卡里填写要处理的条目名称` }); return
            }
          }
          const step = { op: dsl[i].op, arg, value, sel }
          const desc = `${step.op} ${step.arg ? '“' + step.arg + '”' : ''}${value ? ' = ' + value : ''}`
          // 上一步可能触发了导航 → 执行本步前等页面加载稳定，避免误点旧视图
          if (prevOp === 'click' || prevOp === 'hover') { sendLog('observing', `等待页面加载稳定...`); await settlePage(win.webContents) }
          // 终笔确认：写入终笔（同意/提交…）之前，把当前页面的真实单据内容读出来给用户过目
          if (opts.pauseBeforeIndex === i && opts.onPause) {
            await settlePage(win.webContents)
            let kv: { label: string; value: string }[] = []
            try { kv = (await win.webContents.executeJavaScript(`(${READ_DETAIL_FN})()`)) || [] } catch (e) { swallow(e, 'pause-detail') }
            sendLog('acting', kv.length ? `已读取单据详情（${kv.length} 项），请核对后签字确认…` : '未读到结构化单据字段，请确认是否继续…')
            const go = await opts.onPause(kv)
            if (!go) {
              try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
              resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: i, failLabel: '用户取消终笔确认', title: '', url: '', error: 'cancelled-at-final-confirm' }); return
            }
          }
          sendLog('stdout', `[脚本 ${i + 1}/${dsl.length}] ${desc}`)
          let r = await execStep(win.webContents, step)
          if (!r || !r.ok) {
            sendLog('observing', `[第 ${i + 1} 步] 按录制定位未命中，启动 SOP 智能体自愈...`)
            const h = await selfHeal(win.webContents, opts, step, sendLog)
            r = h.ok ? { ok: true } : { ok: false, error: h.reason || (r && r.error) }
          }
          if (!r || !r.ok) {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
            resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: i, failLabel: desc, title: after.title, url: after.url, error: r && r.error }); return
          }
          done++
          prevOp = step.op
          await sleep(500)
        }
        // 全部步骤完成 → 等页面稳定后跨 frame 抓取最丰富正文（读取类据此整理结果），再关闭
        await settlePage(win.webContents)
        await sleep(1500)
        const after = await scrapeRichestText(win.webContents, 4000)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: -1, failLabel: '', title: after.title, url: after.url, text: after.text })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => fail('脚本执行总超时（90秒）'), 90000)
  })
}

// ===== SOP 智能体执行器（免录制的第三形态）=====
// 只给一段 SOP 描述 + 确认后的字段值，智能体读实时页面「可交互元素清单」逐步决策 click/fill/select/hover，
// 直到判定完成。复用 SNAPSHOT_FN/execStep/settlePage/scrapeRichestText，不另造引擎。
// 与录制回放的差异：无预置选择器，全靠模型看页面定位——鲁棒于 UI 变动、免录制即可上线，
// 但确定性弱于回放；故仅用于「新客户系统快速对接」，稳定后可再录制升级为 replay。
export async function runSopAgent(systemId: string, entryUrl: string, systemName: string, sop: string, fieldValues: Record<string, string>, sendLog: SendLog, cfg: LlmConfig, maxSteps = 14): Promise<InterpretResult> {
  return new Promise((resolve) => {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.modelName) {
      resolve({ ok: false, loggedIn: false, done: 0, total: 0, failedAt: -1, failLabel: '', title: '', url: '', error: '未配置大模型，无法运行 SOP 智能体' }); return
    }
    sendLog('acting', `正在后台静默打开【${systemName}】，按 SOP 由智能体读页面执行（免录制）...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve({ ok: false, loggedIn: false, done: 0, total: 0, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const fieldsBlock = Object.keys(fieldValues || {}).length
      ? Object.entries(fieldValues).map(([k, v]) => `- ${k}：${v}`).join('\n')
      : '（无预置字段，按 SOP 完成即可）'
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, done: 0, total: 0, failedAt: -1, failLabel: '', title: pre.title, url: pre.url }); return
        }
        const history: string[] = []
        let done = 0
        for (let stepNo = 0; stepNo < maxSteps; stepNo++) {
          await settlePage(win.webContents)
          let els: any[] = []
          try { els = await win.webContents.executeJavaScript(`(${SNAPSHOT_FN})()`) } catch (e) { swallow(e) }
          if (!els.length) { await sleep(900); continue }
          const list = els.map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`).join('\n')
          const histBlock = history.length ? history.slice(-8).map((h, i) => `${i + 1}. ${h}`).join('\n') : '（尚未开始）'
          const prompt = `你在浏览器里替员工执行一个业务操作，一次只做一步。\n【目标标准流程(SOP)】\n${(sop || '').slice(0, 1500)}\n\n【待写入/使用的字段值（勿臆造，只用这里给的）】\n${fieldsBlock}\n\n【已完成的步骤】\n${histBlock}\n\n【当前页面可交互元素（带编号）】\n${list}\n\n请决定"下一步"。规则：\n- 需要展开菜单/侧边栏才能看到目标时，先 hover 相应入口（completed 无所谓，可多次 hover 不同入口）。\n- 有遮挡弹窗（引导层/权限框）先关闭它。\n- 需要填值就 fill / select 对应元素并给 value（值取自上面的字段）。\n- SOP 全部完成（已提交/已保存/目标状态达成）时用 action "done"。\n- 确实无法继续（无权限/目标不存在/多轮无进展）才用 "stop" 并在 reason 说明。\n只输出严格 JSON：{"action":"click|fill|select|hover|done|stop","index":<编号或-1>,"value":"<可选>","reason":"<简述>"}`
          let d: any = null
          try {
            const out = await callLlm(prompt, cfg)
            const s = (out || '').replace(/```json/g, '').replace(/```/g, '')
            const a = s.indexOf('{'), b = s.lastIndexOf('}')
            if (a >= 0 && b > a) d = JSON.parse(s.slice(a, b + 1))
          } catch (e) { swallow(e) }
          if (!d || !d.action) { await sleep(600); continue }
          if (d.action === 'done') { sendLog('thinking', `[SOP 智能体] 判定完成 — ${d.reason || ''}`); break }
          if (d.action === 'stop') {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
            resolve({ ok: true, loggedIn: true, done, total: done, failedAt: done, failLabel: d.reason || '智能体判定无法继续', title: after.title, url: after.url }); return
          }
          const tgt = (typeof d.index === 'number' && d.index >= 0 && els[d.index]) ? els[d.index] : null
          if (!tgt) { history.push('（模型未指定有效元素，跳过一轮）'); await sleep(500); continue }
          const label = tgt.text || tgt.sel || ''
          sendLog('stdout', `[SOP ${done + 1}] ${d.action}「${label}」${d.value ? ' = ' + d.value : ''}${d.reason ? ' — ' + d.reason : ''}`)
          await execStep(win.webContents, { op: d.action, arg: label, value: d.value || '', sel: tgt.sel })
          history.push(`${d.action}「${label}」${d.value ? '=' + d.value : ''}`)
          done++
          await sleep(700)
        }
        // 完成 → 等页面稳定后抓取最丰富正文（供结果核对/读取类整理），再关闭
        await settlePage(win.webContents)
        await sleep(1200)
        const after = await scrapeRichestText(win.webContents, 4000)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, done, total: done, failedAt: -1, failLabel: '', title: after.title, url: after.url, text: after.text })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(entryUrl).catch(() => {})
    setTimeout(() => fail('SOP 智能体执行总超时（180秒）'), 180000)
  })
}
