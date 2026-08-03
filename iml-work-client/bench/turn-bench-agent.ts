// AgentCore 基准 harness —— 走**执行内核** runAgentCore（原生 function-calling，一个循环+一张工具表）。
// 模块名随 TurnEngine→AgentCore 改名同步：turn-engine→agent-core、turn-tools→core-tools、
// turn-protocol→core-protocol（改名那次漏了 bench，harness 一度打包失败）。
// 学术问答题只注册 web/compute/file 工具（不注册 browse——那是企业系统操作用的）。
import fs from 'fs'
import path from 'path'
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')
import { runAgentCore } from '../src/main/agent-core'
import { ToolRegistry } from '../src/main/tool-registry'
import { webTools, computeTools, fileTools } from '../src/main/core-tools'
import { callLlmTools } from '../src/main/llm'
import type { LlmConfig } from '../src/main/llm'
import type { CoreMessage } from '../src/shared/core-protocol'

interface Task { id: string; benchmark: string; question: string; gold?: string }

// 全局兜底：**绝不让单题的异步异常打死整批**。
// 实测踩到：第 82 题时 playwright 的 TargetClosedError（页面在 teardown 后仍有 await 悬着）
// 作为未捕获 rejection 直接终止了 Node 进程，驱动脚本以为跑完就进了下一轮——
// 一整夜的 R1 只拿到 82/150，而且日志里看不出"没跑完"，极易被当成完整结果拿去判分。
for (const ev of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(ev, (err: any) => {
    console.error(`[turn-bench] ⚠️ 捕获${ev}（已忽略，继续跑）：${err?.message || err}`)
  })
}

/** 单题墙钟上限。budgetMs 只管**模型侧**耗时（工具时间被显式扣除），
 *  所以一道题可以真跑 25 分钟（实测 sq10 = 1491s）。这里补一道硬闸，
 *  免得一道病态题吃掉整夜；设得宽松（15 分钟）是为了不影响与基线的可比性——
 *  只截住病态个例，正常慢题照跑。 */
const HARD_CAP_MS = Number(process.env.BENCH_HARD_CAP_MS || 900_000)

const CFG = {
  mode: 'proxy', apiMode: 'chat',
  baseUrl: (process.env.BENCH_ADMIN_BASE || 'http://localhost:8080') + '/api/v1/model',
  apiKey: process.env.BENCH_CORP_KEY || 'sk-corp-default-key',
  modelName: process.env.BENCH_MODEL || 'corp-default',
} as LlmConfig
const CONC = Number(process.env.BENCH_CONC || 2)
const SYS = '你是企业员工的智能助手。需要外部信息就用 web_search 联网查证、需要计算就用 python 精确算（不要心算）；查到后如实回答，绝不编造人名/日期/数字。得出结论后直接给出最终答案。'

async function runOne(t: Task) {
  const registry = new ToolRegistry()
  registry.registerAll(webTools(CFG))
  registry.registerAll(computeTools())
  registry.registerAll(fileTools())
  const messages: CoreMessage[] = [
    { role: 'system', content: SYS, ts: 0 },
    { role: 'user', content: t.question, ts: 0 },
  ]
  const t0 = Date.now()
  let capTimer: NodeJS.Timeout | undefined
  try {
    const capped = new Promise<never>((_, rej) => {
      capTimer = setTimeout(() => rej(new Error(`单题超过墙钟上限 ${HARD_CAP_MS / 1000}s`)), HARD_CAP_MS)
    })
    const res = await Promise.race([capped, runAgentCore({
      runId: `turn-${t.benchmark}-${t.id}`, messages, registry, cfg: CFG,
      callModel: callLlmTools, sendLog: () => {}, emit: () => {}, permMode: 'full',
      maxIterations: 14, budgetMs: 360000,
    })])
    clearTimeout(capTimer)
    return { id: t.id, benchmark: t.benchmark, question: t.question, gold: t.gold, answer: res.answer || '', ms: Date.now() - t0, timedOut: res.status === 'budget_exceeded' || res.status === 'max_iterations', // 保留真实错误文本：原先只记字面量 'error'，出问题时完全查不到是什么错
      error: res.status === 'error'
        ? (res.messages.filter(m => m.role === 'notice' && (m as any).noticeKind === 'error').pop()?.content || 'error')
        : '', status: res.status, iterations: res.iterations }
  } catch (e: any) {
    const msg = String(e?.message || e)
    // 命中硬闸的记成 timedOut（判分按错处理，与真实用户体验一致），其余记 error
    return { id: t.id, benchmark: t.benchmark, question: t.question, gold: t.gold, answer: '', ms: Date.now() - t0, timedOut: /墙钟上限/.test(msg), error: msg }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const tasksFile = get('--tasks'), outFile = get('--out')
  if (!tasksFile || !outFile) { console.error('用法: turn-bench-agent --tasks x.jsonl --out y.jsonl'); process.exit(2) }
  const items: Task[] = fs.readFileSync(tasksFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const done = new Set<string>()
  if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); done.add(r.benchmark + '/' + r.id) } catch { /* skip */ } }
  const todo = items.filter(i => !done.has(i.benchmark + '/' + i.id))
  const total = todo.length
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  console.log(`[turn-bench] TurnEngine 真·新内核跑 ${total} 题（并发 ${CONC}）`)
  let finished = 0
  const workers = Array.from({ length: CONC }, async (_, w) => {
    while (true) {
      const item = todo.shift(); if (!item) break
      console.log(`[turn-bench][w${w}] ▶ ${item.benchmark}/${item.id}: ${item.question.slice(0, 55).replace(/\n/g, ' ')}`)
      const rec = await runOne(item)
      fs.appendFileSync(outFile, JSON.stringify(rec) + '\n')
      finished++
      console.log(`[turn-bench][w${w}] ✔ ${item.benchmark}/${item.id} ${rec.timedOut ? '⏱' : rec.error ? '✗' : 'ok'} ${(rec.ms / 1000).toFixed(0)}s (${finished}/${total}) it=${(rec as any).iterations ?? '-'}`)
    }
  })
  await Promise.all(workers)
  console.log('[turn-bench] 全部完成')
  process.exit(0)
}
main()
