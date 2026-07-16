// 路由评测（可重跑）：用运行时同一套 prompt（skill-router-core）+ 真实技能目录
// （本地 skills/*/SKILL.md，即路由线上读取的真值源）+ 真实模型网关，对 router-eval-cases.json
// 每条变体断言【产出形态 wants】与【是否触发预期技能】。跑法：npm run eval:router
//
// 依赖后端网关在跑（默认 http://localhost:8080）。改路由 prompt 后跑一遍，防过拟合单条 badcase。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatCatalog, buildRouterPrompt, parseRouterOutput, formatRouterContext, buildRouteText } from '../src/main/skill-router-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const GATEWAY = process.env.IML_GATEWAY || 'http://localhost:8080/api/v1/model/chat'
const CORP_KEY = process.env.IML_CORP_KEY || 'sk-corp-default-key'
const MODEL = process.env.IML_MODEL || 'corp-default'

// localhost 不走系统代理（否则本机网关请求会被代理拦挂）
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')

// 1) 读本地技能目录（路由运行时读的就是本地 skills/*/SKILL.md）
const skillsDir = path.join(ROOT, 'skills')
const skills: { id: string; name: string; description: string; sopContent: string }[] = []
for (const sub of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
  const md = path.join(skillsDir, sub, 'SKILL.md')
  if (!fs.existsSync(md)) continue
  const c = fs.readFileSync(md, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(c)
  const name = (fm && /name:\s*(.+)/.exec(fm[1])?.[1]?.trim()) || sub
  const desc = (fm && /description:\s*(.+)/.exec(fm[1])?.[1]?.trim()) || ''
  skills.push({ id: sub, name, description: desc, sopContent: c })
}
if (!skills.length) { console.error('未找到本地技能目录 skills/*/SKILL.md，请先在客户端领用岗位同步技能。'); process.exit(2) }
const catalog = formatCatalog(skills)
const validIds = skills.map(s => s.id)
const idToName = Object.fromEntries(skills.map(s => [s.id, s.name]))
// 本地 SKILL.md 的 name: 是 slug（=id），显示名在后端。评测按技能全文（名+描述+SOP）模糊匹配
// case.skill 关键词（如 pptx/.pptx/合同审批），无需连后端拉显示名。
const idText = Object.fromEntries(skills.map(s => [s.id, `${s.id} ${s.name} ${s.description} ${s.sopContent}`.toLowerCase()]))
const skillMatches = (id: string, kw: string) => (idText[id] || '').includes(kw.toLowerCase())

async function route(text: string, context?: { role: string; content: string }[]): Promise<{ wants: string; picked: string[] }> {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CORP_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: 'user', content: buildRouterPrompt(buildRouteText(text, context), catalog, formatRouterContext(context)) }] }),
  })
  if (!res.ok) throw new Error(`网关 HTTP ${res.status}`)
  const j: any = await res.json()
  const out = j?.choices?.[0]?.message?.content || ''
  return parseRouterOutput(out, validIds)
}

// 2) 逐条断言（context 可选：承接语境用例——用户在回答助手上一轮提问，期望不触发技能）
const cases: { text: string; wants: string; skill: string; context?: { role: string; content: string }[] }[] =
  JSON.parse(fs.readFileSync(path.join(__dirname, 'router-eval-cases.json'), 'utf8')).cases
let pass = 0
const fails: string[] = []
console.log(`\n路由评测 · ${cases.length} 条 · 技能目录 ${skills.length} 个 · 模型 ${MODEL}\n`)
for (const c of cases) {
  let got: { wants: string; picked: string[] }
  try { got = await route(c.text, c.context) } catch (e: any) { fails.push(c.text); console.log(`✗ ${c.text}\n    调用失败：${e.message}`); continue }
  const names = got.picked.map(id => idToName[id] || id)
  // wants:"*" = 不校验产出形态（该用例的安全属性只在"选没选技能"上，如短确认但目录无对应技能：answer/action 都不执行）
  const wantsOk = c.wants === '*' || got.wants === c.wants
  const skillOk = c.skill === '-'
    ? got.picked.length === 0
    : got.picked.some(id => skillMatches(id, c.skill))
  if (wantsOk && skillOk) { pass++; console.log(`✓ ${c.text}  →  wants=${got.wants} picked=[${names.join(', ')}]`) }
  else { fails.push(c.text); console.log(`✗ ${c.text}\n    期望 wants=${c.wants} skill=${c.skill}；实得 wants=${got.wants} picked=[${names.join(', ')}]`) }
}
console.log(`\n结果：${pass}/${cases.length} 通过${fails.length ? `，${fails.length} 条未达预期（见上）` : ' ✅'}\n`)
process.exit(fails.length ? 1 : 0)
