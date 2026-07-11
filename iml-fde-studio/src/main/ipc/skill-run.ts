// 浏览器自动化：试运行（Playwright 真实 Chrome，多种体检 + agentic 引擎）+ 技能测试（一句话→提炼字段→执行整链路）。
import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { SNAPSHOT_FN, runAgentic, runAgenticSop, sleep } from '../automation'
import { rt, launchCtx, toolSend, callRelay, callRelayTools } from './runtime'

export function register(): void {
  // ===== 浏览器自动化：试运行（Playwright 真实 Chrome，agent 主驱动）=====
  ipcMain.handle('skill:dry-run', async (_e, { systemId, baseUrl, systemName, steps, fieldValues, sop, adminBaseUrl, mode, navHash, headless }: any) => {
    try {
      if (rt.dryCtx) { try { await rt.dryCtx.close() } catch (_) {} rt.dryCtx = null }
      const ctx = await launchCtx(systemId, headless)
      rt.dryCtx = ctx
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      // 登录态检查
      const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
      if ((txt || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test((txt || '').toLowerCase())) {
        toolSend('dryrun:line', headless ? '无头模式下检测到未登录：请先关掉「无头浏览器」、在弹出窗口登录一次（登录态会本地保留），之后再开无头跑。' : '检测到未登录目标系统，请在试运行窗口登录后重试（登录态会本地保留）。')
        return { ok: true, loggedIn: false, done: 0, total: (steps || []).length }
      }
      // ARIA 体检：navHash 直达后 dump 无障碍树，评估"语义感知"够不够（决定 ARIA 树 vs Stagehand）
      if (mode === 'aria-probe') {
        const dump = async (label: string) => {
          let ax: any = null
          try { ax = await page.accessibility.snapshot({ interestingOnly: false }) } catch (e: any) { toolSend('dryrun:line', `── ${label}：AX 快照失败 ${e.message}`); return }
          const flat: any[] = []
          ;(function walk(n: any) { if (!n) return; flat.push({ role: n.role, name: n.name || '' }); (n.children || []).forEach(walk) })(ax)
          const FIELD = ['textbox', 'combobox', 'searchbox', 'spinbutton', 'checkbox', 'radio', 'listbox', 'switch', 'slider']
          const fields = flat.filter(n => FIELD.includes(n.role))
          const labels = flat.filter(n => n.role === 'LabelText' && n.name).map(n => n.name)
          const btns = flat.filter(n => n.role === 'button' && n.name)
          const counts: any = {}; flat.forEach(n => { counts[n.role] = (counts[n.role] || 0) + 1 })
          const topRoles = Object.entries(counts).sort((a: any, b: any) => b[1] - a[1]).slice(0, 10).map(([k, v]) => k + '=' + v).join(' ')
          toolSend('dryrun:line', `── ${label}：AX 节点 ${flat.length}；角色 ${topRoles}`)
          toolSend('dryrun:line', `   ▶ 表单字段(${fields.length})：` + (fields.slice(0, 30).map(n => `${n.role}"${n.name}"`).join('  ') || '无'))
          toolSend('dryrun:line', `   ▶ 字段标签 LabelText(${labels.length})：` + (labels.slice(0, 30).join(' / ') || '无'))
          toolSend('dryrun:line', `   ▶ 命名按钮(${btns.length})：` + (btns.slice(0, 20).map(n => `"${n.name}"`).join(' ') || '无'))
        }
        toolSend('dryrun:line', '【ARIA 体检】评估页面无障碍树是否够 agent 看懂…')
        if (navHash) { try { await page.evaluate((h: any) => { if (location.hash !== h) location.hash = h }, navHash) } catch (_) {}; await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleep(2800) }
        await dump('当前页(列表)')
        try {
          const nb = page.getByText('新建', { exact: true }).first()
          if (await nb.count()) { toolSend('dryrun:line', '→ 用文本「新建」找到入口，点击打开表单…'); await nb.click({ timeout: 6000 }); await sleep(2800); await dump('新建表单') }
          else { toolSend('dryrun:line', '⚠️ 列表页用文本「新建」未定位到按钮（可能 a11y 偏弱或在 iframe）') }
        } catch (e: any) { toolSend('dryrun:line', '打开表单失败：' + e.message) }
        // dump「销售平台归属」自定义控件的真实 DOM 结构（不再靠猜）
        try {
          const struct = await page.evaluate(() => {
            const norm = (s: any) => (s || '').replace(/\s+/g, ' ').trim()
            const all = Array.from(document.querySelectorAll('*'))
            let el: any = null
            for (const e of all) {
              const t = norm(e.textContent), ph = e.getAttribute && (e.getAttribute('placeholder') || '')
              if (((t === '请先选择销售平台归属' || (t.indexOf('销售平台归属') >= 0 && t.length < 16)) || (ph && ph.indexOf('销售平台') >= 0)) && e.children.length <= 2) { el = e; break }
            }
            if (!el) return '未找到「销售平台归属」元素'
            const desc = (n: any) => { if (!n) return ''; const c = (n.getAttribute && n.getAttribute('class')) || ''; const role = n.getAttribute && n.getAttribute('role'); return n.tagName.toLowerCase() + (typeof c === 'string' && c ? '.' + c.trim().split(/\s+/).slice(0, 4).join('.') : '') + (role ? '[role=' + role + ']' : '') }
            const chain: any[] = []; let p = el; for (let i = 0; i < 6 && p && p.tagName !== 'BODY'; i++) { chain.push(desc(p)); p = p.parentElement }
            const box = el.closest('[class*=form-item],[class*=formItem],[class*=field],[class*=form_item],tr,li') || el.parentElement
            return '命中元素链(内→外)：\n  ' + chain.join('\n  ↑ ') + '\n容器 HTML(截断)：\n' + (box ? norm(box.outerHTML).slice(0, 700) : '(无)')
          })
          toolSend('dryrun:line', '—— 销售平台归属 控件结构 ——')
          String(struct).split('\n').forEach((l: string) => toolSend('dryrun:line', l))
        } catch (e: any) { toolSend('dryrun:line', '控件结构 dump 失败：' + e.message) }
        return { ok: true, loggedIn: true, done: 1, total: 1, failedAt: -1 }
      }
      // 操作体检：一锤定音——程序能否真正操作纷享控件（下拉开不开、fill 写不写得进）
      if (mode === 'actuate-probe') {
        const sleepP = (ms: number) => new Promise(r => setTimeout(r, ms))
        toolSend('dryrun:line', '【操作体检】测试程序能否真正驱动纷享控件')
        if (navHash) { try { await page.evaluate((h: any) => { if (location.hash !== h) location.hash = h }, navHash) } catch (_) {}; await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleepP(2500) }
        try { const nb = page.getByText('新建', { exact: true }).first(); if (await nb.count()) { await nb.click({ timeout: 6000 }); await sleepP(2800); toolSend('dryrun:line', '已点「新建」打开表单') } } catch (e: any) { toolSend('dryrun:line', '点新建失败：' + e.message) }
        let ff = page.mainFrame()
        for (const f of page.frames()) { try { if (await f.locator('.f-item-inner.j-comp-wrap, .crm-widget').count()) { ff = f; break } } catch (_) {} }
        toolSend('dryrun:line', `表单 frame：${ff === page.mainFrame() ? '主框架' : 'iframe'}（共 ${page.frames().length} 个 frame）`)
        const tag = async (label: string, sub: string) => { try { return await ff.evaluate(({ lab, sub }: any) => { document.querySelectorAll('[data-iml-pb]').forEach(e => e.removeAttribute('data-iml-pb')); const norm = (s: any) => (s || '').replace(/\s+/g, ' ').trim(); for (const w of Array.from(document.querySelectorAll('.f-g-item,[class*=f-item-wrap]'))) { const t = w.querySelector('.f-g-item-tit,[class*=item-tit]'); if (t && norm(t.textContent).indexOf(lab) >= 0) { const el = w.querySelector(sub); if (el) { el.setAttribute('data-iml-pb', '1'); return true } } } return false }, { lab: label, sub }) } catch (_) { return false } }
        const visOpts = async () => { try { return await ff.evaluate(() => { const vis = (n: any) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }; const out: any[] = []; document.querySelectorAll('.j-search-item,.crm-w-select li,[class*=select-list] li,[class*=options] li,[role=option],.ant-select-dropdown li,li[class*=item]').forEach((n: any) => { if (vis(n)) { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 24) out.push(t) } }); return out }) } catch (_) { return [] } }
        // ① select_one：销售平台归属 —— 点 .select-tit 看下拉开不开
        try {
          const before = (await visOpts()).length
          if (await tag('销售平台归属', '.select-tit,.j-select-input,.tit-con')) {
            await ff.locator('[data-iml-pb="1"]').first().click({ timeout: 5000 }); await sleepP(1300)
            const after = await visOpts()
            toolSend('dryrun:line', `① 销售平台归属(下拉)：点 .select-tit 后 可见选项 ${before}→${after.length} ${after.length > before ? '✅ 下拉打开了' : '❌ 没反应'}`)
            if (after.length) toolSend('dryrun:line', '   选项样例：' + after.slice(0, 8).join(' | '))
          } else toolSend('dryrun:line', '① 销售平台归属：未按标签找到 .select-tit')
        } catch (e: any) { toolSend('dryrun:line', '① 失败：' + e.message) }
        // ② object_reference：客户名称 —— fill 检索框看结果
        try {
          if (await tag('客户名称', '.j-search-ipt,input.search-ipt,input[type=text],input')) {
            const ipt = ff.locator('[data-iml-pb="1"]').first()
            await ipt.click({ timeout: 4000 }).catch(() => {}); await ipt.fill('中国石油', { timeout: 4000 }); await sleepP(1600)
            const val = await ipt.inputValue().catch(() => '')
            const results = await ff.evaluate(() => { const out: any[] = []; document.querySelectorAll('.j-search-list li,.result-wrap li').forEach((n: any) => { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t) out.push(t) }); return out })
            toolSend('dryrun:line', `② 客户名称(检索)：fill「中国石油」后 输入框值="${val}" ${val ? '✅' : '❌没填进'}，检索结果 ${results.length} 条 ${results.length ? '✅' : '❌没出结果'}`)
            if (results.length) toolSend('dryrun:line', '   结果样例：' + results.slice(0, 5).join(' | '))
          } else toolSend('dryrun:line', '② 客户名称：未找到 .j-search-ipt')
        } catch (e: any) { toolSend('dryrun:line', '② 失败：' + e.message) }
        // ③ 文本：当前进展 —— fill textarea 看值写没写进
        try {
          if (await tag('当前进展', 'textarea,input[type=text]')) {
            const ta = ff.locator('[data-iml-pb="1"]').first()
            await ta.fill('测试录入内容', { timeout: 4000 }); await sleepP(500)
            const val = await ta.inputValue().catch(() => '')
            toolSend('dryrun:line', `③ 当前进展(文本)：fill 后值="${val}" ${val === '测试录入内容' ? '✅ 写入成功' : '❌ 没写进去'}`)
          } else toolSend('dryrun:line', '③ 当前进展：未找到 textarea')
        } catch (e: any) { toolSend('dryrun:line', '③ 失败：' + e.message) }
        toolSend('dryrun:line', '【体检完成】把以上 ①②③ 结果贴回，即可判定 DOM 操作能否走通。')
        return { ok: true, loggedIn: true, done: 1, total: 1, failedAt: -1 }
      }
      // 字段&选项快照：读出表单每个字段的类型，下拉读出真实可选项 → SOP 阶段锁定取值
      if (mode === 'schema-probe') {
        const sleepP = (ms: number) => new Promise(r => setTimeout(r, ms))
        toolSend('dryrun:line', '【字段&选项】读取表单字段类型 + 下拉真实可选项')
        if (navHash) { try { await page.evaluate((h: any) => { if (location.hash !== h) location.hash = h }, navHash) } catch (_) {}; await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleepP(2500) }
        try { const nb = page.getByText('新建', { exact: true }).first(); if (await nb.count()) { await nb.click({ timeout: 6000 }); await sleepP(2800) } } catch (_) {}
        let ff = page.mainFrame()
        for (const f of page.frames()) { try { if (await f.locator('.f-item-inner.j-comp-wrap, .crm-widget').count()) { ff = f; break } } catch (_) {} }
        const fields = await ff.evaluate(() => {
          const norm = (s: any) => (s || '').replace(/\s+/g, ' ').trim()
          const vis = (n: any) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
          const out: any[] = []
          document.querySelectorAll('.f-g-item, [class*=f-item-wrap]').forEach((w: any) => {
            const titEl = w.querySelector('.f-g-item-tit, .f-item-tit, [class*=item-tit]')
            const label = norm(titEl ? titEl.textContent : '').replace(/^[*\s]+/, '').replace(/[?？*\s]+$/, '')
            if (!label || label.length > 20) return
            const inner = w.querySelector('.f-item-inner.j-comp-wrap, .crm-a-field-selectone, .crm-action-field-lookup, [data-type]')
            if (!inner || !vis(inner)) return
            let dtype = (inner.getAttribute && inner.getAttribute('data-type')) || ''
            if (!dtype) { const c = (inner.className || '') + ''; dtype = c.indexOf('selectone') >= 0 ? 'select_one' : c.indexOf('lookup') >= 0 ? 'object_reference' : w.querySelector('.select-tit,.j-select-input') ? 'select_one' : w.querySelector('.j-search-ipt') ? 'object_reference' : w.querySelector('textarea') ? 'long_text' : 'text' }
            const req = !!(w.className.indexOf('required') >= 0 || (titEl && titEl.querySelector('[class*=required],.required')) || (titEl && /[*＊]/.test(titEl.textContent)))
            if (!out.find((o: any) => o.label === label)) out.push({ label, dtype, req })
          })
          return out
        })
        toolSend('dryrun:line', `共 ${fields.length} 个字段：`)
        for (const f of fields) {
          const tname = f.dtype === 'select_one' ? '下拉' : f.dtype === 'object_reference' ? '检索' : (f.dtype === 'long_text' || f.dtype === 'text') ? '文本' : f.dtype
          if (f.dtype !== 'select_one') { toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [${tname}]`); continue }
          // 下拉：先关掉上一个可能没关的浮层，再检查是否被锁，再打开读选项、读完即关
          try {
            await page.keyboard.press('Escape').catch(() => {}); await sleepP(250)
            const state = await ff.evaluate((lab: any) => {
              document.querySelectorAll('[data-iml-pb]').forEach(e => e.removeAttribute('data-iml-pb'))
              const norm = (s: any) => (s || '').replace(/\s+/g, ' ').trim()
              for (const w of Array.from(document.querySelectorAll('.f-g-item,[class*=f-item-wrap]'))) {
                const t = w.querySelector('.f-g-item-tit,[class*=item-tit]')
                if (t && norm(t.textContent).indexOf(lab) >= 0) {
                  if (w.querySelector('.f-disable') || (w as any).className.indexOf('disable') >= 0) return 'disabled'
                  const el = w.querySelector('.select-tit,.j-select-input,.select-icon'); if (el) { el.setAttribute('data-iml-pb', '1'); return 'ok' }
                }
              }
              return 'notfound'
            }, f.label)
            if (state === 'disabled') { toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [下拉] （被前置项锁定，需先选上级字段才能读/填）`); continue }
            if (state !== 'ok') { toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [下拉] （打不开，跳过）`); continue }
            await ff.locator('[data-iml-pb="1"]').first().click({ timeout: 2500 }); await sleepP(800)
            const opts = await ff.evaluate(() => { const vis = (n: any) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }; const out: any[] = []; document.querySelectorAll('.j-search-item,.crm-w-select li,[class*=select-list] li,[class*=options] li,[role=option],li[class*=item],dd').forEach((n: any) => { if (vis(n)) { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 24 && out.indexOf(t) < 0) out.push(t) } }); return out.slice(0, 40) })
            toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [下拉] 可选(${opts.length})：${opts.join(' / ') || '（没读到，可能结构特殊）'}`)
            // 读完关闭：再点一次开关 toggle + Escape，避免浮层挡住下一个字段
            await ff.locator('[data-iml-pb="1"]').first().click({ timeout: 2000 }).catch(() => {})
            await page.keyboard.press('Escape').catch(() => {}); await sleepP(450)
          } catch (e: any) { toolSend('dryrun:line', `· ${f.label} [下拉] 读取失败：${String(e.message).split('Call log')[0].trim()}`) }
        }
        toolSend('dryrun:line', '【完成】固化下拉请用上面"可选"里的真实文字锁定 SOP 值；检索/文本字段用 {{参数}}。')
        return { ok: true, loggedIn: true, done: 1, total: 1, failedAt: -1 }
      }
      // SOP-Agent 引擎：不回放选择器，读 SOP + 真实页面快照，模型用 tool calling 逐步决策执行
      if (mode === 'agentic-sop') {
        toolSend('dryrun:line', '【SOP·Agent 引擎】读 SOP + 实时页面，模型工具调用驱动…')
        const r = await runAgenticSop(page, { sop: sop || '', fieldValues: fieldValues || {}, navHash: navHash || '' }, {
          chat: (messages: any[], tools: any[]) => callRelayTools(adminBaseUrl, messages, tools),
          log: (msg: string) => toolSend('dryrun:line', msg)
        })
        return { ok: true, loggedIn: true, done: r.done || 0, total: r.done || 0, failedAt: r.ok ? -1 : (r.done || 0), failLabel: r.reason, error: r.reason }
      }
      const r = await runAgentic(page, steps || [], fieldValues || {}, sop || '', {
        llm: (prompt: string) => callRelay(adminBaseUrl, prompt),
        log: (msg: string) => toolSend('dryrun:line', msg),
        // 失败时落盘诊断：截图 + 当时页面可交互元素清单，便于精准定位（不再瞎改）
        diag: async (idx: number, desc: string, reason: string) => {
          try {
            const dir = path.join(app.getPath('userData'), 'dryrun-diag')
            fs.mkdirSync(dir, { recursive: true })
            const shot = path.join(dir, `fail-step${idx + 1}.png`)
            await page.screenshot({ path: shot, fullPage: false }).catch(() => {})
            let els: any[] = []
            try { els = await page.evaluate('(' + SNAPSHOT_FN + ')()') } catch (_) {}
            toolSend('dryrun:line', `✗ 第 ${idx + 1} 步「${desc}」未完成：${reason || '未知'}`)
            toolSend('dryrun:line', `  截图：${shot}`)
            toolSend('dryrun:line', `  当时页面可交互元素（${els.length}）：` + els.slice(0, 30).map((e: any) => `[${e.tag}]${e.text || ''}`).join(' / '))
          } catch (_) {}
        }
      })
      return { ...r, loggedIn: true }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('skill:dry-run-close', async () => {
    if (rt.dryCtx) { try { await rt.dryCtx.close() } catch (_) {} rt.dryCtx = null }
    return { ok: true }
  })

  // ===== 技能测试：一段话 → 模型提炼字段 → agentic 执行整条链路 → 通过/失败 =====
  ipcMain.handle('skill:test', async (_e, { systemId, baseUrl, sop, fields, navHash, paragraph, adminBaseUrl, headless, steps }: any) => {
    try {
      // ① 解析客户需求 vs 技能参数规范：先展示"技能要录入的参数 ↔ 从需求提取的值"，再决定是否操作
      const fieldValues: any = {}
      const labels = (fields || []).map((f: any) => f.label || f.name)
      if (!labels.length) {
        toolSend('dryrun:line', '① 参数映射：该技能未定义任何参数。')
        toolSend('dryrun:line', '   提示：在 SOP 里把变量写成 {{拜访客户}} 这样的占位，或录制时把字段标为「参数」，系统才能解析需求并映射。无参数则只能按 SOP 内联值执行。')
      } else {
        toolSend('dryrun:line', '① 解析需求 → 参数映射')
        toolSend('dryrun:line', '   技能需录入参数：' + labels.join('、'))
        const schema = labels.map((l: string) => `- ${l}`).join('\n')
        const today = new Date().toISOString().slice(0, 10)
        const prompt = `你是表单字段提炼器。从下面用户的话里，按"字段清单"提炼每个字段对应的值。\n只输出一个 JSON 对象：key 用字段的中文名（与清单完全一致），value 为从话里提炼到的内容；提炼不到的字段值给空字符串。不要输出任何额外文字。\n规则：\n- 日期类字段一律输出绝对日期 YYYY-MM-DD，不要原样保留"今天/明天/后天/下周X/N天后"等相对词。今天是 ${today}，据此推算（如"后天"=今天+2天）。\n- 若给了出发日期+天数（如"去 3 天"），返回/结束日期=出发日期+(天数-1)天。\n- 不编造关键信息（客户名/联系人/金额/单号），缺失留空。\n\n字段清单：\n${schema}\n\n用户的话：\n"""${paragraph}"""\n\n只输出 JSON：`
        try {
          const out = await callRelay(adminBaseUrl, prompt)
          const a = (out || '').indexOf('{'), b = (out || '').lastIndexOf('}')
          if (a >= 0 && b > a) { const obj = JSON.parse(out.slice(a, b + 1)); for (const l of labels) { if (obj[l] != null && String(obj[l]).trim()) fieldValues[l] = String(obj[l]).trim() } }
        } catch (e: any) { toolSend('dryrun:line', '   字段提炼失败：' + e.message) }
        toolSend('dryrun:line', '   从你的需求提取：' + labels.map((l: string) => `${l}=${fieldValues[l] || '（缺）'}`).join('｜'))
        // 参数校验：必填缺失 → 追问/提醒，绝不带缺参操作业务系统
        const missing = labels.filter((l: string) => !fieldValues[l])
        if (missing.length) {
          toolSend('dryrun:line', '⚠️ 缺少参数：' + missing.join('、') + ' —— 已暂停，未对业务系统做任何操作。请把这些信息补进需求里再测。')
          return { ok: true, loggedIn: true, passed: false, needInput: missing, fieldValues, reason: '参数缺失，需要补充：' + missing.join('、') }
        }
        toolSend('dryrun:line', '   ✓ 参数齐全，继续执行业务操作。')
      }
      // ② 启动浏览器（复用登录态）+ 登录检查
      if (rt.dryCtx) { try { await rt.dryCtx.close() } catch (_) {} rt.dryCtx = null }
      const ctx = await launchCtx(systemId, headless)
      rt.dryCtx = ctx
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
      if ((txt || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test((txt || '').toLowerCase())) {
        toolSend('dryrun:line', headless ? '无头模式下检测到未登录：请先关掉「无头浏览器」、在弹出窗口登录一次（登录态本地保留），之后再开无头测试。' : '检测到未登录目标系统，请在弹出窗口登录后重试。')
        return { ok: true, loggedIn: false, fieldValues }
      }
      // ③ 执行整条链路。关键：有录制步骤时走 runAgentic（选择器回放 + 模型自愈），与客户端真实执行同构——
      //    避免"FDE 测试用 SOP·模型引擎通过、客户端用回放引擎却失败"这类测试≠执行的分叉。无步骤才退回 SOP·Agent。
      let r: any, passed: boolean, reason: string, result: string
      if (Array.isArray(steps) && steps.length) {
        toolSend('dryrun:line', '② 执行技能链路（确定性回放：录制选择器 + 模型自愈，与客户端执行一致）…')
        r = await runAgentic(page, steps, fieldValues, sop || '', {
          llm: (prompt: string) => callRelay(adminBaseUrl, prompt),
          log: (msg: string) => toolSend('dryrun:line', msg)
        })
        passed = r.failedAt < 0
        reason = passed ? '' : `第 ${r.failedAt + 1} 步「${r.failLabel || ''}」未成功：${r.error || '未命中目标'}`
        result = ''
      } else {
        toolSend('dryrun:line', '② 执行技能链路（SOP·Agent：无录制步骤，读 SOP + 页面工具调用）…')
        r = await runAgenticSop(page, { sop: sop || '', fieldValues, navHash: navHash || '' }, {
          chat: (m: any[], t: any[]) => callRelayTools(adminBaseUrl, m, t),
          log: (msg: string) => toolSend('dryrun:line', msg)
        })
        passed = !!r.ok
        reason = r.reason
        result = r.result || ''
      }
      return { ok: true, loggedIn: true, fieldValues, done: r.done || 0, passed, reason, result }
    } catch (e: any) { return { ok: false, error: e.message } }
  })
}
