// Playwright 版 browse 工具（P1+P3）——与 Electron 版 makeBrowseTool 同款 run(step, log) 契约，上层技能链路调用点一行不改，只换工厂。
// 感知=a11y 快照（role/name）+ DOM 假按钮扫描；定位=getByRole/getByLabel 语义（不用脆选择器）；
// 落值=平台 API 优先（泛微 WfForm.changeFieldValue，绕开合成/真实事件之争）→ 语义 fill/pickResult 兜底。
// **跨 frame**：讯飞 iBPMS 表单在 iframe 里 → formScope() 找到含表单字段的 frame，所有定位/落值都在它上面做。
// 端口自 FDE automation.ts 的 perceive/locate/act，补泛微适配器。叶子纪律：不 import main。
import type { SendLog } from './types'
import type { AgentTool } from './agent-loop'
import { launchCtx, newSystemContext, captureState } from './pw-runtime'
import { BROWSE_DESC, BROWSE_ARGSHINT, WRITE_INTENT, type WriteConfirm } from './agent-browse'

const RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .j-search-item, .el-autocomplete-suggestion li, .ant-modal-wrap tr.ant-table-row'
const ACTIONABLE = ['button', 'textbox', 'searchbox', 'combobox', 'menuitem', 'menuitemcheckbox', 'link', 'checkbox', 'radio', 'option', 'tab', 'switch']
const FIELD_ROLES = ['textbox', 'searchbox', 'combobox']

export interface PwStep { action: string; url?: string; target?: string; value?: string; column?: string; sel?: string; fieldId?: string;[k: string]: unknown }
// 同时满足 AgentTool（name/description/argsHint/run/cleanup，供 runAgentLoop 驱动）+ 便于 bench 直接取 page/context。
// run 直接继承 AgentTool 的 (args, sendLog) 签名（实现里把 args 当 PwStep 用）。
export interface PwBrowseTool extends AgentTool {
  page: () => any
  context: () => any
  close: () => Promise<void>
}
export interface PwToolOpts { systemId?: string; headless?: boolean; profileDir?: string; onWriteConfirm?: WriteConfirm }

export async function makePwBrowseTool(opts: PwToolOpts): Promise<PwBrowseTool> {
  // bench（profileDir==''）用一次性持久上下文；真系统 newContext 注入 storageState 登录态（用完即关，态在仓库）。
  const isBench = opts.profileDir === ''
  const systemId = opts.systemId || 'default'
  const headed = opts.headless === false   // 调用方显式要可视（stepper/executor 的 visible）才有头
  const ctx = isBench
    ? await launchCtx(systemId, opts.headless !== false, opts.profileDir)
    : await newSystemContext(systemId, headed)
  const page = ctx.pages()[0] || await ctx.newPage()
  const say = (log: SendLog | undefined, phase: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', msg: string) => { try { log && log(phase, msg) } catch (_) { /* noop */ } }

  async function settle(maxMs = 8000): Promise<void> {
    try { await page.waitForLoadState('domcontentloaded', { timeout: maxMs }) } catch (_) { /* noop */ }
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      const loading = await page.evaluate(`(function(){try{ if(document.querySelector('.ant-spin-spinning,.ant-spin-dot,.el-loading-mask')) return true; var t=document.body?document.body.innerText:''; return t.indexOf('努力加载中')!==-1||t.indexOf('加载中...')!==-1; }catch(e){ return false; }})()`).catch(() => false)
      if (!loading) break
      await page.waitForTimeout(300)
    }
    await page.waitForTimeout(200)
  }

  // 表单所在 frame：优先含 ≥2 表单字段的 iframe（讯飞 iBPMS 表单嵌 iframe），否则含 WfForm 的 frame，否则主 frame。
  async function formScope(): Promise<any> {
    const frames = page.frames()
    for (const f of frames) {
      if (f === page.mainFrame()) continue
      try { if (await f.evaluate(() => document.querySelectorAll('input:not([type=hidden]),textarea,[id^=field]').length) >= 2) return f } catch (_) { /* noop */ }
    }
    for (const f of frames) { try { if (await f.evaluate(() => !!(window as any).WfForm)) return f } catch (_) { /* noop */ } }
    return page.mainFrame()
  }

  // 平台探测（在给定 frame 内）：泛微 e-cology / 纷享 / 通用
  async function platform(scope: any): Promise<string> {
    return scope.evaluate(`(function(){ return window.WfForm ? 'ecology' : document.querySelector('.f-item-inner.j-comp-wrap') ? 'fenxiang' : 'generic'; })()`).catch(() => 'generic')
  }

  // 语义感知：a11y 树（可交互 role+name，Chrome 的 a11y 树跨 iframe）+ 表单 frame DOM 假按钮扫描。返回人话清单。
  async function perceive(): Promise<{ items: { role: string; name: string }[]; text: string }> {
    let ax: any = null
    try { ax = await page.accessibility.snapshot({ interestingOnly: true }) } catch (_) { /* noop */ }
    const flat: { role: string; name: string }[] = []
    ;(function w(n: any) { if (!n) return; flat.push({ role: n.role, name: (n.name || '').trim() }); (n.children || []).forEach(w) })(ax || {})
    const out: { role: string; name: string }[] = [], seen = new Set<string>()
    for (let i = 0; i < flat.length; i++) {
      const n = flat[i]
      if (!ACTIONABLE.includes(n.role)) continue
      let name = n.name
      if (!name && FIELD_ROLES.includes(n.role)) {
        for (let j = Math.max(0, i - 3); j < Math.min(flat.length, i + 4); j++) { if (flat[j].role === 'LabelText' && flat[j].name) { name = flat[j].name; break } }
      }
      if (!name) continue
      const k = n.role + '|' + name; if (seen.has(k)) continue; seen.add(k)
      out.push({ role: n.role, name })
    }
    // DOM 扫描无 role 的 span 假按钮（讯飞/泛微 新建/提交常是 span）——在表单 frame 里扫
    const SCAN = `(function(){ var vis=function(n){try{var r=n.getBoundingClientRect();return n.offsetParent!==null&&r.width>1&&r.height>1}catch(e){return false}}; var sel='button,[role=button],[class*=btn],[class*=Btn],[onclick],[class*=menu-item],[class*=crm-btn]'; var nodes=document.querySelectorAll(sel),out=[],seen={}; for(var i=0;i<nodes.length&&out.length<40;i++){var n=nodes[i];if(!vis(n))continue;var t=(n.innerText||n.textContent||'').replace(/\\s+/g,' ').trim();if(!t||t.length>16||seen[t])continue;seen[t]=1;out.push(t);} return out; })()`
    let clickables: string[] = []
    try { const scope = await formScope(); clickables = await scope.evaluate(SCAN) } catch (_) { /* noop */ }
    for (const t of clickables) { if (!seen.has('button|' + t) && !seen.has('link|' + t)) { seen.add('button|' + t); out.push({ role: 'button', name: t }) } }
    const text = out.map(it => `[${it.role}] ${it.name}`).join('\n')
    return { items: out, text }
  }

  // 语义定位（role+name，不用脆选择器）。scope=表单 frame 或 page。
  function locate(scope: any, role: string, name: string): any {
    try {
      if (role === 'button') return scope.getByRole('button', { name }).or(scope.getByText(name, { exact: true })).first()
      if (role === 'link') return scope.getByRole('link', { name }).or(scope.getByText(name, { exact: true })).first()
      if (role === 'textbox' || role === 'searchbox') return scope.getByRole('textbox', { name }).or(scope.getByLabel(name)).or(scope.getByPlaceholder(name)).first()
      if (role === 'combobox') return scope.getByRole('combobox', { name }).or(scope.getByLabel(name)).first()
      if (/^(menuitem|option|tab|checkbox|radio|switch)$/.test(role)) return scope.getByRole(role as any, { name }).or(scope.getByText(name, { exact: true })).first()
    } catch (_) { /* noop */ }
    return scope.getByText(name, { exact: true }).first()
  }

  // 从结果浮层/下拉里点选 value（浮层可能在表单 frame，也可能挂主文档 → 两处都找）
  async function pickResult(scope: any, value: string): Promise<{ ok: boolean; error?: string }> {
    if (!value) return { ok: true }
    for (const s of [scope, page]) {
      try {
        const opt = s.locator(RESULT_SEL).filter({ hasText: value }).first()
        if (await opt.count()) { await opt.click({ timeout: 5000 }); return { ok: true } }
        const byText = s.getByText(value, { exact: true }).first()
        if (await byText.count() && await byText.isVisible().catch(() => false)) { await byText.click({ timeout: 4000 }); return { ok: true } }
      } catch (_) { /* 换下一个 scope */ }
    }
    return { ok: false, error: '未在候选里匹配到「' + value + '」' }
  }

  // 泛微 WfForm 落值：按显示标签找字段控件 id(field\d+) → WfForm.changeFieldValue（应用自己的数据绑定，最稳）
  async function wfFill(scope: any, target: string, value: string): Promise<{ ok: boolean; fieldId?: string }> {
    const fieldId: string | null = await scope.evaluate((lab: string) => {
      if (!(window as any).WfForm) return null
      const norm = (s: string) => (s || '').replace(/[*\s：:]/g, '').trim()
      const wraps = Array.from(document.querySelectorAll('.f-item, [class*=wf-][class*=-item], .field-item, form > div, tr, .form-item'))
      for (const w of wraps) {
        const labEl = w.querySelector('label, .field-label, .item-label, td:first-child, [class*=label]')
        const labTxt = norm(labEl ? labEl.textContent || '' : '')
        if (!labTxt || labTxt.indexOf(norm(lab)) === -1) continue
        const ctrl = w.querySelector('[id^=field]')
        if (ctrl) return (ctrl.id || '').replace(/_\d+span$|span$|_\d+$/, '')
      }
      return null
    }, target)
    if (!fieldId) return { ok: false }
    await scope.evaluate(({ id, val }: any) => (window as any).WfForm.changeFieldValue(id, { value: val }), { id: fieldId, val: value })
    return { ok: true, fieldId }
  }

  async function scrapeContent(): Promise<string> {
    let best = ''
    for (const f of page.frames()) {
      try { const t = await f.evaluate(() => (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim()); if (t && t.length > best.length) best = t } catch (_) { /* noop */ }
    }
    return best.slice(0, 4000)
  }

  // 行定位：含 target 文本的表格行（getByRole('row') 只命中真表格行，不误抓外层容器；取最具体的第一条）
  function rowLoc(scope: any, target: string): any { return scope.getByRole('row').filter({ hasText: target }).first() }

  // sel 定位：优先表单 frame，未命中回退主 frame（sel 可能指主文档弹窗）
  async function bySel(scope: any, sel: string): Promise<any> {
    try { const l = scope.locator(sel).first(); if (await l.count()) return l } catch (_) { /* noop */ }
    return page.locator(sel).first()
  }

  async function run(args: Record<string, unknown>, log?: SendLog): Promise<string> {
    const step = args as PwStep
    const a = step.action, target = String(step.target || ''), value = String(step.value || '')
    try {
      if (a === 'goto') {
        say(log, 'acting', `[pw] 导航到 ${step.url}`)
        await page.goto(String(step.url || ''), { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
        await settle()
        // 等 SSO/JS 跳转落定后再报**落地 URL**（不是原始 URL）——登录预检靠它判断是否还停在登录页；跳转慢会漏判。
        await page.waitForTimeout(900)
        let title = ''; try { title = await page.title() } catch (_) { /* noop */ }
        let landed = ''; try { landed = page.url() } catch (_) { /* noop */ }
        return `【当前页】${title || '(无标题)'} | ${landed}`
      }
      if (a === 'observe' || a === 'inspect') { await settle(4000); const p = await perceive(); return '页面可交互元素：\n' + (p.text || '(空)') }
      if (a === 'read') { await settle(4000); return '页面正文：\n' + await scrapeContent() }
      const scope = await formScope()
      if (a === 'click') {
        // 写前签字（安全红线）：点「提交/保存/同意/删除…」写按钮之前，把当前页面真实单据交调用方给用户签字，未签中止不点。
        if (opts.onWriteConfirm && WRITE_INTENT.test(target)) {
          const pageText = await scrapeContent()
          const signed = await opts.onWriteConfirm({ actionLabel: target || '提交', pageText })
          if (!signed) { say(log, 'completed', `已在写入前取消：未执行「${target}」`); return `已在写入前被用户取消：未执行「${target}」，未对系统做任何改动。请立即结束任务（finish），如实告知用户"已在提交前取消，未改动系统"。` }
        }
        say(log, 'acting', `[pw] 点击「${target}」`); const el = step.sel ? await bySel(scope, step.sel) : locate(scope, 'button', target); await el.click({ timeout: 7000 }); await settle(3000); return '已点击「' + target + '」'
      }
      if (a === 'hover') { await locate(scope, 'button', target).hover({ timeout: 5000 }); return '已悬停「' + target + '」' }
      if (a === 'fill') {
        say(log, 'acting', `[pw] 填写「${target}」= ${value.slice(0, 20)}`)
        if ((await platform(scope)) === 'ecology') { const wf = await wfFill(scope, target, value); if (wf.ok) return `已（WfForm ${wf.fieldId}）填入「${target}」= ${value}` }
        const loc = step.sel ? await bySel(scope, step.sel) : locate(scope, 'textbox', target)
        try { await loc.fill(value, { timeout: 5000 }); return '已填入「' + target + '」= ' + value }
        catch (_) { await loc.click({ timeout: 4000 }).catch(() => {}); const pr = await pickResult(scope, value); return pr.ok ? '已点开并选中「' + value + '」' : '填写失败：' + (pr.error || '控件不可填') }
      }
      if (a === 'select' || a === 'dropdown') { say(log, 'acting', `[pw] 下拉「${target}」= ${value}`); const trig = step.sel ? await bySel(scope, step.sel) : locate(scope, 'combobox', target); await trig.click({ timeout: 5000 }); await page.waitForTimeout(500); const pr = await pickResult(scope, value); return pr.ok ? '已选择「' + target + '」= ' + value : '下拉未匹配：' + pr.error }
      if (a === 'search') {
        say(log, 'acting', `[pw] 检索「${target}」= ${value}`)
        const loc = step.sel ? await bySel(scope, step.sel) : locate(scope, 'searchbox', target)
        await loc.click({ timeout: 4000 }).catch(() => {}); try { await loc.fill(value, { timeout: 4000 }) } catch (_) { await page.keyboard.type(value) }
        // 泛微放大镜弹窗需先点「查询」才出结果；autocomplete 控件无此按钮则打字即出，跳过
        for (const s of [scope, page]) { try { const q = s.locator('.ant-modal-wrap:visible .ant-search-btn, .ant-modal:visible button:has-text("查询"), .ant-search-btn:visible').first(); if (await q.count() && await q.isVisible().catch(() => false)) { await q.click({ timeout: 3000 }); await page.waitForTimeout(600); break } } catch (_) { /* noop */ } }
        await page.waitForTimeout(700); const pr = await pickResult(scope, value); return pr.ok ? '已检索并选中「' + target + '」= ' + value : '检索未匹配：' + pr.error
      }
      if (a === 'picker') { say(log, 'acting', `[pw] 点开检索「${target}」`); const btn = step.sel ? await bySel(scope, step.sel) : locate(scope, 'button', target); await btn.click({ timeout: 6000 }); await page.waitForTimeout(800); return '已点开检索控件' }
      // ── 表格原语（与 Electron 版对齐）──────────────────────────────────────
      if (a === 'check') { say(log, 'acting', `[pw] 勾选行「${target}」`); const row = rowLoc(scope, target); const cb = row.getByRole('checkbox').first(); try { await cb.check({ timeout: 5000 }) } catch (_) { await cb.click({ timeout: 4000 }) } return `已勾选含「${target}」的行` }
      if (a === 'checkall') {
        say(log, 'acting', `[pw] ${value === 'uncheck' ? '取消全选' : '全选'}`)
        const head = scope.locator('thead input[type=checkbox], .ant-table-thead input[type=checkbox], [class*=select-all] input[type=checkbox], [class*=selectAll] input[type=checkbox]').first()
        try { if (value === 'uncheck') await head.uncheck({ timeout: 5000 }); else await head.check({ timeout: 5000 }) } catch (_) { await head.click({ timeout: 4000 }).catch(() => {}) }
        return `已${value === 'uncheck' ? '取消全选' : '全选'}表格`
      }
      if (a === 'rowaction' || a === 'deleterow') {
        const btnText = value || '删除'
        // 行删除本身即写：按钮名带写意图 → 写前签字
        if (opts.onWriteConfirm && WRITE_INTENT.test(btnText)) {
          const pageText = await scrapeContent()
          const signed = await opts.onWriteConfirm({ actionLabel: `对含「${target}」的行执行「${btnText}」`, pageText })
          if (!signed) { say(log, 'completed', `已在写入前取消：未执行「${btnText}」`); return `已在写入前被用户取消：未对含「${target}」的行执行「${btnText}」，未改动系统。请立即结束任务（finish），如实告知"已在提交前取消"。` }
        }
        say(log, 'acting', `[pw] 行操作「${target}」→ ${btnText}`)
        const row = rowLoc(scope, target)
        const btn = row.getByRole('button', { name: btnText }).or(row.getByText(btnText, { exact: true })).or(row.locator(`[title="${btnText}"], a[class*=icon], i[class*=icon], svg[onclick]`)).first()
        await btn.click({ timeout: 6000 }); await settle(2500)
        return `已对含「${target}」的行执行「${btnText}」`
      }
      if (a === 'rowset') {
        const col = String(step.column || '')
        say(log, 'acting', `[pw] 行内格「${target}」×「${col}」= ${value}`)
        const headers = scope.locator('thead th, thead td, [role=columnheader]')
        const hc = await headers.count(); let idx = -1
        for (let i = 0; i < hc; i++) { const t = (await headers.nth(i).innerText().catch(() => '')).replace(/\s+/g, '').trim(); if (t && (t === col || t.indexOf(col) >= 0)) { idx = i; break } }
        if (idx < 0) return `未找到列「${col}」，请先 inspect 看表头`
        const cell = rowLoc(scope, target).locator('td, [role=cell], [role=gridcell]').nth(idx)
        const inp = cell.locator('input, textarea, [contenteditable=true]').first()
        await inp.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(300)
        const pr = await pickResult(scope, value)   // 检索型格：点开后点候选
        if (pr.ok) return `已在「${target}」行「${col}」检索选中 ${value}`
        try { await inp.fill(value, { timeout: 4000 }); await pickResult(scope, value); return `已在「${target}」行「${col}」填入 ${value}` } catch (_) { return `rowset 落值失败：该格可能是检索型但未出候选，或列定位偏了` }
      }
      if (a === 'wf') { await scope.evaluate(({ id, val }: any) => (window as any).WfForm.changeFieldValue(id, { value: val }), { id: step.fieldId, val: value }); return `已（WfForm ${step.fieldId}）落值 ${value}` }
      return '未知动作：' + a
    } catch (e: any) { return `动作「${a}」失败：${e.message}` }
  }

  // 收尾：真系统先把（可能被服务端续期的）会话回写 storageState 仓库再关；上下文可放心关——登录态在仓库不在窗口。
  const close = async () => {
    if (!isBench) await captureState(ctx, systemId)
    try { await ctx.close() } catch (_) { /* noop */ }
  }
  // name/description/argsHint 与 Electron browse 工具同一份（BROWSE_DESC/ARGSHINT）→ 模型两端发同样的 action。
  return { name: 'browse', description: BROWSE_DESC, argsHint: BROWSE_ARGSHINT, run, cleanup: close, page: () => page, context: () => ctx, close }
}
