// 验证本体×browse 兜底的核心新环节：**persist:bizsys 业务登录态复用**。
// ontologyBrowseFallback 假设"分身已登录该系统、无需再登录"——靠 makeBrowseTool 传业务分区 persist:bizsys-<id> 实现。
// 本冒烟：① 在某 persist 分区登录 mock-oa → 关窗；② 同分区**新开窗口**，验证登录态被复用（直接进表单页、没被踢回登录）；
// ③ 脚本化提交一笔差旅并查列表确认。脚本化(不经模型)以隔离"登录态复用"这一核心。
// 跑法：node bench/browse-persist-smoke.build.mjs && electron node_modules/.bench/browse-persist-smoke.cjs --no-sandbox
import { app } from 'electron'
import { makeBrowseTool } from '../src/main/agent-browse'

const OA = 'http://localhost:8090'
const PART = 'persist:bizsys-persisttest'   // 模拟「设置→企业系统连接」登录后存的业务分区
const DEST = '南京'

app.whenReady().then(async () => {
  const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
  let failed = 0
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) console.log(`✓ ${name}`)
    else { console.error(`✗ FAIL: ${name} :: ${detail.slice(0, 160)}`); failed++ }
  }

  try {
    // ===== ① 在 persist 分区登录 mock-oa，然后关窗（登录态留在分区里）=====
    console.log('\n=== ① 登录并把登录态存入 persist 分区 ===')
    const t1 = makeBrowseTool({ partition: PART })
    await t1.run({ action: 'goto', url: `${OA}/login` }, log)
    await t1.run({ action: 'fill', target: '账号', value: 'wanglei' }, log)
    await t1.run({ action: 'fill', target: '密码', value: '123456' }, log)
    await t1.run({ action: 'click', target: '登 录' }, log)
    await t1.cleanup?.()   // 关窗——登录态持久化在 persist:bizsys-persisttest 分区

    // ===== ② 同分区新开窗口，直接进表单页，验证登录态被复用（没被踢回登录）=====
    console.log('\n=== ② 新窗口（同分区）验证登录态复用 ===')
    const t2 = makeBrowseTool({ partition: PART })
    const form = await t2.run({ action: 'goto', url: `${OA}/travel/new` }, log)
    check('登录态复用：直接进差旅表单、未被踢回登录页',
      /目的地|出差事由|预算/.test(form) && !/域账号|登录密码/.test(form), form)

    // ===== ③ 脚本化提交一笔差旅 → 查列表确认 =====
    console.log('\n=== ③ 提交差旅并确认落库 ===')
    await t2.run({ action: 'fill', target: '目的地', value: DEST }, log)
    await t2.run({ action: 'fill', target: '预算', value: '5500' }, log)
    await t2.run({ action: 'fill', target: '出发日期', value: '2026-08-10' }, log)
    await t2.run({ action: 'fill', target: '返回日期', value: '2026-08-12' }, log)
    await t2.run({ action: 'fill', target: '出差事由', value: '南京客户对接（persist 登录态复用验证）' }, log)
    await t2.run({ action: 'click', target: '提交申请' }, log)
    await t2.run({ action: 'goto', url: `${OA}/travel/list` }, log)
    const list = await t2.run({ action: 'read' }, log)
    check(`列表含新差旅「${DEST}」`, list.includes(DEST), list)
    await t2.cleanup?.()
  } catch (e) {
    console.error('冒烟异常：', e); failed++
  }

  console.log(`\n===== persist 登录态复用冒烟：${failed === 0 ? '全部通过 ✓（业务分区登录态可跨窗复用，兜底不必对话传密码）' : failed + ' 项失败 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
