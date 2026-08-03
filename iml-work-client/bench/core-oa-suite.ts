// M4′ · **新内核** × mock-oa 企业任务集：复位演示数据 → runAgentCore 自主办成多类企业任务 → 查 state 算 pass rate。
//
// 与 agent-oa-suite.ts 的区别（也是它存在的理由）：
//   旧的走 runAgentLoop + makeBrowseTool（文本 ReAct、裸工具），那**不是生产链路**——
//   生产早已是 runAgentCore + browseTools（原生 function-calling、带写签字闸）。
//   于是"企业任务 3/3"验证的是一条没人在跑的路径。这个 harness 补上真链路。
//
// 写签字闸怎么过：不绕过，**真实走完**。browseTools 点写按钮前会 requestSignedConfirmation
//（issueToken → 表单卡 → consumeToken 一次性令牌校验），无头环境没有渲染层来签字，
// 表单会永久挂起。这里用 runInContext 自持 runId + 轮询 resolveForm 扮演"人在屏幕前点了确认"，
// 令牌的签发/校验/消费全程照跑——测的仍是带闸的真实路径，只是把人手换成脚本手。
//
// 跑法：node bench/core-oa-suite.build.mjs && electron node_modules/.bench/core-oa-suite.cjs --no-sandbox
// 前置：mock-oa 在跑(:8090) + 模型网关在跑(:8080)。
import { app } from 'electron'
import { execFileSync } from 'child_process'
import { ToolRegistry } from '../src/main/tool-registry'
import { runAgentCore } from '../src/main/agent-core'
import { browseTools } from '../src/main/core-tools'
import { callLlmTools } from '../src/main/llm'
import { runInContext, resolveForm } from '../src/main/automation-runtime'
import type { LlmConfig } from '../src/main/llm'
import type { CoreMessage } from '../src/shared/core-protocol'

const OA = 'http://localhost:8090'
const CK = '/tmp/core-oa-suite-ck.txt'
const CFG: LlmConfig = {
  mode: 'proxy', apiMode: 'chat',
  baseUrl: (process.env.BENCH_ADMIN_BASE || 'http://localhost:8080') + '/api/v1/model',
  apiKey: process.env.BENCH_CORP_KEY || 'sk-corp-default-key',
  modelName: process.env.BENCH_MODEL || 'corp-default',
}

// 评测器：curl 登录 + 查 /api/state（cookie jar 由 curl 管，可靠——规避 Electron fetch 的 redirect/cookie 坑）
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
    name: '差旅审批·上海磐钢',
    task: `在企业 OA(${OA})把去"上海·磐钢集团"的那笔待审批差旅申请审批通过。登录：账号 wanglei，密码 123456。用 browse：goto ${OA}/login 登录；再 goto ${OA}/travel/list 差旅列表，observe 找到目的地含"磐钢"的待审批差旅，click 进它的详情，再 click 表示"通过/同意"的审批按钮。`,
    ev: st => ((st.travels || []).find((t: any) => String(t.dest || '').includes('磐钢')) || {}).state === 'approved',
  },
]

const SYS = '你是企业员工的工作分身，能用 browse 工具在真实浏览器里操作企业系统。'
  + '按用户给的步骤逐步执行：先 goto 打开页面，observe 看清页面元素，再 fill/click 操作。'
  + '点提交/审批这类写按钮时会弹确认卡，确认后继续。办完即结束，绝不点复位/删除。'

// 多任务间 cleanup 会关掉 window → 触发 Electron 默认的 window-all-closed→app.quit()，
// 后续任务就没机会跑（单任务 smoke 不暴露此坑）。注册空 handler 阻止默认退出。
app.on('window-all-closed', () => { /* no-op：跑完所有任务再退出 */ })

app.whenReady().then(async () => {
  console.log('=== 复位演示数据（保证可复现）===')
  try { resetDemo() } catch (e) { console.error('复位失败：', e) }

  const results: { name: string; pass: boolean; iters: number; calls: number; err?: string }[] = []
  for (const T of TASKS) {
    console.log(`\n===== 任务：${T.name} =====`)
    const runId = `core-oa-${Date.now()}`
    const registry = new ToolRegistry()
    const tools = browseTools({
      permMode: 'full',
      sendLog: (t: string, x: string) => console.log(`  ·[${t}] ${x}`),
    })
    registry.registerAll(tools)

    let pass = false, iters = 0, calls = 0, err = ''
    try {
      const res = await runInContext(runId, async () => {
        // 扮演"人在屏幕前签字"：表单挂起时立刻确认，并对同类写动作授一次批量权
        //（生产里是用户勾「本任务内同类操作不再逐条确认」，这里等价）。
        // resolveForm 在没有挂起表单时是 no-op，轮询是安全的。
        const signer = setInterval(() => {
          resolveForm(runId, { _batch: '本任务内同类操作不再逐条确认' })
        }, 400)
        try {
          return await runAgentCore({
            runId,
            messages: [
              { role: 'system', content: SYS, ts: 0 },
              { role: 'user', content: T.task, ts: 0 },
            ] as CoreMessage[],
            registry, cfg: CFG, callModel: callLlmTools,
            sendLog: (t: string, x: string) => console.log(`  ·[${t}] ${x}`),
            // 内核错误必须打出来：起初写的 emit: () => {} 把模型调用异常整个吞了，
            // 只看到 status=error 却不知道错在哪（第一次跑就栽在这）。
            emit: (ev: any) => {
              if (ev?.type === 'error') console.log(`  ✗ 内核错误：${ev.message}`)
              if (ev?.type === 'tool_finished' && ev.status !== 'ok') console.log(`  ✗ 工具「${ev.name}」${ev.status}：${String(ev.preview || ev.reason || '').slice(0, 120)}`)
            },
            permMode: 'full',
            maxIterations: 18, budgetMs: 220000,
          })
        } finally { clearInterval(signer) }
      })
      iters = res.iterations; calls = res.toolCallCount
      console.log(`  内核 ${iters} 轮 · ${calls} 次工具调用，status=${res.status}`)
      pass = !!T.ev(getState())
    } catch (e) { err = String(e) }
    finally { for (const t of tools) await (t as any).cleanup?.() }
    console.log(`  → ${pass ? '✓ PASS' : '✗ FAIL'}${err ? ' (' + err + ')' : ''}`)
    results.push({ name: T.name, pass, iters, calls, err })
  }

  const passed = results.filter(r => r.pass).length
  console.log(`\n===== M4′ · 新内核 × mock-oa 任务集 pass rate：${passed}/${results.length} =====`)
  results.forEach(r => console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}（${r.iters} 轮 · ${r.calls} 次调用）${r.err ? ' ' + r.err : ''}`))
  app.exit(passed === results.length ? 0 : 1)
})
