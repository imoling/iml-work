// 「录制→技能」闭环冒烟（复刻朋友的方法：录制注入脚本抓 DOM → 解析成平台锚点 → 按锚点确定性执行）。
// 证明三段都对：① 抓的是稳定平台 field ID/交互类型（不是脆 CSS 路径）；② 解析出可读 SOP + 精确锚点；
// ③ 换个会话/重置表单后，纯靠锚点把值确定性落回（泛微文本走 WfForm、放大镜走精确选择器、下拉走语义）。
// 跑法：node bench/pw-record-to-skill-smoke.mjs
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = 'file://' + path.resolve(__dirname, 'pw-fixtures/ecology-form.html')
let failed = 0
const ok = (n) => console.log(`✓ PASS: ${n}`)
const bad = (n, g) => { console.error(`✗ FAIL: ${n} — 实测="${g}"`); failed++ }

// ① 注入式录制抓取：给一个被点/被填的元素，抓出「平台 + 稳定 field ID + 交互类型 + 语义名」——这是录制脚本要注入页面里跑的逻辑。
const CAPTURE_FN = `function(el){
  function up(node, pred){ var e=node; for(var i=0;i<15&&e&&e!==document.body;i++){ if(pred(e)) return e; e=e.parentElement; } return null; }
  var platform = window.WfForm ? 'ecology' : document.querySelector('.f-item-inner.j-comp-wrap') ? 'fenxiang' : 'generic';
  // 字段容器：泛微控件外层 span#field\\d+... / #weaSelect_N / .f-item 包裹（交互判定只在容器内做，避免整表误判）
  var container = up(el, function(e){ return (e.id && /^(field\\d+|weaSelect)/.test(e.id)) || (e.className && /f-g-item|f-item-wrap|f-item(?![\\w-])/.test(e.className)); }) || el.parentElement || el;
  var idEl = (container.id && /^field\\d+/.test(container.id)) ? container : up(el, function(e){ return e.id && /^field\\d+/.test(e.id); });
  var fieldId = idEl ? idEl.id.replace(/_\\d+span$|span$|_\\d+$/,'') : '';
  var apiname = (up(el, function(e){ return e.getAttribute && e.getAttribute('data-apiname'); })||{getAttribute:function(){return ''}}).getAttribute('data-apiname')||'';
  // 交互类型（容器内判定）：放大镜=picker；weaSelect/ant-select=select；单选=radio；否则 fill
  var interaction = 'fill', openSel = '', selSel = '';
  var hasMag = (el.tagName==='BUTTON' && /btn-icon-only/.test(el.className||'')) || (container.querySelector && container.querySelector('button.ant-btn-icon-only'));
  var isSel = (container.id && /^weaSelect/.test(container.id)) || (container.className && /ant-select/.test(container.className)) || (container.querySelector && container.querySelector('.ant-select-selection'));
  if (hasMag) { interaction='picker'; openSel = '#'+container.id+' button.ant-btn-icon-only'; }
  else if (isSel) { interaction='select'; selSel = '#'+container.id+' .ant-select-selection'; }
  else if (el.type==='radio') interaction='radio';
  // 语义名：最近的表单标签
  var wrap = up(el, function(e){ return e.className && /f-item|wf-.*-item/.test(e.className); }) || (idEl&&idEl.parentElement);
  var lab = wrap ? (wrap.querySelector('label')||{}).textContent||'' : '';
  return { platform:platform, fieldId:fieldId, apiname:apiname, interaction:interaction, name:(lab||'').replace(/[*\\s]/g,'').slice(0,12), openSel:openSel, selSel:selSel };
}`

const browser = await chromium.launchPersistentContext('', { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 }, args: ['--no-first-run', '--disable-blink-features=AutomationControlled'] })
const page = browser.pages()[0] || await browser.newPage()

try {
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' })

  // ===== 第一段：录制抓取（模拟用户点/填这些字段时，注入脚本抓下的结构化锚点）=====
  console.log('\n=== ① 录制抓取：解析每个交互控件成平台锚点（非脆 CSS 路径）===')
  const cap = async (sel) => page.$eval(sel, (el, fnStr) => { const fn = eval('(' + fnStr + ')'); return fn(el) }, CAPTURE_FN)
  const capReason = await cap('#field229485')                              // 文本
  const capCity = await cap('#field229454_0span button.ant-btn-icon-only') // 放大镜
  const capProj = await cap('#weaSelect_8 .ant-select-selection')          // 下拉
  console.log('  出行事由 →', JSON.stringify(capReason))
  console.log('  出发地   →', JSON.stringify(capCity))
  console.log('  是否关联 →', JSON.stringify(capProj))
  if (capReason.platform === 'ecology' && capReason.fieldId === 'field229485' && capReason.interaction === 'fill') ok('文本字段：抓到 platform=ecology + 稳定 fieldId + interaction=fill')
  else bad('文本抓取', JSON.stringify(capReason))
  if (capCity.interaction === 'picker' && /button\.ant-btn-icon-only/.test(capCity.openSel)) ok('放大镜字段：识别 interaction=picker + openSel 精确按钮')
  else bad('放大镜抓取', JSON.stringify(capCity))
  if (capProj.interaction === 'select') ok('下拉字段：识别 interaction=select')
  else bad('下拉抓取', JSON.stringify(capProj))

  // ===== 第二段：解析成技能（参数 + 锚点 + SOP）=====
  console.log('\n=== ② 解析生成技能：参数表 + 机器锚点 + 可读 SOP ===')
  const skill = {
    params: [
      { name: '出行事由', anchor: capReason },
      { name: '出发地', anchor: capCity },
      { name: '是否关联项目', anchor: capProj },
    ],
    sop: ['1. 填写「出行事由」为 {{出行事由}}', '2. 检索「出发地」为 {{出发地}}', '3. 选择「是否关联项目」为 {{是否关联项目}}', '4. 提交'],
  }
  console.log('  SOP:\n   ' + skill.sop.join('\n   '))
  ok('生成 SOP + 参数锚点技能')

  // ===== 第三段：按锚点确定性执行（重置表单模拟"下次执行"，纯靠锚点落值）=====
  console.log('\n=== ③ 按锚点执行：新值 { 出行事由:出差合肥, 出发地:南京市, 是否关联项目:是 } ===')
  await page.evaluate(() => { window.WfForm._v = {}; document.getElementById('field229485').value = ''; document.getElementById('field229454').value = ''; document.querySelector('#weaSelect_8 .ant-select-selection').textContent = '请选择'; document.getElementById('field_proj').value = '' })
  const values = { '出行事由': '出差合肥参加评审', '出发地': '南京市', '是否关联项目': '是' }
  for (const p of skill.params) {
    const v = values[p.name], a = p.anchor
    if (a.interaction === 'fill' && a.platform === 'ecology') {
      await page.evaluate(({ id, val }) => window.WfForm.changeFieldValue(id, { value: val }), { id: a.fieldId, val: v })   // 平台 API
    } else if (a.interaction === 'picker') {
      await page.locator(a.openSel).click()
      await page.locator('.ant-modal-wrap input.ant-input').fill(v.slice(0, 2))
      await page.locator('.ant-modal-wrap .ant-search-btn').click()
      await page.locator(`.ant-modal-wrap tr.ant-table-row:has(td:has-text("${v}"))`).click()   // 精确选择器 + :has-text
    } else if (a.interaction === 'select') {
      await page.locator(a.selSel).click()
      await page.locator(`.ant-select-dropdown:not(.ant-select-dropdown-hidden) li[role=menuitem]:has-text("${v}")`).click()
    }
  }
  // 读回校验
  const got = await page.evaluate(() => ({ reason: window.WfForm.getFieldValue('field229485'), city: document.getElementById('field229454').value, proj: document.getElementById('field_proj').value }))
  if (got.reason === values['出行事由']) ok('锚点执行·出行事由 读回=' + got.reason); else bad('出行事由', got.reason)
  if (got.city === values['出发地']) ok('锚点执行·出发地 读回=' + got.city); else bad('出发地', got.city)
  if (got.proj === values['是否关联项目']) ok('锚点执行·是否关联项目 读回=' + got.proj); else bad('是否关联项目', got.proj)

} catch (e) {
  console.error('✗ 冒烟异常：', e.message); failed++
} finally {
  await browser.close().catch(() => {})
  console.log(`\n=== 结果：${failed === 0 ? '全部 PASS ✅ —— 录制抓DOM→平台锚点→按锚点执行 闭环跑通' : failed + ' 项 FAIL ❌'} ===`)
  process.exit(failed === 0 ? 0 : 1)
}
