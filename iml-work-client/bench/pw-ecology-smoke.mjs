// Playwright 引擎冒烟：在泛微 e-cology 形态 fixture 上证明「对面那套」核心技法本地跑通——
//   ① a11y 快照感知（page.accessibility.snapshot 出 role/name）
//   ② 平台 API 落值（WfForm.changeFieldValue，绕开合成/真实事件之争，最稳）
//   ③ 精确选择器 + :has-text 选结果行（放大镜检索）
//   ④ getByText/role 语义定位下拉选项
//   ⑤ 逐字段读回校验（读最终态，抓「假✓」）
// 跑法：node bench/pw-ecology-smoke.mjs   （用系统 Chrome，channel:chrome）
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = 'file://' + path.resolve(__dirname, 'pw-fixtures/ecology-form.html')

let failed = 0
const ok = (name) => console.log(`✓ PASS: ${name}`)
const bad = (name, got) => { console.error(`✗ FAIL: ${name} — 实测="${got}"`); failed++ }

const browser = await chromium.launchPersistentContext('', {
  channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 },
  args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
})
const page = browser.pages()[0] || await browser.newPage()

try {
  console.log('\n=== ① goto 泛微 fixture ===')
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' })
  console.log('  已加载：' + (await page.title()))

  console.log('\n=== ② a11y 快照感知（role/name，像对面那样按语义认元素）===')
  const ax = await page.accessibility.snapshot({ interestingOnly: true })
  const flat = []
  ;(function w(n){ if(!n) return; flat.push(`${n.role}:${(n.name||'').trim()}`.slice(0,40)); (n.children||[]).forEach(w) })(ax || {})
  const actionable = flat.filter(s => /^(button|textbox|combobox|radio|link|menuitem)/.test(s))
  console.log('  可交互元素清单（' + actionable.length + ' 项）：\n   - ' + actionable.slice(0, 12).join('\n   - '))
  if (actionable.length >= 3) ok('a11y 快照产出可交互元素清单')
  else bad('a11y 快照', actionable.join(','))

  console.log('\n=== ③ 平台 API 落值：WfForm.changeFieldValue(field229485, 出行事由) ===')
  await page.evaluate(({ mark, val }) => window.WfForm.changeFieldValue(mark, { value: val }),
    { mark: 'field229485', val: '参加WAIC大会，请通过' })
  const reason = await page.evaluate(() => window.WfForm.getFieldValue('field229485'))   // ⑤ 读回
  if (reason === '参加WAIC大会，请通过') ok('WfForm 文本落值 + 读回一致')
  else bad('WfForm 文本落值', reason)

  console.log('\n=== ④ 放大镜检索：精确选择器开弹窗 → 搜索 → :has-text 选结果行（出发地=合肥市）===')
  await page.locator('#field229454_0span button.ant-btn-icon-only').click()
  await page.locator('.ant-modal-wrap input.ant-input').fill('合肥')
  await page.locator('.ant-modal-wrap .ant-search-btn').click()
  await page.locator('.ant-modal-wrap tr.ant-table-row:has(td:has-text("合肥市"))').click()
  const city = await page.evaluate(() => document.getElementById('field229454').value)   // ⑤ 读回
  if (city === '合肥市') ok('放大镜检索 + :has-text 选中结果行，读回=合肥市')
  else bad('放大镜检索落值', city)

  console.log('\n=== ⑤ 下拉：语义点开 → :has-text 选项（是否关联项目=否）===')
  await page.locator('#weaSelect_8 .ant-select-selection').click()
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) li[role=menuitem]:has-text("否")').click()
  const proj = await page.evaluate(() => document.getElementById('field_proj').value)     // ⑤ 读回
  if (proj === '否') ok('下拉语义选项，读回=否')
  else bad('下拉选项', proj)

  console.log('\n=== ⑥ 单选 + 读回校验抓「假✓」：点「启用」→ 读回最终态 ===')
  // 复刻对面场景：点单选后必须读回真实状态，不能靠"点过了"就当成功
  await page.getByRole('radio', { name: '启用' }).check()
  const status = await page.evaluate(() => window.WfForm.getFieldValue('field_status'))
  if (status === '启用') ok('单选点击生效，读回最终态=启用（读回机制可抓假✓）')
  else bad('单选读回', status)

} catch (e) {
  console.error('✗ 冒烟异常：', e.message)
  failed++
} finally {
  await browser.close().catch(() => {})
  console.log(`\n=== 结果：${failed === 0 ? '全部 PASS ✅ —— Playwright 引擎五大技法在泛微 fixture 上跑通' : failed + ' 项 FAIL ❌'} ===`)
  process.exit(failed === 0 ? 0 : 1)
}
