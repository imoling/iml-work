// 最新内核执行链路 E2E：本体×browse 兜底的**执行端** runBrowseExecutor 全链路真跑。
// 验证：① 受管登录态分区 persist:bizsys 复用（不对话传密码）→ ② runBrowseExecutor 预检登录 + browse 自主办成 →
//       ③ **写签字闸** onWriteConfirm（点提交前读单据签字、未签不点）→ ④ 查 /api/state 验证真落库。
// 跑法：node bench/kernel-e2e-smoke.build.mjs && electron node_modules/.bench/kernel-e2e-smoke.cjs --no-sandbox
// 前置：mock-oa 在跑(:8090) + 模型网关在跑(:8080)。
import { app } from 'electron'
import { execFileSync } from 'child_process'
import { makeBrowseTool } from '../src/main/agent-browse'
import { runBrowseExecutor } from '../src/main/browse-executor'
import type { LlmConfig } from '../src/main/llm'

const OA = 'http://localhost:8090'
const GW = 'http://localhost:8080/api/v1/model/chat'
const KEY = 'sk-corp-default-key'
const SYS = 'mockoa-kernel-smoke'      // → 登录态分区 persist:bizsys-mockoa-kernel-smoke
const CK = '/tmp/oa-kernel-ck.txt'
const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)

async function callModel(prompt: string): Promise<string> {
  const r = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'corp-default', temperature: 0, messages: [{ role: 'user', content: prompt }] }) })
  const d: any = await r.json()
  return d?.choices?.[0]?.message?.content || ''
}
function resetDemo() { execFileSync('curl', ['-s', '-c', CK, '-o', '/dev/null', '-d', 'username=k&password=x&next=/portal', `${OA}/login`]); execFileSync('curl', ['-s', '-b', CK, '-X', 'POST', '-o', '/dev/null', `${OA}/api/demo/reset`]) }
function getState(): any { return JSON.parse(execFileSync('curl', ['-s', '-b', CK, `${OA}/api/state`], { encoding: 'utf8' })) }

app.on('window-all-closed', () => { /* 多窗不退，由结尾 app.exit 控制 */ })

app.whenReady().then(async () => {
  let failed = 0
  const check = (name: string, ok: boolean, detail = '') => { if (ok) console.log(`✓ ${name}${detail ? ' · ' + detail : ''}`); else { console.error(`✗ FAIL: ${name} :: ${detail}`); failed++ } }

  try { resetDemo(); console.log('（已复位演示数据）') } catch (e) { console.error('复位失败', e) }

  // ===== 步骤1：在受管登录分区 persist:bizsys 登录 mock-oa（模拟"设置→企业系统连接"里已登录，凭证只在本地）=====
  console.log('\n=== 步骤1：受管登录分区 persist:bizsys-' + SYS + ' 登录 mock-oa ===')
  const loginTool = makeBrowseTool({ partition: `persist:bizsys-${SYS}` })
  await loginTool.run({ action: 'goto', url: `${OA}/login` }, log)
  await loginTool.run({ action: 'fill', target: '账号', value: 'wanglei' }, log)
  await loginTool.run({ action: 'fill', target: '密码', value: '123456' }, log)
  await loginTool.run({ action: 'click', target: '登 录' }, log)
  const home = await loginTool.run({ action: 'observe' }, log)
  check('受管分区已登录', /门户|待办|考勤|退出|王磊/.test(home), home.replace(/\n/g, ' ').slice(0, 60))
  await loginTool.cleanup?.()

  // ===== 步骤2：runBrowseExecutor 用同分区登录态自主办差旅（最新内核执行端 + 写签字闸）=====
  console.log('\n=== 步骤2：runBrowseExecutor 自主办差旅（复用登录态 + 写签字闸）===')
  let gateTriggered = false, gateLabel = '', gateDocLen = 0
  const res = await runBrowseExecutor({
    systemId: SYS, systemName: '企业OA', entryUrl: `${OA}/travel/new`,
    task: '提交一份差旅申请',
    fieldValues: { 目的地: '杭州', 预算: '5500', 出发日期: '2026-08-10', 返回日期: '2026-08-12', 出差事由: '赴杭州参加云栖大会并拜访重点客户' },
    hint: '差旅申请表单：填「目的地/预算/出发日期/返回日期/出差事由」，最后点「提交申请」',
    cfg: {} as LlmConfig, callModel, sendLog: log,
    onWriteConfirm: async ({ actionLabel, pageText }) => {
      gateTriggered = true; gateLabel = actionLabel; gateDocLen = (pageText || '').length
      console.log(`  🔏 [写签字闸] 触发：将执行「${actionLabel}」，已读到单据正文 ${gateDocLen} 字 → 模拟用户签字确认`)
      return true
    },
    maxSteps: 14, budgetMs: 200000,
  })
  console.log(`  → agent ${res.steps} 步，ok=${res.ok}，loggedIn=${res.loggedIn}`)
  check('预检登录态复用（不对话传密码即进入系统）', res.loggedIn === true)
  check('browse 自主办成（executor 返回 ok）', !!res.ok, `${res.steps} 步`)
  check('写签字闸触发（点提交前读单据签字）', gateTriggered, gateLabel ? `${gateLabel}·单据${gateDocLen}字` : '')

  // ===== 步骤3：查 /api/state 验证真落库 =====
  console.log('\n=== 步骤3：查 /api/state 验证真落库 ===')
  let hit: any = null
  try { hit = (getState().travels || []).find((t: any) => String(t.dest || '').includes('杭州')) } catch (e) { console.error('查 state 失败', e) }
  check('差旅真落库（state 出现「杭州」）', !!hit, hit ? JSON.stringify({ id: hit.id, dest: hit.dest, applicant: hit.applicant, state: hit.state }) : '')

  console.log(`\n===== 最新内核执行链路 E2E：${failed === 0 ? '全过 ✓（受管登录态复用 + browse 自主办成 + 写签字闸 + 真落库）' : failed + ' 项失败 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
