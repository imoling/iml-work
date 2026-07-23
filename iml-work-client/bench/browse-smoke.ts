// P3 · browse 工具真实 Electron 冒烟：在**真 Electron 离屏浏览器**里跑一串脚本化 browse 动作，
// 验证 goto/read/observe/click/back 在真实公开网站上真能工作（不经模型，隔离工具本身）。
// 这是"真实 Electron E2E harness"的最小原型——桩了 electron 的 bench harness 测不了 browse，此处用真 electron。
// 跑法：node bench/browse-smoke.build.mjs && electron node_modules/.bench/browse-smoke.cjs
import { app } from 'electron'
import { makeBrowseTool } from '../src/main/agent-browse'

const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)

app.whenReady().then(async () => {
  const tool = makeBrowseTool()
  let failed = 0
  const step = async (title: string, args: Record<string, unknown>, expect?: (out: string) => boolean) => {
    console.log(`\n=== ${title} ===`)
    const out = await tool.run(args, log)
    console.log(out.slice(0, 500))
    if (expect && !expect(out)) { console.error(`✗ FAIL: ${title}`); failed++ }
    else if (expect) console.log(`✓ PASS: ${title}`)
    return out
  }

  try {
    // 1) 导航到一个稳定的公开页 + 观察可交互元素
    await step('goto Wikipedia Usain Bolt', { action: 'goto', url: 'https://en.wikipedia.org/wiki/Usain_Bolt' },
      o => /Usain Bolt/i.test(o) && /可交互元素/.test(o))
    // 2) 读正文（应含其身高/成绩等实质文本）
    await step('read 正文', { action: 'read' },
      o => o.length > 500 && /Bolt/i.test(o))
    // 3) 观察（应捕获到链接/元素清单）
    await step('observe 元素', { action: 'observe' },
      o => /<a|<button|<input/.test(o))
    // 4) 点击一个链接（Jamaica，验证语义定位 + 导航）
    await step('click 链接 Jamaica', { action: 'click', target: 'Jamaica' },
      o => /Jamaica/i.test(o))
    // 5) 后退回上一页
    await step('back 返回', { action: 'back' },
      o => /可交互元素/.test(o))
  } catch (e) {
    console.error('冒烟异常：', e); failed++
  } finally {
    await tool.cleanup?.()
  }

  console.log(`\n===== browse 冒烟：${failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗'} =====`)
  app.exit(failed === 0 ? 0 : 1)
})
