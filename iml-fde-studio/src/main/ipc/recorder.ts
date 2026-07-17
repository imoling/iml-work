// 浏览器自动化：录制（Playwright 真实 Chrome）+ 录制后步骤清洗（合并搜索/去冗余/归并点选）。
import { ipcMain } from 'electron'
import { RECORDER_JS } from '../automation'
import { rt, chromium, profileDir, toolSend } from './runtime'

// 空标签 = 没有自身文字（开下拉/搜索框/级联标题的触发器），或纯字符计数(0/2000)
function isBlankLabel(l: any): boolean {
  const t = String(l || '').trim()
  return !t || /^\d+\s*\/\s*\d+$/.test(t)
}
// 结果项文字清洗：去「最近使用」前缀、压空白、截断
function cleanPick(l: any): string {
  return String(l || '').replace(/^最近使用\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 40)
}
// 归并「开下拉的空标签 click + 紧随的有标签 click(结果项)」→ 一个可参数化的 search 字段。
// 讯飞/纷享的客户/联系人/部门等关联对象是"点开搜索框→点结果项"两步 click，
// 不归并就会焊死成 click 的具体值（中石油/李主任），审阅区也够不着、无法参数化。
// 归并后它们成为可命名、可标「参数」的字段，SOP 也写成「填入{{拜访客户}}」而非具体值。
function mergeSelections(steps: any[]): any[] {
  const isOpener = (s: any) => s && s.act === 'click' && !s.nav && isBlankLabel(s.label)
  const out: any[] = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], nx = steps[i + 1]
    // 开下拉空 click 紧接 fill：丢弃这个聚焦 click（fill 本身已能定位输入框）
    if (isOpener(s) && nx && nx.act === 'fill') continue
    // 开下拉空 click + 有标签且无导航的 click(结果项) → 合并成一个 search 字段
    if (isOpener(s) && nx && nx.act === 'click' && !nx.nav && !isBlankLabel(nx.label)) {
      out.push({ act: 'search', label: '', value: cleanPick(nx.label), fp: s.fp, result: nx.fp, menu: true })
      i++
      continue
    }
    out.push(s)
  }
  return out
}
// 录制后清洗：fill+紧随的 pickOption 合并为 search(带+检索框)；丢冗余 hover；去连续重复
function refineSteps(raw: any[]): any[] {
  // 先把"点击后实际导航"(navResult) 合并进其前一个 click，覆盖 href 占位(#/000)抓不到的真实路由
  const merged: any[] = []
  for (const s of raw) {
    if (s.act === 'navResult') {
      for (let k = merged.length - 1; k >= 0; k--) {
        if (merged[k].act === 'click') { merged[k].nav = s.nav; break }
      }
      continue
    }
    merged.push(s)
  }
  raw = merged
  const a: any[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i], nx = raw[i + 1]
    if (s.act === 'fill' && nx && nx.act === 'pickOption') { a.push({ act: 'search', label: s.label, value: nx.value, fp: s.fp }); i++; continue }
    a.push(s)
  }
  const res: any[] = []
  for (let j = 0; j < a.length; j++) {
    const s = a[j], nx = a[j + 1]
    const ssel = s.fp && s.fp.sel
    if (s.act === 'hover' && nx && nx.fp && ssel && nx.fp.sel === ssel) continue
    const prev = res[res.length - 1]
    if (prev && prev.act === s.act && prev.fp && ssel && prev.fp.sel === ssel && prev.value === s.value) continue
    res.push(s)
  }
  // 折叠"为展开折叠菜单而做的 hover / 菜单点击"：哈希导航点击自带跳转，前面的展开手势可丢弃
  const out: any[] = []
  for (const s of res) {
    if (s.act === 'click' && s.nav) {
      while (out.length) {
        const p = out[out.length - 1]
        if (p.act === 'hover' || (p.act === 'click' && p.menu && !p.nav)) out.pop()
        else break
      }
    }
    out.push(s)
  }
  // 最后归并点选关联对象（开下拉+选结果 → 可参数化字段）
  return mergeSelections(out)
}

function attachRecorder(ctx: any): void {
  const onConsole = (msg: any) => {
    let t = ''
    try { t = msg.text() } catch (_) { return }
    if (typeof t !== 'string' || !t.startsWith('__IMLREC__')) return
    try {
      const step = JSON.parse(t.slice('__IMLREC__'.length))
      const last = rt.recorderSteps[rt.recorderSteps.length - 1]
      if (step.act === 'fill' && last && last.act === 'fill' && last.fp && step.fp && last.fp.sel === step.fp.sel) last.value = step.value
      else rt.recorderSteps.push(step)
      toolSend('recorder:step', { act: step.act, label: step.label, value: step.value })
    } catch (_) {}
  }
  ctx.on('page', (p: any) => p.on('console', onConsole))
  ctx.pages().forEach((p: any) => p.on('console', onConsole))
}

export function register(): void {
  ipcMain.handle('recorder:start', async (_e, { systemId, baseUrl, systemName }: any) => {
    try {
      if (rt.recorderCtx) { try { await rt.recorderCtx.close() } catch (_) {} rt.recorderCtx = null }
      rt.recorderSteps = []
      const ctx = await chromium().launchPersistentContext(profileDir(systemId), { channel: 'chrome', headless: false, viewport: null, args: ['--no-first-run'] })
      rt.recorderCtx = ctx
      await ctx.addInitScript(RECORDER_JS)
      attachRecorder(ctx)
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('recorder:stop', async () => {
    const raw = rt.recorderSteps.slice()
    const steps = refineSteps(raw)
    const pages = rt.recorderCtx ? rt.recorderCtx.pages().length : 1
    if (rt.recorderCtx) { try { await rt.recorderCtx.close() } catch (_) {} rt.recorderCtx = null }
    // 读取/写入分流：含填写/选择/检索即为写入类，否则为读取类（纯导航/查看）。
    // 读取类技能在客户端走"SOP 打开页面+按导航直达+抓取"，不必脆弱回放，更稳。
    const isWrite = steps.some((s: any) => ['fill', 'select', 'search', 'pickOption'].includes(s.act))
    const navHash = (steps.find((s: any) => s.act === 'click' && s.nav) || {}).nav || ''
    // 录制诊断：把"操作落在几个 frame / 有多少空标签步 / 开了几个窗口"暴露给前端，
    // 让门户这类 iframe 聚合 / 新窗口打开子系统的场景一眼看出"缺在哪"，而不是默默丢步。
    const frameSet = new Set<string>()
    let iframeSteps = 0, blankLabel = 0
    for (const s of raw as any[]) {
      if (s.frameUrl) frameSet.add(String(s.frameUrl).split('#')[0])
      if (s.inIframe) iframeSteps++
      if (['click', 'hover'].includes(s.act) && !String(s.label || '').trim()) blankLabel++
    }
    const diag = { rawSteps: raw.length, keptSteps: steps.length, frames: frameSet.size, iframeSteps, blankLabel, pages }
    return { ok: true, steps, skillKind: isWrite ? 'write' : 'read', navHash, diag }
  })

  ipcMain.handle('recorder:cancel', async () => {
    rt.recorderSteps = []
    if (rt.recorderCtx) { try { await rt.recorderCtx.close() } catch (_) {} rt.recorderCtx = null }
    return { ok: true }
  })
}

export { refineSteps, mergeSelections }
