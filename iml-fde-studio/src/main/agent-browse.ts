// P3 · browse 工具：把 runSopAgent 的"观察→执行"原语泛化成通用浏览器 agent 工具。
// 对标 WebArena / 操作企业存量系统：agent 在真实网站里 goto/observe/read/click/fill/scroll/back 多步把事办成。
//
// 与 runSopAgent 的区别：runSopAgent 锁死"已知业务系统 + SOP + 只填表提交"；browse 是**开放式**——
// 任意 URL、完整动作空间、由外层 agent 循环临场决策。复用同一套语义定位原语（SEMANTIC_FN 按 label/文本/角色，
// 非坐标）与页面快照（SNAPSHOT_FN），所以在真实站点上的健壮性与录制回放/SOP 智能体同源。
//
// iframe/新窗口：企业门户（讯飞 iBPMS、泛微）把表单/列表嵌在 iframe、点链接开新窗口——
// observe/click/fill 跨 frame 聚合与逐帧执行；新窗口经 setWindowOpenHandler 并窗到同一离屏窗口（不冒可见弹窗）。
//
// ⚠️ Electron 依赖：用离屏 BrowserWindow。当前无头 bench harness 桩了 electron → browse 在 harness 里
// fail-fast（loadURL 桩失败）；真实端到端需"真实 Electron E2E harness"（见 docs/arch-general-agent-loop.md P3）。
// 安全：默认新分区 `agent-browse`（不带任何业务登录态）；WebArena/评测站的写在隔离测试站白名单内放开，
// 真实业务系统的写仍走"人工确认 + 一次性签名令牌"红线。
import { BrowserWindow } from 'electron'
import { SEMANTIC_FN, SNAPSHOT_FN, STRUCT_FN, PAGE_SETTLE_FN } from './browser-scripts'
import type { AgentTool } from './agent-loop'
import { swallow, sleep } from './util'
import type { SendLog } from './types'

interface SnapEl { tag: string; role: string; text: string; sel: string }
interface StructTable { headers: string[]; rows: { cells: string[]; hasCheckbox: boolean; actions: string[] }[]; selectAll: boolean; editCols?: string[] }
interface StructForm { label: string; type: string; required: boolean; options: string[] }
interface StructModel { tables: StructTable[]; forms: StructForm[] }

/** 写前签字钩子：browse 点「提交/同意/删除…」这类改变业务状态的按钮**之前**回调——把当前页面真实单据
 *  交调用方给用户过目签字，返回 false 则中止不点。安全红线：看清真实单据再批，绝不闭眼提交。 */
export type WriteConfirm = (ctx: { actionLabel: string; pageText: string }) => Promise<boolean>
// 写意图动词：点这些按钮=提交/改变业务状态，执行前须签字。行删除(rowaction/deleterow)本身即写，另行判定。
// 「确定/确认」不在列：拾取弹窗/人员选择里的「确定」是常规交互，逢确定必签字会把流程打断成弹卡轰炸；真正落库的是 提交/保存。
const WRITE_INTENT = /(提交|保存|保 存|提 交|发送|发布|同意|批准|通过|核准|驳回|拒绝|退回|删除|移除|作废|撤销|签退|签到|打卡|下单|付款|支付|结算)/

/**
 * 在页面上下文执行 JS，带**硬超时**。为什么必须有：click 提交/登录/链接会触发页面导航，
 * 旧页面上下文销毁时 `wc.executeJavaScript` 的 promise 可能**永不 resolve 也不 reject**（try/catch 拦不住），
 * 导致 browse 整个卡死（实测 mock-oa 登录按钮）。超时即返回 fallback，绝不 hang。
 */
async function evalJS<T>(wc: Electron.WebContents, script: string, ms: number, fallback: T): Promise<T> {
  try {
    return await Promise.race([
      wc.executeJavaScript(script).catch(() => fallback),
      new Promise<T>(res => setTimeout(() => res(fallback), ms)),
    ])
  } catch (e) { swallow(e, 'browse-eval'); return fallback }
}

/** 同 evalJS，但在**指定 frame**（子 iframe）里执行——跨 frame 观察/操作用。带同款硬超时。 */
async function evalInFrame<T>(frame: Electron.WebFrameMain, script: string, ms: number, fallback: T): Promise<T> {
  try {
    return await Promise.race([
      (frame.executeJavaScript(script) as Promise<T>).catch(() => fallback),
      new Promise<T>(res => setTimeout(() => res(fallback), ms)),
    ])
  } catch (e) { swallow(e, 'browse-eval-frame'); return fallback }
}

/** 当前所有 frame（主 frame + 所有子 iframe，含嵌套）。企业门户表单/列表常嵌 iframe，只看主 frame 会「看不见/点不到」。 */
function framesOf(wc: Electron.WebContents): Electron.WebFrameMain[] {
  try { const all = wc.mainFrame?.framesInSubtree; if (all && all.length) return all } catch (e) { swallow(e, 'browse-frames') }
  try { return wc.mainFrame ? [wc.mainFrame] : [] } catch { return [] }
}

export async function settle(wc: Electron.WebContents, maxMs = 6000): Promise<void> {
  await evalJS<null>(wc, `(${PAGE_SETTLE_FN})(${maxMs})`, maxMs + 1500, null)
}

/** 观察：当前页标题/URL + **跨 frame 聚合**的可交互元素清单（带编号，供 agent 下一步点/填时指名）。 */
export async function observe(wc: Electron.WebContents): Promise<string> {
  const meta = await evalJS<{ t: string; u: string }>(wc, `({t:document.title||'',u:location.href})`, 4000, { t: '', u: '' })
  // 主 frame + 各 iframe 各跑一次 SNAPSHOT_FN 并聚合（跨文档，parent 的 querySelectorAll 看不到 iframe 内部）。
  const all: SnapEl[] = []
  for (const f of framesOf(wc)) {
    if (all.length >= 60) break
    const els = await evalInFrame<SnapEl[]>(f, `(${SNAPSHOT_FN})()`, 4000, [])
    if (Array.isArray(els) && els.length) all.push(...els)
  }
  const list = all.slice(0, 40)
    .map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`)
    .join('\n')
  return `【当前页】${meta.t || '(无标题)'} | ${meta.u}\n【可交互元素（点/填时给出其文本作为 target）】\n${list || '(未捕获到可交互元素)'}`
}

/** 结构化感知（P0）：**跨 frame 聚合**表格/表单结构模型（STRUCT_FN 逐帧跑），供 agent 看清表格行/行操作/勾选、表单字段/候选。 */
export async function inspectStruct(wc: Electron.WebContents): Promise<StructModel> {
  const merged: StructModel = { tables: [], forms: [] }
  for (const f of framesOf(wc)) {
    if (merged.tables.length >= 8 && merged.forms.length >= 40) break
    const m = await evalInFrame<StructModel>(f, `(${STRUCT_FN})()`, 4500, { tables: [], forms: [] })
    if (m && Array.isArray(m.tables)) merged.tables.push(...m.tables)
    if (m && Array.isArray(m.forms)) merged.forms.push(...m.forms)
  }
  return merged
}

/** 把结构模型渲染成 agent 可读文本：表格给行/勾选/行操作，表单给字段/类型/候选/必填。 */
export function renderStruct(m: StructModel): string {
  const parts: string[] = []
  m.tables.slice(0, 6).forEach((tb, i) => {
    const head = (tb.headers || []).filter(Boolean).join(' | ')
    const rows = (tb.rows || []).slice(0, 15).map((r, ri) => {
      const cb = r.hasCheckbox ? ' [可勾选]' : ''
      const acts = (r.actions && r.actions.length) ? ` 行操作:${r.actions.join('/')}` : ''
      return `  行${ri}: ${(r.cells || []).join(' | ')}${cb}${acts}`
    }).join('\n')
    const ec = (tb.editCols && tb.editCols.length) ? `，可编辑列：${tb.editCols.join('/')}（用 rowset 填）` : ''
    parts.push(`表格${i + 1}（${head ? '列：' + head + '，' : ''}${(tb.rows || []).length} 行${tb.selectAll ? '，表头可全选' : ''}${ec}）:\n${rows || '  (无数据行)'}`)
  })
  if (m.forms && m.forms.length) {
    const fields = m.forms.slice(0, 30).map(f => {
      const opt = (f.options && f.options.length) ? `：${f.options.slice(0, 8).join('/')}` : ''
      return `  · ${f.label} [${f.type}${opt}]${f.required ? '（必填）' : ''}`
    }).join('\n')
    parts.push(`表单字段：\n${fields}`)
  }
  return parts.length ? `【页面结构】\n${parts.join('\n\n')}\n（删行：先勾选目标行再点表格「-/删除」按钮；填字段/选下拉用 fill/select 给字段名；**表格行内的单元格输入框**用 rowset(target=行文本,column=列名,value=值)，别用 fill）` : '（未识别到表格/表单结构；用 observe 看可交互元素）'
}

/** 读正文：**跨 frame 聚合**主 frame + 各 iframe 的可见文本（企业门户正文常在 iframe 里）。 */
async function readText(wc: Electron.WebContents): Promise<string> {
  const parts: string[] = []
  for (const f of framesOf(wc)) {
    if (parts.join('').length > 3200) break
    const t = await evalInFrame<string>(f, `(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,3000)`, 4000, '')
    if (t && t.trim() && !parts.includes(t.trim())) parts.push(t.trim())
  }
  return parts.join('\n---\n').slice(0, 3500)
}

// ═══════════ 真手层（治本改造）：读靠注入，动靠真实输入事件 ═══════════
// 合成事件（dispatchEvent）的 isTrusted=false，讯飞等自研企业组件（检索下拉/拾取器）的选中逻辑
// 挂在真实输入管线上，合成事件怎么派发都不认——二十轮真机测试坐实的瓶颈。
// 换法：注入 JS 只负责**定位**（locateOnly 返回元素坐标），主进程用 sendInputEvent 在该坐标
// 真实按下鼠标/真实敲键盘（isTrusted=true，与真人操作无法区分）。定位失败回退旧合成路径保底。

/** 子 frame 内坐标 → 主视图坐标：递归累加各级 iframe 元素在父文档中的偏移（按 URL 匹配；单 iframe 兜底）。 */
async function frameViewOffset(wc: Electron.WebContents, frame: Electron.WebFrameMain): Promise<{ x: number; y: number } | null> {
  try {
    if (!wc.mainFrame || frame === wc.mainFrame) return { x: 0, y: 0 }
    const parent = (frame as Electron.WebFrameMain & { parent: Electron.WebFrameMain | null }).parent
    if (!parent) return { x: 0, y: 0 }
    const up = await frameViewOffset(wc, parent)
    if (!up) return null
    const rect = await evalInFrame<{ x: number; y: number } | null>(parent, `(function(u){
      var fs=document.querySelectorAll('iframe,frame');
      for(var i=0;i<fs.length;i++){ try{ var s=fs[i].src||''; if(s&&(u===s||u.indexOf(s)===0||s.indexOf(u)===0)){ var b=fs[i].getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top)}; } }catch(e){} }
      if(fs.length===1){ var b2=fs[0].getBoundingClientRect(); return {x:Math.round(b2.left),y:Math.round(b2.top)}; }
      return null; })(${JSON.stringify(frame.url || '')})`, 3000, null)
    if (!rect) return null
    return { x: up.x + rect.x, y: up.y + rect.y }
  } catch (e) { swallow(e, 'frame-offset'); return null }
}

/** 真实鼠标点击（走浏览器输入管线，isTrusted=true）。 */
function trustedClick(wc: Electron.WebContents, x: number, y: number): void {
  try {
    wc.sendInputEvent({ type: 'mouseMove', x, y } as Electron.MouseInputEvent)
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  } catch (e) { swallow(e, 'trusted-click') }
}

/** 真实键盘输入（逐字符 char 事件——远程检索类控件靠真键触发）。 */
async function trustedType(wc: Electron.WebContents, text: string): Promise<void> {
  for (const ch of String(text)) {
    try { wc.sendInputEvent({ type: 'char', keyCode: ch } as Electron.KeyboardInputEvent) } catch (e) { swallow(e, 'trusted-type') }
    await sleep(35)
  }
}

/** 逐帧定位（locateOnly）：返回主视图坐标 + 所在 frame。 */
async function locateIn(wc: Electron.WebContents, step: Record<string, unknown>): Promise<{ x: number; y: number; frame: Electron.WebFrameMain } | null> {
  for (const f of framesOf(wc)) {
    const r = await evalInFrame<{ ok: boolean; found?: boolean; x: number; y: number } | null>(f, `(${SEMANTIC_FN})(${JSON.stringify({ ...step, locateOnly: true })})`, 5000, null)
    if (r && r.ok && r.found) {
      const off = await frameViewOffset(wc, f)
      if (!off) return null
      return { x: r.x + off.x, y: r.y + off.y, frame: f }
    }
  }
  return null
}

/** 清空当前聚焦的输入框（清空用注入无妨，输入必须真键）。 */
async function clearActive(frame: Electron.WebFrameMain): Promise<void> {
  await evalInFrame<null>(frame, `(function(){ var a=document.activeElement; if(a&&('value' in a)){ try{ a.select&&a.select(); }catch(e){} try{ var p=a.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; var s=Object.getOwnPropertyDescriptor(p,'value'); if(s&&s.set){ s.set.call(a,''); a.dispatchEvent(new Event('input',{bubbles:true})); } }catch(e){} } return null; })()`, 2000, null)
}

/** 真手执行一个动作。返回 null=该动作不走真手/定位失败（调用方回退合成路径）；返回文本=已完成（或明确失败说明）。 */
async function actTrusted(wc: Electron.WebContents, action: string, args: Record<string, unknown>, sendLog: SendLog): Promise<{ ok: boolean; text: string } | null> {
  const OPF: Record<string, string> = { click: 'click', fill: 'fill', search: 'searchSelect', select: 'select', dropdown: 'dropdown', rowset: 'rowSet', picker: 'openPicker' }
  const op = OPF[action]
  if (!op) return null
  const tgt = String(args.target || ''), val = String(args.value || ''), col = String(args.column || (args as Record<string, unknown>).col || ''), sel = String((args as Record<string, unknown>).sel || '')
  const pos = await locateIn(wc, { op, arg: tgt, value: val, col, sel })
  if (!pos) return null   // 定位失败 → 回退合成路径（含点击激活等兜底）
  sendLog('acting', `[真实输入] ${action}「${tgt || col}」${val ? ' = ' + val.slice(0, 20) : ''}`)
  if (action === 'click' || action === 'picker') {
    trustedClick(wc, pos.x, pos.y)
    await sleep(action === 'picker' ? 1000 : 700)
    return { ok: true, text: action === 'picker' ? '已（真实点击）点开检索控件' : `已（真实点击）点击「${tgt}」` }
  }
  // fill / search / rowset / select / dropdown：真实聚焦 → 清空 → 真键输入 → 轮询候选坐标 → 真实点击候选
  trustedClick(wc, pos.x, pos.y)
  await sleep(200)
  if (action === 'select' || action === 'dropdown') { await sleep(400) }   // 触发器点开即出候选，无需输入
  else { await clearActive(pos.frame); await trustedType(wc, val) }
  const budget = Date.now() + (action === 'fill' ? 4500 : 8000)
  let picked = false
  while (Date.now() < budget) {
    const r = await evalInFrame<{ ok: boolean; found?: boolean; x: number; y: number; error?: string } | null>(pos.frame, `(${SEMANTIC_FN})(${JSON.stringify({ op: 'locateOption', value: val })})`, 2500, null)
    if (r && r.ok && r.found) {
      const off = await frameViewOffset(wc, pos.frame)
      if (off) { trustedClick(wc, r.x + off.x, r.y + off.y); picked = true; await sleep(500) }
      break
    }
    await sleep(400)
  }
  if (picked) return { ok: true, text: `已（真实输入）在「${tgt || col}」填入并从候选中点选「${val}」` }
  if (action === 'fill' || action === 'rowset') return { ok: true, text: `已（真实输入）在「${tgt || col}」填入「${val}」（未出现候选，按纯文本格处理）` }
  return { ok: false, text: `已（真实输入）在「${tgt}」输入「${val}」但候选未出现/未匹配——请 observe 查看弹层状态后重试或换 picker` }
}

/**
 * 语义动作（click/fill/select）**逐 frame 执行**：主 frame 先试，未命中再逐个 iframe 试
 * （讯飞/泛微表单控件在 iframe 里）。命中（ok）即停；SEMANTIC_FN 对「元素不在本 frame」会快速返回 ok:false 不 hang，
 * 只有真点中触发导航时才会超时→按已执行处理（fallback ok:true）。
 */
export async function actAcrossFrames(wc: Electron.WebContents, step: object): Promise<{ ok: boolean; error?: string }> {
  const frames = framesOf(wc)
  let last: { ok: boolean; error?: string } = { ok: false, error: '未在页面找到该元素' }
  // 慢操作（rowSet/检索选择/下拉：填值后要轮询弹出候选并核验落值）给 9s；其余 3.5s（click 触发导航时靠超时兜底）。
  const slowOps = new Set(['rowSet', 'searchSelect', 'search', 'dropdown', 'select', 'fill'])
  const ms = slowOps.has(String((step as Record<string, unknown>).op || '')) ? 9000 : 3500
  for (const f of frames) {
    const r = await evalInFrame<{ ok: boolean; error?: string }>(f, `(${SEMANTIC_FN})(${JSON.stringify(step)})`, ms, { ok: true })
    if (r && r.ok) return r
    if (r) last = r
  }
  return last
}

/**
 * 构造 browse 工具。会话（离屏窗口）在多次 browse 调用间**持久复用**；
 * 循环结束后由 runAgentLoop 的 finally 统一调用 tool.cleanup() 关闭，绝不泄漏窗口。
 */
export function makeBrowseTool(opts?: { partition?: string; onWriteConfirm?: WriteConfirm; visible?: boolean }): AgentTool {
  // 分区默认 `agent-browse`（无业务登录态，WebArena/开放网页用）；本体兜底执行传 `persist:bizsys-<系统id>`，
  // 复用「设置→企业系统连接」里的受管登录态——凭证只在本地、绝不上传，也不必对话传密码（红线）。
  const partition = opts?.partition || 'agent-browse'
  const onWriteConfirm = opts?.onWriteConfirm   // 写前签字钩子（写入类技能执行时由调用方注入；未注入=不拦，如只读/评测站）
  let win: BrowserWindow | null = null
  const ensureWin = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win
    // visible=可视化执行窗（用户亲眼看 agent 操作，方便调试定位失败原因 + 建立信任）；默认离屏后台跑。
    win = new BrowserWindow({ show: !!opts?.visible, width: 1366, height: 900, title: 'iML 分身操作中 · 请勿手动干预', webPreferences: { offscreen: !opts?.visible, partition } })
    win.webContents.setAudioMuted(true)
    // 新窗口并窗（移植自录制引擎 browser-automation）：企业门户点链接/流程常开新窗口（讯飞 iBPMS 开表单、泛微门户等）——
    // 离屏窗口默认会弹出**可见**子窗口、且 agent 丢失控制（实测讯飞OA「还是打开弹窗」）。改为 deny 弹窗、把其 URL 在
    // **同一离屏窗口**里加载（并窗）：既不冒可见弹窗，agent 也能跟进该导航继续在受控离屏窗口里操作。
    win.webContents.setWindowOpenHandler(({ url }) => {
      try { if (win && !win.isDestroyed() && /^(https?|file):\/\//i.test(url)) win.loadURL(url).catch(() => {}) } catch (e) { swallow(e, 'browse-winopen') }
      return { action: 'deny' }
    })
    return win
  }

  const tool: AgentTool = {
    name: 'browse',
    description: '在真实浏览器里访问和操作网页，多步把任务办成。动作：goto 导航到 URL；observe 观察当前页可交互元素；inspect 查看页面结构（表格的行/勾选/行操作、表单字段/下拉候选/必填——遇到表格或表单时用它看清结构）；read 读取页面正文；click 点击某元素（给其文本）；fill 在某输入框填值；select 选下拉（target=字段名, value=选项）；search 自动补全类选择（target=字段名, value=要输入并从候选里选中的值，如自选审批人）；check 勾选表格中某一行（target=该行可辨识文本，如日期）；checkall 表格表头全选（value=uncheck 则全不选）；rowaction 点表格某行的操作按钮（target=行文本, value=按钮文本如删除，省略则删除）；rowset 在表格某行的单元格里填值/检索选择（target=行文本, column=列头名如\"类型\"/\"原因说明\", value=要填的值——**行内小输入框用它，别用 fill**，填后若弹出候选会自动点中匹配项）；picker 点开**放大镜/拾取器控件**的检索弹窗（带放大镜图标、直接打字留不住的控件必须用它：picker(target=字段标签或行文本, column=行内列名) 打开弹窗 → 在弹窗里 **search(value=要选的值)** 搜索并自动点中结果（搜索后必须点中结果才真正落值，search 会自动点） → observe 核实值已落 → 如有「确定」再 click）；hover 悬停展开菜单入口（target=菜单文本，用于多级菜单要先悬停才展开的门户）；scroll 向下滚动；back 后退。每次只做一个动作，先 goto 再 observe/inspect 看清页面，再逐步操作。表单/列表在 iframe 里也能看到和操作（已跨 frame）。',
    argsHint: '{"action":"goto|observe|inspect|read|click|fill|select|search|check|checkall|rowaction|rowset|picker|hover|scroll|back","url":"https://…（goto用）","target":"元素文本/字段名/行文本/菜单文本","value":"要填/选/勾的值或行操作按钮文本","column":"rowset 用：列头名","sel":"可选：录制轨迹里的 CSS 选择器（[sel=…]），带上则精确直达该元素"}',
    run: async (args: Record<string, unknown>, sendLog: SendLog): Promise<string> => {
      const action = String(args.action || '').toLowerCase()
      try {
        const w = ensureWin()   // 桩 harness 里 new BrowserWindow 会失败 → 落到 catch 返回文本，不抛出中断循环
        const wc = w.webContents
        if (action === 'goto') {
          const url = String(args.url || '').trim()
          if (!/^(https?|file):\/\//i.test(url)) return 'goto 需要合法的 http(s)/file URL'   // file:// 供本地 fixture 冒烟
          sendLog('acting', `[browse] 导航到 ${url.slice(0, 80)}`)
          await Promise.race([w.loadURL(url).catch(() => {}), sleep(12000)])   // loadURL 遇慢资源可能不 resolve → 超时兜底
          await settle(wc)
          return await observe(wc)
        }
        if (action === 'observe') return await observe(wc)
        if (action === 'inspect') return renderStruct(await inspectStruct(wc))
        if (action === 'read') {
          const text = await readText(wc)
          return `【页面正文】\n${text || '(空)'}`
        }
        if (action === 'back') {
          if (wc.canGoBack()) wc.goBack()
          await settle(wc)
          return await observe(wc)
        }
        if (action === 'scroll') {
          await evalJS<null>(wc, `window.scrollBy(0, Math.round(window.innerHeight*0.85))`, 2000, null)
          await sleep(500)
          return await observe(wc)
        }
        const OP_MAP: Record<string, string> = { search: 'searchSelect', check: 'checkRow', rowaction: 'rowAction', deleterow: 'rowAction', checkall: 'checkAll', hover: 'hover', rowset: 'rowSet', picker: 'openPicker' }
        if (action in OP_MAP || action === 'click' || action === 'fill' || action === 'select') {
          // search→autocomplete；check→勾选表格行；rowaction/deleterow→点某行操作按钮(默认删除)；checkall→表头全选；hover→展开菜单
          const op = OP_MAP[action] || action
          const step = { op, arg: String(args.target || ''), value: String(args.value || ''), sel: String((args as Record<string, unknown>).sel || ''), col: String((args as Record<string, unknown>).column || (args as Record<string, unknown>).col || '') }
          // ── 真手优先（治本）：定位成功即用真实输入事件执行；失败回退下方合成路径（含点击激活等兜底）──
          const noTrust = action === 'check' || action === 'checkall' || action === 'rowaction' || action === 'deleterow' || action === 'hover'   // 已验证可靠/写闸另管的动作走原路
          if (!noTrust && !(action === 'click' && !!onWriteConfirm && WRITE_INTENT.test(String(args.target || '')))) {
            const tr = await actTrusted(wc, action, args as Record<string, unknown>, sendLog)
            if (tr) {
              await settle(wc)
              if (!tr.ok) return tr.text
              return `${tr.text}。\n${await observe(wc)}`
            }
          }
          // 写前签字（安全红线）：点「提交/同意/删除…」写按钮、或行删除**之前**，把当前页面真实单据交调用方给用户签字，
          // 未签则中止不点（保留"看清真实单据再批"，绝不闭眼提交）。只读动作/评测站不注入 onWriteConfirm，此段自然跳过。
          // 行操作只有**按钮名带写意图**才签字（value 缺省=删除→签）：agent 探索性点击行内普通文本（如"小时"）
          // 不该弹签字卡——实测弹出"小时含「…」的行"这种看不懂的卡，用户点了确认也只是点了下无害文本。
          const rowBtn = String(args.value || '删除')
          const isWriteCommit = !!onWriteConfirm && ((action === 'click' && WRITE_INTENT.test(String(args.target || ''))) || ((action === 'rowaction' || action === 'deleterow') && WRITE_INTENT.test(rowBtn)))
          if (isWriteCommit) {
            const actionLabel = (action === 'rowaction' || action === 'deleterow') ? `对含「${args.target}」的行执行「${rowBtn}」` : String(args.target || '提交')
            const pageText = await readText(wc)
            const signed = await onWriteConfirm!({ actionLabel, pageText })
            if (!signed) {
              sendLog('completed', `已在写入前取消：未执行「${actionLabel}」`)
              return `已在写入前被用户取消：未执行「${actionLabel}」，未对系统做任何改动。请立即结束任务（finish），如实告知用户"已在提交前取消，未改动系统"。`
            }
          }
          // 逐 frame 执行：click 触发导航时 SEMANTIC_FN 的 executeJavaScript 会随上下文销毁而永挂，
          // 超时即视为"已执行且触发了导航"（fallback ok:true），交给下面的 settle/observe（同样超时保护）。
          const r = await actAcrossFrames(wc, step)
          if (action === 'click' || action === 'rowaction' || action === 'deleterow') await sleep(700)   // 给可能的导航/行删除一点落地时间
          if (action === 'picker') await sleep(1000)   // 给检索弹窗渲染时间（弹窗可能是 iframe）
          await settle(wc)
          if (!r || !r.ok) return `${action}「${args.target}」失败：${r?.error || '未在页面找到该元素'}。请先 observe/inspect 看清当前元素与页面结构（表格行/字段）。`
          const done = action === 'picker' ? `已点开检索弹窗（若下方 observe 未见弹窗，放大镜可能没点中，可重试或换 rowset）`
            : action === 'rowset' ? `已在「${args.target}」行的「${(args as Record<string, unknown>).column}」填入 ${args.value}`
            : action === 'search' ? `已在「${args.target}」输入并选择 ${args.value}`
            : action === 'check' ? `已勾选含「${args.target}」的行`
            : (action === 'rowaction' || action === 'deleterow') ? `已对含「${args.target}」的行执行${args.value || '删除'}`
            : action === 'checkall' ? `已${args.value === 'uncheck' ? '取消全选' : '全选'}表格`
            : action === 'hover' ? `已悬停展开「${args.target}」`
            : `已${action}「${args.target}」${action === 'fill' ? ' = ' + args.value : ''}`
          return `${done}。\n${await observe(wc)}`
        }
        return `未知 browse 动作「${action}」。可用：goto/observe/inspect/read/click/fill/select/search/check/checkall/rowaction/hover/scroll/back`
      } catch (e: any) {
        return `browse 执行出错：${e?.message || e}`
      }
    },
    cleanup: async (): Promise<void> => {
      try { if (win && !win.isDestroyed()) win.close() } catch (e) { swallow(e, 'browse-close') }
      win = null
    },
  }
  return tool
}
