// P0 结构化感知冒烟：真 Electron 离屏窗口里，用合成「考勤维护」页（表单 + 表格，对标讯飞 iBPMS 形态）
// 验证 STRUCT_FN 把页面读成结构——表格(行/勾选/行操作) + 表单(字段/类型/候选/必填)。不依赖真讯飞OA。
// 跑法：node bench/struct-perception-smoke.build.mjs && electron node_modules/.bench/struct-perception-smoke.cjs --no-sandbox
import { app, BrowserWindow } from 'electron'
import { STRUCT_FN, SEMANTIC_FN } from '../src/main/browser-scripts'

// 合成页：主文档放表单（自选审批人 autocomplete + 申请类型 select + 原因 textarea），
// 再嵌一个 iframe 放考勤表格（勾选框 + 日期/类型列 + 行内「删除」按钮 + 表头全选）——同时验证跨 frame。
// 表头全选真勾全部、行内删除真删行——让 checkAll/rowAction 的效果可被断言（对标真实组件表格行为）。
// 工具栏放一个**无文字按钮的图标删除**<i>删除选中行</i>（对标讯飞OA考勤删除图标）——验证 clickByText 能点到 <i>。
const TABLE_HTML = `<!doctype html><meta charset=utf8><body>
<div class="toolbar"><i class="del-icon" onclick="Array.prototype.slice.call(document.querySelectorAll('tbody tr')).forEach(function(tr){var cb=tr.querySelector('input[type=checkbox]'); if(cb&&cb.checked) tr.remove();})">删除选中行</i></div>
<table>
 <thead><tr><th><input type=checkbox onclick="var c=this.checked;Array.prototype.forEach.call(document.querySelectorAll('tbody input[type=checkbox]'),function(x){x.checked=c;});"></th><th>日期</th><th>类型</th><th>操作</th></tr></thead>
 <tbody>
  <tr><td><input type=checkbox></td><td>2026-07-01</td><td>因公误时</td><td><button class="btn-del" onclick="this.closest('tr').remove()">删除</button></td></tr>
  <tr><td><input type=checkbox></td><td>2026-07-02</td><td></td><td><button class="btn-del" onclick="this.closest('tr').remove()">删除</button></td></tr>
  <tr><td><input type=checkbox></td><td>2026-07-03</td><td></td><td><button class="btn-del" onclick="this.closest('tr').remove()">删除</button></td></tr>
 </tbody>
</table></body>`
const MAIN_HTML = `<!doctype html><meta charset=utf8><body style="padding:20px">
<div class="nav"><span class="menu-top" onmouseover="document.getElementById('sub').style.display='block'">考勤</span><ul id="sub" style="display:none"><li>考勤维护</li><li>加班申请</li></ul></div>
<form>
 <div class="ant-form-item"><label class="ant-form-item-label">自选审批人</label><span class="ant-form-item-required">*</span><div class="ant-select"><input role="combobox" placeholder="请选择审批人"></div></div>
 <div class="ant-form-item"><label class="ant-form-item-label">申请类型 *</label><select><option>请选择</option><option>因公误时</option><option>因私误时</option><option>忘打卡</option></select></div>
 <div class="ant-form-item"><label class="ant-form-item-label">原因</label><textarea></textarea></div>
</form>
<iframe style="width:600px;height:300px" src="data:text/html;charset=utf-8,${encodeURIComponent(TABLE_HTML)}"></iframe>
</body>`

app.on('window-all-closed', () => { /* no-op：由末尾 app.exit 决定退出码 */ })

app.whenReady().then(async () => {
  let failed = 0
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) console.log(`✓ ${name}`)
    else { console.error(`✗ FAIL: ${name} :: ${detail.slice(0, 300)}`); failed++ }
  }
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(MAIN_HTML)}`)
    await new Promise(r => setTimeout(r, 1200))

    // 跨 frame 聚合 STRUCT_FN（主 frame 的表单 + iframe 的表格）
    const frames = win.webContents.mainFrame.framesInSubtree
    const model: any = { tables: [], forms: [] }
    for (const f of frames) {
      const m: any = await f.executeJavaScript(`(${STRUCT_FN})()`).catch(() => null)
      if (m && Array.isArray(m.tables)) model.tables.push(...m.tables)
      if (m && Array.isArray(m.forms)) model.forms.push(...m.forms)
    }
    console.log('结构模型：', JSON.stringify(model, null, 1).slice(0, 1200))

    // ===== 表格断言 =====
    const tbl = model.tables[0]
    check('识别到表格', !!tbl, JSON.stringify(model.tables))
    if (tbl) {
      check('表格 3 数据行', tbl.rows.length === 3, `rows=${tbl.rows.length}`)
      check('每行有勾选框', tbl.rows.every((r: any) => r.hasCheckbox), JSON.stringify(tbl.rows.map((r: any) => r.hasCheckbox)))
      check('行内识别到「删除」操作', tbl.rows.every((r: any) => (r.actions || []).some((a: string) => a.includes('删除'))), JSON.stringify(tbl.rows.map((r: any) => r.actions)))
      check('表头可全选', tbl.selectAll === true, `selectAll=${tbl.selectAll}`)
      check('行首列含日期 2026-07-01', (tbl.rows[0].cells || []).some((c: string) => c.includes('2026-07-01')), JSON.stringify(tbl.rows[0].cells))
    }

    // ===== 表单断言 =====
    const byLabel = (kw: string) => model.forms.find((f: any) => f.label.includes(kw))
    const approver = byLabel('审批人'); const type = byLabel('申请类型'); const reason = byLabel('原因')
    check('识别到「自选审批人」字段', !!approver, JSON.stringify(model.forms))
    check('「自选审批人」标必填', !!approver && approver.required === true, JSON.stringify(approver))
    check('识别到「申请类型」下拉 + 候选含「因公误时」', !!type && (type.options || []).some((o: string) => o.includes('因公误时')), JSON.stringify(type))
    check('识别到「原因」为文本框', !!reason && reason.type === 'textarea', JSON.stringify(reason))

    // ===== P1 动作原语：checkRow 按行文本勾选表格行（跨 frame，表格在 iframe）=====
    const iframe = frames.find(f => f !== win.webContents.mainFrame && String(f.url).startsWith('data:'))
    check('定位到表格所在 iframe', !!iframe, frames.map(f => f.url.slice(0, 30)).join(','))
    if (iframe) {
      const doCheck = async (rowText: string): Promise<any> =>
        await iframe.executeJavaScript(`(${SEMANTIC_FN})({op:'checkRow',arg:${JSON.stringify(rowText)},value:'',sel:''})`).catch((e: any) => ({ ok: false, error: String(e) }))
      const r2 = await doCheck('2026-07-02')
      const r3 = await doCheck('2026-07-03')
      check('checkRow 勾选 2026-07-02 成功', r2 && r2.ok === true, JSON.stringify(r2))
      check('checkRow 勾选 2026-07-03 成功', r3 && r3.ok === true, JSON.stringify(r3))
      const states: any[] = await iframe.executeJavaScript(`Array.prototype.slice.call(document.querySelectorAll('tbody tr')).map(function(tr){var cb=tr.querySelector('input[type=checkbox]');var d=tr.querySelector('td:nth-child(2)');return {date:(d&&d.innerText)||'',checked:cb?cb.checked:null};})`)
      check('仅 07-02/07-03 被勾选、07-01 未选', states.every(s => s.date.includes('2026-07-01') ? s.checked === false : s.checked === true), JSON.stringify(states))

      // checkAll：表头全选 → 三行全勾（含 07-01）
      const rAll = await iframe.executeJavaScript(`(${SEMANTIC_FN})({op:'checkAll',arg:'',value:'',sel:''})`).catch((e: any) => ({ ok: false, error: String(e) }))
      check('checkAll 全选成功', rAll && rAll.ok === true, JSON.stringify(rAll))
      const allChecked: boolean[] = await iframe.executeJavaScript(`Array.prototype.slice.call(document.querySelectorAll('tbody tr input[type=checkbox]')).map(function(cb){return cb.checked;})`)
      check('全选后三行全勾', allChecked.length === 3 && allChecked.every(Boolean), JSON.stringify(allChecked))

      // rowAction：删除含 2026-07-02 的行 → 数据行 3→2、07-02 消失
      const rDel = await iframe.executeJavaScript(`(${SEMANTIC_FN})({op:'rowAction',arg:'2026-07-02',value:'删除',sel:''})`).catch((e: any) => ({ ok: false, error: String(e) }))
      check('rowAction 删除 07-02 成功', rDel && rDel.ok === true, JSON.stringify(rDel))
      await new Promise(r => setTimeout(r, 300))
      const afterDel: string[] = await iframe.executeJavaScript(`Array.prototype.slice.call(document.querySelectorAll('tbody tr')).map(function(tr){var d=tr.querySelector('td:nth-child(2)');return (d&&d.innerText)||'';})`)
      check('删行后剩 2 行且不含 07-02', afterDel.length === 2 && !afterDel.some(d => d.includes('2026-07-02')), JSON.stringify(afterDel))

      // 图标删除（讯飞OA形态）：clickByText 点无文字的 <i>删除选中行</i> 图标 → 删除所有勾选行（此时 07-01/07-03 由 checkAll 仍勾选）
      const rIcon = await iframe.executeJavaScript(`(${SEMANTIC_FN})({op:'click',arg:'删除选中行',value:'',sel:''})`).catch((e: any) => ({ ok: false, error: String(e) }))
      check('click 命中 <i>删除选中行</i> 图标', rIcon && rIcon.ok === true, JSON.stringify(rIcon))
      await new Promise(r => setTimeout(r, 300))
      const afterIcon: number = await iframe.executeJavaScript(`document.querySelectorAll('tbody tr').length`)
      check('图标删除后勾选行被删（剩 0 行）', afterIcon === 0, `剩 ${afterIcon} 行`)
    }

    // ===== hover：悬停「考勤」展开子菜单（多级菜单要先悬停才展开的门户）=====
    const main = win.webContents.mainFrame
    const rHov = await main.executeJavaScript(`(${SEMANTIC_FN})({op:'hover',arg:'考勤',value:'',sel:''})`).catch((e: any) => ({ ok: false, error: String(e) }))
    check('hover「考勤」成功', rHov && rHov.ok === true, JSON.stringify(rHov))
    await new Promise(r => setTimeout(r, 200))
    const subShown = await main.executeJavaScript(`(function(){var s=document.getElementById('sub');return s?getComputedStyle(s).display:'none';})()`)
    check('hover 后子菜单展开', subShown !== 'none', `display=${subShown}`)
  } catch (e) {
    console.error('冒烟异常：', e); failed++
  } finally {
    try { if (!win.isDestroyed()) win.close() } catch { /* noop */ }
  }
  console.log(`\n===== 结构化感知冒烟：${failed === 0 ? '全部通过 ✓（页面读成表格/表单结构，跨 frame）' : failed + ' 项失败 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
