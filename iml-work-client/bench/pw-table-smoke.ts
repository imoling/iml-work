// P2 表格原语冒烟：makePwBrowseTool 的 check/checkall/rowaction/rowset 在泛微考勤表格 fixture 上跑通——
// 达到与 Electron 引擎功能对等（讯飞考勤维护那类：勾行/全选/行内检索格填值/删行）。
// 跑法：node bench/pw-table-smoke.build.mjs && node node_modules/.bench/pw-table-smoke.cjs
import path from 'node:path'
import { makePwBrowseTool, type PwBrowseTool } from '../src/main/pw-tool'

const FIXTURE = 'file://' + path.resolve(__dirname, '../../bench/pw-fixtures/ecology-table.html')
const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
let failed = 0
const ok = (n: string) => console.log(`✓ PASS: ${n}`)
const bad = (n: string, g: string) => { console.error(`✗ FAIL: ${n} — 实测="${g}"`); failed++ }

async function main() {
  const tool: PwBrowseTool = await makePwBrowseTool({ systemId: 'pwtable-smoke', headless: true, profileDir: '' })
  const page = tool.page()
  try {
    console.log('  ' + (await tool.run({ action: 'goto', url: FIXTURE }, log)))

    console.log('\n=== ① rowset：行「2026-07-14 10:09」×「类型」= 因公误时（检索型行内格）===')
    console.log('  ' + (await tool.run({ action: 'rowset', target: '2026-07-14 10:09', column: '类型', value: '因公误时' }, log)))
    const t2 = await page.$$eval('#rows tr', (trs: any[]) => (trs.find(tr => tr.textContent.includes('2026-07-14')) || {}).querySelector?.('.type')?.value || '')
    if (t2 === '因公误时') ok('rowset 类型 读回=因公误时'); else bad('rowset 类型', t2)

    console.log('\n=== ② rowset：同行「原因说明」= 临时外出（纯文本行内格）===')
    console.log('  ' + (await tool.run({ action: 'rowset', target: '2026-07-14 10:09', column: '原因说明', value: '临时外出' }, log)))
    const r2 = await page.$$eval('#rows tr', (trs: any[]) => (trs.find(tr => tr.textContent.includes('2026-07-14')) || {}).querySelector?.('.reason')?.value || '')
    if (r2 === '临时外出') ok('rowset 原因说明 读回=临时外出'); else bad('rowset 原因说明', r2)

    console.log('\n=== ③ check：勾选行「2026-07-20」===')
    console.log('  ' + (await tool.run({ action: 'check', target: '2026-07-20', value: '' }, log)))
    const c3 = await page.$$eval('#rows tr', (trs: any[]) => !!(trs.find(tr => tr.textContent.includes('2026-07-20')) || {}).querySelector?.('.rowck')?.checked)
    if (c3) ok('check 行 2026-07-20 已勾选'); else bad('check', String(c3))

    console.log('\n=== ④ checkall：全选 ===')
    console.log('  ' + (await tool.run({ action: 'checkall', value: '' }, log)))
    const allck = await page.$$eval('#rows .rowck', (cbs: any[]) => cbs.length > 0 && cbs.every(c => c.checked))
    if (allck) ok('checkall 全部勾选'); else bad('checkall', String(allck))

    console.log('\n=== ⑤ rowaction：删除行「2026-07-07」===')
    console.log('  ' + (await tool.run({ action: 'rowaction', target: '2026-07-07', value: '删除' }, log)))
    const gone = await page.$$eval('#rows tr', (trs: any[]) => !trs.some(tr => tr.textContent.includes('2026-07-07')))
    const delcnt = await page.$eval('#delcnt', (e: any) => e.textContent)
    if (gone && delcnt === '1') ok('rowaction 删除行 2026-07-07（该行已消失，delcnt=1）'); else bad('rowaction', `gone=${gone} delcnt=${delcnt}`)
  } catch (e: any) {
    console.error('✗ 冒烟异常：', e.message); failed++
  } finally {
    await tool.close()
    console.log(`\n=== 结果：${failed === 0 ? '全部 PASS ✅ —— pw-tool 表格原语与 Electron 引擎功能对等' : failed + ' 项 FAIL ❌'} ===`)
    process.exit(failed === 0 ? 0 : 1)
  }
}
main()
