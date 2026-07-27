// 登录态复用冒烟（storageState 架构证明）：企业 SSO 的会话 cookie（无 Expires，关浏览器即失）
// 经 context.storageState() 捕获后，**新上下文注入即恢复登录**——这就是"登录一次、执行复用"的机制本体。
// 本地 http 服务模拟 SSO：/portal 无 cookie → 302 /login；登录设会话 cookie → 回门户。
// 跑法：node bench/pw-session-smoke.mjs
import { chromium } from 'playwright'
import http from 'node:http'

const server = http.createServer((req, res) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(s => s.trim().split('=')))
  if (req.url.startsWith('/portal')) {
    if (cookies.sid === 'ok') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<title>门户</title><body><h3>统一待办：3 条</h3>考勤维护申请、出行申请、报销单审批。' + '门户正文内容。'.repeat(80))
    } else { res.writeHead(302, { Location: '/login' }); res.end() }
  } else if (req.url.startsWith('/do-login')) {
    // 会话 cookie：不带 Expires/Max-Age → 关浏览器即失（企业 SSO 常态，Chromium 磁盘 profile 也不持久化它）
    res.writeHead(302, { 'Set-Cookie': 'sid=ok; HttpOnly', Location: '/portal' }); res.end()
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<title>统一认证平台</title><body>账号登录 密码 验证码 <a id="go" href="/do-login">登录</a>')
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let failed = 0
const ok = (n) => console.log('✓ PASS: ' + n)
const bad = (n, g) => { console.error(`✗ FAIL: ${n} — 实测="${g}"`); failed++ }
const browser = await chromium.launch({ channel: 'chrome', headless: true })

try {
  // ① 无登录态：goto /portal 应落回登录页（执行预检"未登录"的判据）
  const c1 = await browser.newContext()
  const p1 = await c1.newPage()
  await p1.goto(base + '/portal')
  p1.url().includes('/login') ? ok('无登录态 → 落到登录页（预检判未登录）') : bad('未登录判定', p1.url())

  // ② "用户"在登录窗里登录 → 落回门户（登录轮询的成功判据）
  await p1.click('#go')
  await p1.waitForURL('**/portal')
  ok('登录后落门户（轮询判成功）')

  // ③ 捕获 storageState → **关掉登录上下文**（等价用户关窗——会话 cookie 在浏览器里已死，但数据已在手）
  const state = await c1.storageState()
  await c1.close()
  const sid = (state.cookies || []).find(c => c.name === 'sid')
  sid && sid.expires === -1 ? ok('storageState 捕获到会话 cookie（expires=-1=关窗即失型）') : bad('会话 cookie 捕获', JSON.stringify(state.cookies || []))

  // ④ 全新上下文注入 storageState → 直达门户（= 执行复用登录态，登录窗早已关闭也无妨）
  const c2 = await browser.newContext({ storageState: state })
  const p2 = await c2.newPage()
  await p2.goto(base + '/portal')
  const body = await p2.evaluate(() => document.body.innerText)
  !p2.url().includes('/login') && body.includes('统一待办') ? ok('新上下文注入 storageState → 直达门户（登录态复用成功）') : bad('复用登录态', p2.url() + ' | ' + body.slice(0, 40))
  await c2.close()
} catch (e) {
  console.error('✗ 冒烟异常：', e.message); failed++
} finally {
  await browser.close().catch(() => {})
  server.close()
  console.log(`\n=== 结果：${failed === 0 ? '全部 PASS ✅ —— storageState 登录态复用机制跑通（关窗不丢会话）' : failed + ' 项 FAIL ❌'} ===`)
  process.exit(failed === 0 ? 0 : 1)
}
