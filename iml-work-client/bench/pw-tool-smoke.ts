// P1+P3 契约冒烟：证明 makePwBrowseTool 与 Electron 版同款 run(step,log) 契约能驱动泛微表单——
// 直连版 + **iframe 宿主版**（讯飞 iBPMS 真实形态：表单嵌 iframe，验证跨 frame 定位/落值）。
// 上层技能链路（agent-loop/stepper/skill-custom）调用点无需改，只换工厂即可。
// 跑法：node bench/pw-tool-smoke.build.mjs && node node_modules/.bench/pw-tool-smoke.cjs
import path from 'node:path'
import { makePwBrowseTool, type PwBrowseTool } from '../src/main/pw-tool'

const FIX = (n: string) => 'file://' + path.resolve(__dirname, '../../bench/pw-fixtures/' + n)
const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)
let failed = 0
const ok = (n: string) => console.log(`✓ PASS: ${n}`)
const bad = (n: string, g: string) => { console.error(`✗ FAIL: ${n} — 实测="${g}"`); failed++ }

// 读回：从含表单的 frame 读（直连=主 frame，iframe 版=内嵌 frame）
async function readback(tool: PwBrowseTool): Promise<{ reason: string; city: string; proj: string }> {
  const page = tool.page()
  const frame = page.frames().find((f: any) => /ecology-form/.test(f.url())) || page.mainFrame()
  return frame.evaluate(() => ({
    reason: (window as any).WfForm.getFieldValue('field229485'),
    city: (document.getElementById('field229454') as any).value,
    proj: (document.getElementById('field_proj') as any).value,
  }))
}

async function flow(tool: PwBrowseTool, label: string, url: string): Promise<void> {
  console.log(`\n########## ${label} ##########`)
  console.log('  ' + (await tool.run({ action: 'goto', url }, log)))
  const obs = await tool.run({ action: 'observe' }, log)
  if (/\[button\]|\[textbox\]|\[radio\]/.test(obs)) ok(`[${label}] observe 出 a11y 清单`); else bad(`[${label}] observe`, obs.slice(0, 80))
  console.log('  ' + (await tool.run({ action: 'fill', target: '出行事由', value: '参加WAIC大会，请通过' }, log)))
  console.log('  ' + (await tool.run({ action: 'picker', target: '出发地', sel: '#field229454_0span button.ant-btn-icon-only' }, log)))
  console.log('  ' + (await tool.run({ action: 'search', target: '出发地', value: '合肥市', sel: '.ant-modal-wrap input.ant-input' }, log)))
  console.log('  ' + (await tool.run({ action: 'select', target: '是否关联项目', value: '否', sel: '#weaSelect_8 .ant-select-selection' }, log)))
  const st = await readback(tool)
  if (st.reason === '参加WAIC大会，请通过') ok(`[${label}] 出行事由 读回=${st.reason}`); else bad(`[${label}] 出行事由`, st.reason)
  if (st.city === '合肥市') ok(`[${label}] 出发地 读回=${st.city}`); else bad(`[${label}] 出发地`, st.city)
  if (st.proj === '否') ok(`[${label}] 是否关联项目 读回=${st.proj}`); else bad(`[${label}] 是否关联项目`, st.proj)
}

async function main() {
  const tool = await makePwBrowseTool({ systemId: 'pwtool-smoke', headless: true, profileDir: '' })
  try {
    await flow(tool, '直连版', FIX('ecology-form.html'))
    await flow(tool, 'iframe 宿主版（讯飞形态）', FIX('ecology-host.html'))
  } catch (e: any) {
    console.error('✗ 冒烟异常：', e.message); failed++
  } finally {
    await tool.close()
    console.log(`\n=== 结果：${failed === 0 ? '全部 PASS ✅ —— makePwBrowseTool 同契约驱动泛微表单（含 iframe）跑通' : failed + ' 项 FAIL ❌'} ===`)
    process.exit(failed === 0 ? 0 : 1)
  }
}
main()
