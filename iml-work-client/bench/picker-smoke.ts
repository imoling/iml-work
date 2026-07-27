// 检索控件真实 Electron 冒烟：用「最恶劣讯飞式 fixture」（isTrusted 检查 + mousedown 选中 + 失焦清空 + 远程延迟）
// 打 browse 引擎的真手路径（sendInputEvent）。目标：**本地闭环调通检索控件**，不再消耗用户真机试错。
// 跑法：node bench/picker-smoke.build.mjs && env -u ELECTRON_RUN_AS_NODE npx electron node_modules/.bench/picker-smoke.cjs --no-sandbox
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { makeBrowseTool } from '../src/main/agent-browse'

const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
const FIXTURE = 'file://' + path.resolve(__dirname, '../../bench/fixtures/picker-fixture.html')

app.on('window-all-closed', () => { /* 多阶段关窗有零窗口瞬间，别让默认 quit 提前退出 */ })

app.whenReady().then(async () => {
  let failed = 0
  const tool = makeBrowseTool({ partition: 'picker-smoke' })
  const READ_JS = `({
      appr: document.getElementById('appr').value,
      apprC: document.getElementById('appr').dataset.committed || '',
      t2: document.querySelectorAll('#grid .t')[1].value,
      t2C: document.querySelectorAll('#grid .t')[1].dataset.committed || '',
      appr2: (document.getElementById('appr2')||{}).value || '',
      appr2C: ((document.getElementById('appr2')||{}).dataset||{}).committed || '',
      ghost: (document.getElementById('ghost')||{}).value || '',
    })`
  type St = { appr: string; apprC: string; t2: string; t2C: string; appr2: string; appr2C: string; ghost: string }
  const readState = async (inIframe = false): Promise<St> => {
    const empty: St = { appr: '', apprC: '', t2: '', t2C: '', appr2: '', appr2C: '', ghost: '' }
    const wins = BrowserWindow.getAllWindows()
    const wc = wins[wins.length - 1]?.webContents
    if (!wc) return empty
    if (inIframe) {
      const frames = wc.mainFrame?.framesInSubtree || []
      const inner = frames.find(f => /picker-inner/.test(f.url))
      if (!inner) return { ...empty, appr: '(无 iframe)' }
      return await (inner.executeJavaScript(READ_JS) as Promise<St>)
    }
    return await wc.executeJavaScript(READ_JS)
  }

  try {
    console.log('\n=== ① goto fixture ===')
    console.log((await tool.run({ action: 'goto', url: FIXTURE }, log)).slice(0, 300))

    console.log('\n=== ② search 自选审批人 = 昕宇（label 定位 + 真键 + 真点候选）===')
    const out2 = await tool.run({ action: 'search', target: '自选审批人', value: '昕宇' }, log)
    console.log(out2.slice(0, 300))
    let st = await readState()
    if (st.appr === '昕宇' && st.apprC === '1') console.log('✓ PASS: 审批人已提交（value=昕宇, committed=1）')
    else { console.error(`✗ FAIL: 审批人 value="${st.appr}" committed="${st.apprC}"`); failed++ }

    console.log('\n=== ③ rowset 行「2026-07-14 10:09」×列「类型」= 因公误时 ===')
    const out3 = await tool.run({ action: 'rowset', target: '2026-07-14 10:09', column: '类型', value: '因公误时' }, log)
    console.log(out3.slice(0, 300))
    st = await readState()
    if (st.t2 === '因公误时' && st.t2C === '1') console.log('✓ PASS: 行内类型已提交（value=因公误时, committed=1）')
    else { console.error(`✗ FAIL: 行内类型 value="${st.t2}" committed="${st.t2C}"`); failed++ }

    // ===== 锚点路线（v4）：录制抓到的选择器直达，不靠标签/几何猜 =====
    console.log('\n=== ⑦ [锚点] picker(openSel=#apprBtn) 点开放大镜弹窗 → search 昕宇 ===')
    // openSel = 录制时点放大镜按钮那步抓到的选择器；执行时直接真点它开弹窗（放大镜无标签、几何难定位，靠锚点确定性）
    const out7a = await tool.run({ action: 'picker', target: '指派审批人', sel: '#apprBtn' }, log)
    console.log(out7a.slice(0, 160))
    const out7b = await tool.run({ action: 'search', target: '指派审批人', value: '昕宇' }, log)
    console.log(out7b.slice(0, 160))
    st = await readState()
    if (st.appr2 === '昕宇' && st.appr2C === '1') console.log('✓ PASS: [锚点] 放大镜弹窗审批人已提交（value=昕宇, committed=1）')
    else { console.error(`✗ FAIL: [锚点] 放大镜审批人 value="${st.appr2}" committed="${st.appr2C}"`); failed++ }

    console.log('\n=== ⑧ [锚点] fill(sel=#ghost) 救活无标签控件 ===')
    // #ghost 无 label/placeholder，标签链全落空；只有录制抓到的 sel 能定位——证明锚点救活「找不到标签的控件」
    const out8 = await tool.run({ action: 'fill', target: '这个标签根本不存在', sel: '#ghost', value: '锚点值A' }, log)
    console.log(out8.slice(0, 160))
    st = await readState()
    if (st.ghost === '锚点值A') console.log('✓ PASS: [锚点] 无标签控件已按 sel 填入（value=锚点值A）')
    else { console.error(`✗ FAIL: [锚点] 无标签控件 value="${st.ghost}"`); failed++ }

    // ===== iframe 版（讯飞真实形态：表单嵌在 iframe，验证 sendInputEvent 坐标换算）=====
    const HOST = 'file://' + path.resolve(__dirname, '../../bench/fixtures/picker-iframe.html')
    console.log('\n=== ④ [iframe] goto host 页 ===')
    console.log((await tool.run({ action: 'goto', url: HOST }, log)).slice(0, 200))
    console.log('\n=== ⑤ [iframe] search 自选审批人 = 昕宇 ===')
    console.log((await tool.run({ action: 'search', target: '自选审批人', value: '昕宇' }, log)).slice(0, 200))
    st = await readState(true)
    if (st.appr === '昕宇' && st.apprC === '1') console.log('✓ PASS: [iframe] 审批人已提交')
    else { console.error(`✗ FAIL: [iframe] 审批人 value="${st.appr}" committed="${st.apprC}"`); failed++ }
    console.log('\n=== ⑥ [iframe] rowset 行×类型 = 因公误时 ===')
    console.log((await tool.run({ action: 'rowset', target: '2026-07-14 10:09', column: '类型', value: '因公误时' }, log)).slice(0, 200))
    st = await readState(true)
    if (st.t2 === '因公误时' && st.t2C === '1') console.log('✓ PASS: [iframe] 行内类型已提交')
    else { console.error(`✗ FAIL: [iframe] 行内类型 value="${st.t2}" committed="${st.t2C}"`); failed++ }
  } catch (e) {
    console.error('✗ 冒烟异常：', e)
    failed++
  } finally {
    try { await (makeBrowseTool as unknown as never, null) } catch { /* noop */ }
    console.log(`\n=== 结果：${failed === 0 ? '全部 PASS ✅' : failed + ' 项 FAIL ❌'} ===`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
