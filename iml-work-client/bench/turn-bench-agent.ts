// TurnEngine 基准 harness —— 走**真·新内核** runTurn（原生 function-calling，一个循环+一张工具表），
// 与 bench-agent.ts（旧链路 runSkillPipeline）平行对照。这才是"新内核 TurnEngine"的真实数据。
// 学术问答题只注册 web/compute/file 工具（不注册 browse——那是企业系统操作用的）。
import fs from 'fs'
import path from 'path'
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')
import { runTurn } from '../src/main/turn-engine'
import { ToolRegistry } from '../src/main/tool-registry'
import { webTools, computeTools, fileTools } from '../src/main/turn-tools'
import { callLlmTools } from '../src/main/llm'
import type { LlmConfig } from '../src/main/llm'
import type { TurnMessage } from '../src/shared/turn-protocol'

interface Task { id: string; benchmark: string; question: string; gold?: string }

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
  const messages: TurnMessage[] = [
    { role: 'system', content: SYS, ts: 0 },
    { role: 'user', content: t.question, ts: 0 },
  ]
  const t0 = Date.now()
  try {
    const res = await runTurn({
      runId: `turn-${t.benchmark}-${t.id}`, messages, registry, cfg: CFG,
      callModel: callLlmTools, sendLog: () => {}, emit: () => {}, permMode: 'full',
      maxIterations: 14, budgetMs: 360000,
    })
    return { id: t.id, benchmark: t.benchmark, question: t.question, gold: t.gold, answer: res.answer || '', ms: Date.now() - t0, timedOut: res.status === 'budget_exceeded' || res.status === 'max_iterations', error: res.status === 'error' ? 'error' : '', status: res.status, iterations: res.iterations }
  } catch (e: any) {
    return { id: t.id, benchmark: t.benchmark, question: t.question, gold: t.gold, answer: '', ms: Date.now() - t0, timedOut: false, error: String(e?.message || e) }
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
