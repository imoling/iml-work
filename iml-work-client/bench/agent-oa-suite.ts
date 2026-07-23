// M4 · agent × mock-oa 任务集：复位演示数据 → 让 agent 自主办成多类企业任务(提交/审批) → 评测器查 state 算 pass rate。
// 评测器用 curl 子进程(cookie jar 可靠，规避 Electron fetch 的 redirect/cookie 坑)。
// 跑法：node bench/agent-oa-suite.build.mjs && electron node_modules/.bench/agent-oa-suite.cjs --no-sandbox
// 前置：mock-oa 在跑(:8090) + 模型网关在跑(:8080)。
import { app } from 'electron'
import { execFileSync } from 'child_process'
import { runAgentLoop } from '../src/main/agent-loop'
import { makeBrowseTool } from '../src/main/agent-browse'
import type { LlmConfig } from '../src/main/llm'

const OA = 'http://localhost:8090'
const GW = 'http://localhost:8080/api/v1/model/chat'
const KEY = 'sk-corp-default-key'
const CK = '/tmp/oa-suite-ck.txt'

async function callModel(prompt: string): Promise<string> {
  const r = await fetch(GW, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'corp-default', temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  })
  const d: any = await r.json()
  return d?.choices?.[0]?.message?.content || ''
}

// 评测器：curl 登录 + 查 /api/state（cookie jar 由 curl 管，可靠）
function curlLogin() { execFileSync('curl', ['-s', '-c', CK, '-o', '/dev/null', '-d', 'username=suite&password=x&next=/portal', `${OA}/login`]) }
function resetDemo() { curlLogin(); execFileSync('curl', ['-s', '-b', CK, '-X', 'POST', '-o', '/dev/null', `${OA}/api/demo/reset`]) }
function getState(): any { const o = execFileSync('curl', ['-s', '-b', CK, `${OA}/api/state`], { encoding: 'utf8' }); return JSON.parse(o) }

interface Task { name: string; task: string; ev: (st: any) => boolean }
const TASKS: Task[] = [
  {
    name: '差旅提交·重庆',
    task: `在企业 OA(${OA})提交一份差旅申请并确认成功。登录：账号 wanglei，密码 123456。用 browse：goto ${OA}/login 登录(fill「账号」「密码」→ click「登 录」)；再 goto ${OA}/travel/new，fill「目的地」=重庆、「预算」=7000、「出发日期」=2026-08-01、「返回日期」=2026-08-03、「出差事由」=赴重庆做项目现场支持，最后 click「提交申请」。`,
    ev: st => (st.travels || []).some((t: any) => String(t.dest || '').includes('重庆')),
  },
  {
    name: '合同审批·HT-2026-0028',
    task: `在企业 OA(${OA})把合同 HT-2026-0028 审批通过。登录：账号 wanglei，密码 123456。用 browse：goto ${OA}/login 登录；再 goto ${OA}/contract/HT-2026-0028 打开该合同详情，observe 看清审批相关按钮，click 表示"通过/同意/审批通过"的那个按钮把它审批通过。`,
    ev: st => ((st.contracts || []).find((c: any) => c.id === 'HT-2026-0028') || {}).state === 'approved',
  },
  {
    name: '差旅审批·上海宝钢',
    task: `在企业 OA(${OA})把去"上海·宝钢集团"的那笔待审批差旅申请审批通过。登录：账号 wanglei，密码 123456。用 browse：goto ${OA}/login 登录；再 goto ${OA}/travel/list 差旅列表，observe 找到目的地含"宝钢"的待审批差旅，click 进它的详情，再 click 表示"通过/同意"的审批按钮。`,
    ev: st => ((st.travels || []).find((t: any) => String(t.dest || '').includes('宝钢')) || {}).state === 'approved',
  },
]

// 多任务间 tool.cleanup() 会关掉 window → 触发 Electron 默认的 window-all-closed→app.quit()，
// 导致后续任务没机会跑（单任务 smoke 不暴露此坑）。注册空 handler 阻止默认退出，由 suite 结尾 app.exit 控制。
app.on('window-all-closed', () => { /* no-op：跑完所有任务再退出 */ })

app.whenReady().then(async () => {
  console.log('=== 复位演示数据（保证可复现）===')
  try { resetDemo() } catch (e) { console.error('复位失败：', e) }

  const results: { name: string; pass: boolean; steps: number; err?: string }[] = []
  for (const T of TASKS) {
    console.log(`\n===== 任务：${T.name} =====`)
    const tools = [makeBrowseTool()]
    let pass = false, steps = 0, err = ''
    try {
      const res = await runAgentLoop({
        task: T.task, tools, cfg: {} as LlmConfig,
        sendLog: (t: string, x: string) => console.log(`  ·[${t}] ${x}`),
        callModel, maxSteps: 18, budgetMs: 220000,
      })
      steps = res.steps.length
      console.log(`  agent ${steps} 步，finished=${res.finished}`)
      pass = !!T.ev(getState())
    } catch (e) { err = String(e) }
    finally { await tools[0].cleanup?.() }
    console.log(`  → ${pass ? '✓ PASS' : '✗ FAIL'}${err ? ' (' + err + ')' : ''}`)
    results.push({ name: T.name, pass, steps, err })
  }

  const passed = results.filter(r => r.pass).length
  console.log(`\n===== M4 · mock-oa 任务集 pass rate：${passed}/${results.length} =====`)
  results.forEach(r => console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}（${r.steps} 步）${r.err ? ' ' + r.err : ''}`))
  app.exit(0)
})
