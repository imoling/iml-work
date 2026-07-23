// 统一 browse 执行器 × mock-oa 端到端：验证「browse 成为主引擎 + 连接器动作绑定系统登录态复用」这条改造。
// 与 agent-oa-smoke 的区别：agent 自己登录（无登录态）；这里**先把登录态存进 persist:bizsys-<id> 分区**，
// 再让 runBrowseExecutor 复用该分区办事——**任务里不含任何登录步骤**（分身已登录，正是改造的核心断言）。
// ① 写入类：提交一份差旅（带录制步骤渲染的 hint）→ /api/state 查落库。
// ② 读取类：读差旅列表 → 断言 outcome 命中刚提交的目的地（browse 读实时页面整理，非编造）。
// 跑法：node bench/browse-exec-oa-smoke.build.mjs && electron node_modules/.bench/browse-exec-oa-smoke.cjs --no-sandbox
// 前置：mock-oa 在跑(:8090) + 后端模型网关在跑(:8080)。
import { app, session } from 'electron'
import { runBrowseExecutor, renderStepsHint } from '../src/main/browse-executor'
import type { CallModel } from '../src/main/browse-executor'
import type { RecStep } from '../src/main/types'
import type { LlmConfig } from '../src/main/llm'

const OA = 'http://localhost:8090'
const GW = 'http://localhost:8080/api/v1/model/chat'
const KEY = 'sk-corp-default-key'
const SYS = 'execsmoke'                     // 绑定系统 id → 登录态分区 persist:bizsys-execsmoke
const PART = `persist:bizsys-${SYS}`
const DEST = '兰州'                          // 独特目的地，评测时与已有数据区分

// callModel：直连模型网关（不经 llm.ts，避免 db 依赖）——与 agent-oa-smoke 同法。
const callModel: CallModel = async (prompt) => {
  const r = await fetch(GW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'corp-default', temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  })
  const d: any = await r.json()
  return d?.choices?.[0]?.message?.content || ''
}

// 用受控浏览器把登录态种进 persist:bizsys-<id> 分区（模拟「设置→企业系统连接」登录后保存）。
async function seedLogin(): Promise<void> {
  const { BrowserWindow } = await import('electron')
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { partition: PART, offscreen: true } })
  try {
    await win.loadURL(`${OA}/login`)
    await new Promise(r => setTimeout(r, 800))
    // 直接在页面里提交登录表单（mock-oa 任意密码可登录），登录态落进分区 cookie。
    await win.webContents.executeJavaScript(`(async()=>{
      const set=(sel,v)=>{const e=document.querySelector(sel); if(e){e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));}};
      set('input[name=username],#username,input[type=text]','wanglei');
      set('input[name=password],#password,input[type=password]','123456');
      const btn=[...document.querySelectorAll('button,input[type=submit]')].find(b=>/登\\s*录|登录|login/i.test(b.textContent||b.value||''));
      if(btn) btn.click();
    })()`)
    await new Promise(r => setTimeout(r, 1500))
  } finally {
    try { if (!win.isDestroyed()) win.close() } catch { /* noop */ }
  }
}

async function evalTravelSubmitted(dest: string): Promise<{ ok: boolean; detail: string }> {
  const login = await fetch(`${OA}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=evaluator&password=x&next=/portal',
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const st = await fetch(`${OA}/api/state`, { headers: { Cookie: cookie } })
  const d: any = await st.json()
  const hit = (d.travels || []).find((t: any) => String(t.dest || '').includes(dest))
  return { ok: !!hit, detail: hit ? JSON.stringify({ id: hit.id, dest: hit.dest, applicant: hit.applicant, state: hit.state }) : `travels 无「${dest}」` }
}

// 阻止默认 window-all-closed 自动退出：seedLogin/执行器会在多阶段间关窗，出现「零窗口」瞬间，
// 默认行为会 app.quit()，让进程在开下一个窗口前就退出（生产有常驻 mainWindow，不会触发；bench 特有）。
// 本 harness 只靠结尾 app.exit 显式退出。
app.on('window-all-closed', () => { /* no-op：由末尾 app.exit 决定退出码 */ })

app.whenReady().then(async () => {
  const sendLog = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
  let failed = 0
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) console.log(`✓ ${name}`)
    else { console.error(`✗ FAIL: ${name} :: ${detail.slice(0, 200)}`); failed++ }
  }

  try {
    // 前置：把登录态种进分区（这一步模拟用户已在「企业系统连接」登录过）
    console.log('=== 种登录态到 persist 分区 ===')
    await seedLogin()

    // 断言登录态确实落库：分区里应有 cookie
    const cookies = await session.fromPartition(PART).cookies.get({ url: OA })
    check('登录态已存入 persist 分区', cookies.length > 0, `cookies=${cookies.length}`)

    // ===== ① 写入类：提交差旅（录制步骤渲染为 hint，任务无登录步骤）=====
    console.log('\n=== ① browse 执行器·写入类（提交差旅，复用登录态）===')
    const recSteps: RecStep[] = [
      { action: 'fill', label: '目的地', value: '', fieldName: '目的地', selector: '', tag: '', url: '' },
      { action: 'fill', label: '预算', value: '', fieldName: '预算', selector: '', tag: '', url: '' },
      { action: 'fill', label: '出发日期', value: '', fieldName: '出发日期', selector: '', tag: '', url: '' },
      { action: 'fill', label: '返回日期', value: '', fieldName: '返回日期', selector: '', tag: '', url: '' },
      { action: 'fill', label: '出差事由', value: '', fieldName: '出差事由', selector: '', tag: '', url: '' },
      { action: 'click', label: '提交申请', value: '', selector: '', tag: '', url: '' },
    ]
    const fieldValues = { 目的地: DEST, 预算: '6800', 出发日期: '2026-08-05', 返回日期: '2026-08-07', 出差事由: '赴兰州参加西北能源数字化研讨会并拜访客户' }
    const hint = renderStepsHint(recSteps, fieldValues)
    console.log('  渲染 hint：\n' + hint.split('\n').map(l => '    ' + l).join('\n'))
    const wr = await runBrowseExecutor({
      systemId: SYS, systemName: 'Mock OA', entryUrl: `${OA}/travel/new`,
      task: `提交一份差旅申请并确认提交成功。`,
      hint, fieldValues, cfg: {} as LlmConfig, callModel, sendLog, maxSteps: 16, budgetMs: 200000,
    })
    console.log(`  写入类结束：ok=${wr.ok} loggedIn=${wr.loggedIn} steps=${wr.steps}`)
    console.log('  outcome：', (wr.outcome || '').replace(/\n/g, ' ').slice(0, 160))
    check('写入类：复用登录态（未卡在登录页）', wr.loggedIn, wr.outcome)
    const ev = await evalTravelSubmitted(DEST)
    check(`写入类：差旅真落库（/api/state 命中「${DEST}」）`, ev.ok, ev.detail)

    // ===== ② 读取类：读差旅列表，断言命中刚提交的目的地 =====
    console.log('\n=== ② browse 执行器·读取类（读差旅列表，复用登录态）===')
    const rd = await runBrowseExecutor({
      systemId: SYS, systemName: 'Mock OA', entryUrl: `${OA}/travel/list`,
      task: `读取差旅申请列表，找出目的地是「${DEST}」的那条申请，并说出它的出差事由与状态。`,
      cfg: {} as LlmConfig, callModel, sendLog, maxSteps: 10, budgetMs: 150000,
    })
    console.log(`  读取类结束：ok=${rd.ok} loggedIn=${rd.loggedIn} steps=${rd.steps}`)
    console.log('  outcome：', (rd.outcome || '').replace(/\n/g, ' ').slice(0, 200))
    check('读取类：复用登录态（未卡在登录页）', rd.loggedIn, rd.outcome)
    check(`读取类：outcome 命中真实数据「${DEST}」`, (rd.outcome || '').includes(DEST), rd.outcome)
  } catch (e) {
    console.error('E2E 异常：', e); failed++
  }

  console.log(`\n===== browse 执行器 × mock-oa：${failed === 0 ? '全部通过 ✓（browse 主引擎复用登录态，读/写皆办成）' : failed + ' 项失败 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
