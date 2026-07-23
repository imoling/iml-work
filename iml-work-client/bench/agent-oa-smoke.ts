// M3 · agent × mock-oa 端到端：让**通用 agent 循环**(模型在环，非脚本)自主决策 browse 动作，
// 在真实企业 OA 系统里把一个差旅申请办成；评测器查 /api/state 判"任务是否真办成"。
// 这是"操作企业存量系统"能力的终点验证：给自然语言任务 → agent 自己 goto/observe/fill/click 多步 → 状态检查。
// 跑法：node bench/agent-oa-smoke.build.mjs && electron node_modules/.bench/agent-oa-smoke.cjs --no-sandbox
// 前置：mock-oa 在跑(:8090) + 后端模型网关在跑(:8080)。
import { app } from 'electron'
import { runAgentLoop } from '../src/main/agent-loop'
import { makeBrowseTool } from '../src/main/agent-browse'
import type { LlmConfig } from '../src/main/llm'

const OA = 'http://localhost:8090'
const GW = 'http://localhost:8080/api/v1/model/chat'
const KEY = 'sk-corp-default-key'
const DEST = '成都'   // 用独特目的地，评测时与已有数据区分

// callModel：直接 POST 模型网关（不经 llm.ts，避免 db 依赖）——与 bench-agent / grade.py 同法。
async function callModel(prompt: string): Promise<string> {
  const r = await fetch(GW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'corp-default', temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  })
  const d: any = await r.json()
  return d?.choices?.[0]?.message?.content || ''
}

// 评测器：独立登录查 /api/state，确认 travels 里出现目标目的地的差旅（state 为服务端全局，能看到 agent 提交的）。
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

app.whenReady().then(async () => {
  const tools = [makeBrowseTool()]
  const sendLog = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
  let failed = 0

  const task = `请在企业 OA 系统里提交一份差旅申请，并确认提交成功。
【系统信息】OA 地址：${OA}。登录：账号 wanglei，密码 123456（该系统任意密码都能登录）。
【差旅内容】目的地：${DEST}；预算：6000；出发日期：2026-07-28；返回日期：2026-07-30；出差事由：参加西部数字化产业峰会并拜访客户。
【操作提示】用 browse 工具分多步完成：先 goto ${OA}/login 打开登录页，observe 看清可交互元素，再 fill「账号」和「密码」、click「登 录」按钮登录；登录后 goto ${OA}/travel/new 打开差旅申请表单，依次 fill「目的地」「预算」「出发日期」「返回日期」「出差事由」，最后 click「提交申请」。每一步都依据上一步 observe 到的元素文本来操作，提交后确认页面跳到了差旅列表即完成。`

  try {
    console.log('=== 启动 agent 自主办差旅任务 ===\n')
    const res = await runAgentLoop({ task, tools, cfg: {} as LlmConfig, sendLog, callModel, maxSteps: 20, budgetMs: 260000 })
    console.log(`\n=== agent 结束：${res.steps.length} 步，finished=${res.finished} ===`)
    console.log('最终答案：', (res.answer || '').replace(/\n/g, ' ').slice(0, 200))

    const ev = await evalTravelSubmitted(DEST)
    if (ev.ok) console.log(`✓ 评测通过：/api/state 出现目标差旅 → ${ev.detail}`)
    else { console.error(`✗ 评测失败：${ev.detail}`); failed++ }
  } catch (e) {
    console.error('E2E 异常：', e); failed++
  } finally {
    await tools[0].cleanup?.()
  }

  console.log(`\n===== agent × mock-oa E2E：${failed === 0 ? '办成 ✓（agent 自主操作企业系统把事办成）' : '未办成 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
