// browse × mock-oa 冒烟：真 Electron 离屏浏览器里，用 browse 工具在**企业 OA 系统**(mock-oa :8090)
// 脚本化办成一个真实**写任务**——登录 → 新建差旅申请 → 填表 → 提交 → 查列表确认。
// 验证 browse 能操作企业存量系统(登录态保持 + label 定位填表 + 提交 + 状态确认)——对标 WebArena 的"把事办成"，
// 但落在 iML 真实用途(操作 OA/CRM/ERP)。这是 M2 里程碑(browse 脚本化办成写任务)。
// 跑法：node bench/browse-oa-smoke.build.mjs && electron node_modules/.bench/browse-oa-smoke.cjs --no-sandbox
// 前置：mock-oa 在跑(node iml-mock-oa/start-all.js，:8090)。
import { app } from 'electron'
import { makeBrowseTool } from '../src/main/agent-browse'

const OA = 'http://localhost:8090'
// 固定演示数据(不用 Date.now，保证可复现)
const DEST = '上海', BUDGET = '5200', START = '2026-07-25', END = '2026-07-27', REASON = '赴上海对接宝钢数字化项目并做客户拜访'

app.whenReady().then(async () => {
  const tool = makeBrowseTool()
  const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
  const run = async (args: Record<string, unknown>) => {
    console.log(`▶ ${args.action}${args.target ? ' «' + args.target + '»' : ''}${args.value ? '=' + args.value : ''}${args.url ? ' ' + args.url : ''}`)
    const t0 = Date.now()
    const r = await tool.run(args, log)
    console.log(`◀ ${args.action} done ${Date.now() - t0}ms (${r.length}b): ${r.replace(/\n/g, ' ').slice(0, 90)}`)
    return r
  }
  let failed = 0
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) console.log(`✓ ${name}`)
    else { console.error(`✗ FAIL: ${name} :: ${detail.slice(0, 160)}`); failed++ }
  }

  try {
    // ===== 1) 登录企业 OA =====
    console.log('\n=== 登录 mock-oa ===')
    await run({ action: 'goto', url: `${OA}/login` })
    await run({ action: 'fill', target: '账号', value: 'wanglei' })
    await run({ action: 'fill', target: '密码', value: '123456' })
    await run({ action: 'click', target: '登 录' })   // button 文本含空格
    const home = await run({ action: 'observe' })
    check('登录成功(进入门户)', /门户|待办|考勤|差旅|退出|王磊|portal/i.test(home), home)

    // ===== 2) 新建差旅申请(真实写操作) =====
    console.log('\n=== 新建差旅申请 ===')
    await run({ action: 'goto', url: `${OA}/travel/new` })
    await run({ action: 'fill', target: '目的地', value: DEST })
    await run({ action: 'fill', target: '预算', value: BUDGET })
    await run({ action: 'fill', target: '出发日期', value: START })
    await run({ action: 'fill', target: '返回日期', value: END })
    await run({ action: 'fill', target: '出差事由', value: REASON })
    const afterSubmit = await run({ action: 'click', target: '提交申请' })
    check('提交后有反馈', afterSubmit.length > 50, afterSubmit)

    // ===== 3) 查差旅列表，确认申请真的落库 =====
    console.log('\n=== 查列表确认写成功 ===')
    await run({ action: 'goto', url: `${OA}/travel/list` })
    const list = await run({ action: 'read' })
    check(`列表含新申请(目的地「${DEST}」)`, list.includes(DEST), list)
    check('列表含事由关键词(宝钢/客户拜访)', /宝钢|客户拜访|对接/.test(list), list)
  } catch (e) {
    console.error('冒烟异常：', e); failed++
  } finally {
    await tool.cleanup?.()
  }

  console.log(`\n===== browse × mock-oa 冒烟：${failed === 0 ? '全部通过 ✓（browse 能在企业系统里把事办成）' : failed + ' 项失败 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
