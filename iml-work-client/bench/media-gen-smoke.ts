// 图片/视频生成引擎冒烟：走**真企业网关 → 真上游**，验证三段——
// 提示词改写 → 生成/轮询 → 产物真落工作空间（文件存在且不为 0 字节）。
// 这条链路的正确性在渲染层冒烟里看不出来（CLAUDE.md 要求技能链路改动须真跑），
// 所以做成可复跑 harness，改引擎后 60 秒能自证。
// 跑法：node bench/media-gen-smoke.build.mjs && node node_modules/.bench/media-gen-smoke.mjs [--video]
import fs from 'node:fs'
import path from 'node:path'
import { runNonSystemSkillForm } from '../src/main/skill-forms'
import { currentLlmConfig } from '../src/main/llm'
import type { AgentTaskData, SkillExecOut } from '../src/main/agent-types'

// 走**真实分流函数**而不是直接调引擎：IML-ENGINE 标记 → 引擎 这段分支本身也要验，
// 且输入用客户端同步下来的真 SKILL.md（技能内容一改标记失配，这里立刻红）。
// ESM bundle 里没有 __dirname；从 cwd（iml-work-client）解析
const SKILLS_DIR = path.resolve(process.cwd(), 'skills')
function realSkill(dir: string): { id: string; sop: string } {
  const md = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8')
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  return { id: dir, sop: body }
}

const wantVideo = process.argv.includes('--video')
const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)

function makeTrace(): any { return { spans: [], traceId: 'media-smoke' } }
function makeData(content: string): AgentTaskData {
  return { content, expertName: 'bench', background: '', llmConfig: currentLlmConfig() }
}

async function one(kind: 'image' | 'video', prompt: string): Promise<boolean> {
  const out: SkillExecOut = { skillResult: '', skillPromptHint: '' }
  const trace = makeTrace()
  const t0 = Date.now()
  console.log(`\n=== ${kind} ===\n请求："${prompt}"`)
  const sk = realSkill(kind === 'image' ? 'skill-imp-imagegen' : 'skill-imp-videogen')
  const handled = await runNonSystemSkillForm({
    matchedSkill: { id: sk.id, name: `${kind}-gen`, sopContent: sk.sop } as any,
    skl: `${kind}-gen`, data: makeData(prompt), sendLog: log as any, trace, out,
    skillType: 'knowledge', skillCode: '', skillSop: sk.sop, skillBundle: '',
  })
  if (!handled) { console.log('✗ 分流未命中——IML-ENGINE 标记没被识别'); return false }

  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  console.log(`skillOk=${out.skillOk} 用时 ${secs}s`)
  console.log(`结果：${out.skillResult}`)
  if (!out.skillOk) return false

  // 真值判据：产物文件必须真实存在且非空——skillOk 只是引擎的自述
  const ws = process.env.BENCH_WORKSPACE || ''
  let allGood = (out.skillFiles || []).length > 0
  for (const f of out.skillFiles || []) {
    const hits: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name === f.name) hits.push(p)
      }
    }
    try { walk(ws) } catch { /* 目录不存在按未落盘处理 */ }
    const sz = hits.length ? fs.statSync(hits[0]).size : 0
    const ok = sz > 1024
    if (!ok) allGood = false
    console.log(`  ${ok ? '✓' : '✗'} ${f.name} — ${(sz / 1024).toFixed(0)}KB @ ${hits[0] || '未找到'}`)
  }
  console.log(`  trace: ${JSON.stringify(trace.spans)}`)
  return allGood
}

;(async () => {
  let fail = 0
  if (!await one('image', '画一张橘猫坐在办公桌前看电脑的图，写实风格')) fail++
  if (wantVideo && !await one('video', '做段短视频：镜头缓缓推进，清晨窗边一杯冒热气的咖啡')) fail++
  console.log(`\n${fail === 0 ? '✅ 全通' : `❌ ${fail} 项失败`}`)
  process.exit(fail === 0 ? 0 : 1)
})()
