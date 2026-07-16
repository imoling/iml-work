// 本体解析评测（可重跑）：用运行时同一套 prompt（ontology-core）+ 真实本体目录（后端 resolve-hints，
// 即线上解析读的真值源）+ 真实模型网关，对 ontology-eval-cases.json 每条断言【解析到哪个对象类型/动作】。
//
// 存在的理由：本体解析一旦把"审批差旅"解成"合同审批"，读驱动消解就会去 /contract/list 读出一堆合同，
// 用户一路确认就会**批错单**。这类错误冒烟测不出来，只能靠评测卡住。改 prompt 或改本体描述后跑一遍。
//
// 跑法：npm run eval:ontology（依赖后端在跑，默认 http://localhost:8080）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOntologyPrompt, parseOntologyOutput, ontologyMightMatch, type OntologyHints } from '../src/main/ontology-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN = process.env.IML_ADMIN || 'http://localhost:8080'
const GATEWAY = process.env.IML_GATEWAY || `${ADMIN}/api/v1/model/chat`
const CORP_KEY = process.env.IML_CORP_KEY || 'sk-corp-default-key'
const MODEL = process.env.IML_MODEL || 'corp-default'
const USER = process.env.IML_USER || 'admin'
const PASS = process.env.IML_PASS || 'admin123'

// localhost 不走系统代理（否则本机网关请求会被代理拦挂）
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')

// 1) 拉真实本体目录（线上解析读的就是这个接口）
async function fetchHints(): Promise<OntologyHints> {
  const lr = await fetch(`${ADMIN}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  const lj = await lr.json() as { token?: string }
  if (!lj.token) throw new Error(`登录失败（${USER}）——设 IML_USER / IML_PASS 后重试`)
  const r = await fetch(`${ADMIN}/api/v1/ontology/resolve-hints`, { headers: { Authorization: `Bearer ${lj.token}` } })
  if (!r.ok) throw new Error(`拉本体目录失败 HTTP ${r.status}`)
  return await r.json() as OntologyHints
}

async function resolve(text: string, hints: OntologyHints): Promise<{ objectType: string; actionKey: string; displayName: string }> {
  // 预门与线上一致：没命中任何本体词就直接不匹配（不调模型）
  if (!ontologyMightMatch(text, hints)) return { objectType: '-', actionKey: '-', displayName: '' }
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CORP_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: 'user', content: buildOntologyPrompt(text, hints) }] }),
  })
  if (!res.ok) throw new Error(`网关 HTTP ${res.status}`)
  const j = await res.json() as { choices?: { message?: { content?: string } }[] }
  const out = j?.choices?.[0]?.message?.content || ''
  const { res: r, action } = parseOntologyOutput(out, hints)
  if (!r.matched || !action) return { objectType: '-', actionKey: '-', displayName: '' }
  return { objectType: String(r.objectType || '-'), actionKey: String(r.actionKey || '-'), displayName: String(r.displayName || '') }
}

const hints = await fetchHints()
const cases: { text: string; objectType: string; actionKey: string; why?: string }[] =
  JSON.parse(fs.readFileSync(path.join(__dirname, 'ontology-eval-cases.json'), 'utf8')).cases

console.log(`\n本体解析评测 · ${cases.length} 条 · 对象类型 ${hints.types.length} 个 / 动作 ${hints.actions.length} 个 · 模型 ${MODEL}\n`)
let pass = 0
const fails: string[] = []
for (const c of cases) {
  let got: { objectType: string; actionKey: string; displayName: string }
  try { got = await resolve(c.text, hints) } catch (e) { fails.push(c.text); console.log(`✗ ${c.text}\n    调用失败：${(e as Error).message}`); continue }
  // actionKey="-" 且 objectType!="-" 表示只校验对象类型（动作不限）
  const typeOk = got.objectType === c.objectType
  const actionOk = c.actionKey === '-' && c.objectType !== '-' ? true : got.actionKey === c.actionKey
  if (typeOk && actionOk) { pass++; console.log(`✓ ${c.text}\n    → ${got.objectType}.${got.actionKey}${got.displayName ? ` (${got.displayName})` : ''}`) }
  else {
    fails.push(c.text)
    console.log(`✗ ${c.text}\n    期望 ${c.objectType}.${c.actionKey}；实得 ${got.objectType}.${got.actionKey}${c.why ? `\n    用例意图：${c.why}` : ''}`)
  }
}
console.log(`\n结果：${pass}/${cases.length} 通过${fails.length ? `，${fails.length} 条未达预期（见上）` : ' ✅'}\n`)
process.exit(fails.length ? 1 : 0)
