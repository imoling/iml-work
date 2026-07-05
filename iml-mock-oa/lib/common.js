// 三套 Mock 业务系统（OA/CRM/ERM）的共享底座：cookie 登录、页面骨架、通用小工具。
// 每套系统有自己的品牌名/主题色/菜单/登录 cookie（互不串登录态），路由与数据在各自 server 文件里。
// 仅演示：任意账号密码可登录，数据在内存、重启复位。

function parseCookie(req) {
  const raw = req.headers.cookie || ''; const out = {}
  raw.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()) })
  return out
}

const money = n => '¥' + Number(n).toLocaleString('zh-CN')
const optHtml = (arr, sel) => arr.map(o => `<option value="${o}" ${o === sel ? 'selected' : ''}>${o}</option>`).join('')

/**
 * 构建一套门户的助手：{ currentUser, requireAuth, layout, mountAuth }
 * cfg: { cookieName, brand, brandSub, dept, pri, pri2, loginLead, version, menu: [{g, items:[[href,label,activeKey]]}] }
 */
function makeHelpers(cfg) {
  const currentUser = req => parseCookie(req)[cfg.cookieName] || ''
  const requireAuth = (req, res, next) => { if (currentUser(req)) return next(); res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)) }

  function layout(req, active, crumb, body) {
    const u = currentUser(req)
    const nav = cfg.menu.map(sec => `<div class="menu-g">${sec.g}</div>` + sec.items.map(it =>
      `<a class="menu-i ${it[2] && it[2] === active ? 'on' : ''}" href="${it[0]}">${it[1]}</a>`).join('')).join('')
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${crumb || '门户'} · ${cfg.brand}</title>
<style>
  :root{--pri:${cfg.pri};--pri2:${cfg.pri2};--bd:#e3e8ef;--muted:#7b8794;--bg:#eef1f5;--ink:#2b3440}
  *{box-sizing:border-box} body{margin:0;font:13.5px/1.6 -apple-system,"Microsoft YaHei","PingFang SC",Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}
  .top{background:linear-gradient(90deg,${cfg.priDark || cfg.pri},var(--pri));color:#fff;height:52px;display:flex;align-items:center;padding:0 18px;gap:12px;position:sticky;top:0;z-index:9}
  .top .logo{font-weight:800;font-size:16px;letter-spacing:.5px} .top .logo small{font-weight:400;opacity:.8;font-size:12px;margin-left:8px}
  .top .sp{flex:1} .top .u{font-size:13px;opacity:.95} .top a{color:#e8eef8;text-decoration:none;margin-left:14px;font-size:13px}
  .wrap{display:flex;min-height:calc(100vh - 52px)}
  aside{width:196px;background:#fff;border-right:1px solid var(--bd);padding:10px 0;flex-shrink:0}
  .menu-g{font-size:11.5px;color:var(--muted);padding:12px 18px 4px;font-weight:700;letter-spacing:.5px}
  .menu-i{display:block;padding:8px 18px;color:#3a4250;text-decoration:none;border-left:3px solid transparent;font-size:13.5px}
  .menu-i:hover{background:#f4f7fb;color:var(--pri)} .menu-i.on{background:#eef4fb;color:var(--pri);border-left-color:var(--pri);font-weight:600}
  main{flex:1;padding:16px 22px;min-width:0}
  .crumb{color:var(--muted);font-size:12.5px;margin-bottom:12px}
  .crumb b{color:var(--ink);font-weight:600}
  .panel{background:#fff;border:1px solid var(--bd);border-radius:6px;margin-bottom:14px}
  .panel-h{padding:11px 16px;border-bottom:1px solid var(--bd);font-weight:700;display:flex;align-items:center;gap:8px}
  .panel-h .bar{width:3px;height:14px;background:var(--pri);border-radius:2px}
  .panel-b{padding:14px 16px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #eef1f5;font-size:13px}
  th{color:#55606e;font-weight:600;background:#f7f9fc}
  tr:hover td{background:#fafcff}
  a.lnk{color:var(--pri);text-decoration:none} a.lnk:hover{text-decoration:underline}
  .tag{display:inline-block;padding:1px 9px;border-radius:3px;font-size:12px;border:1px solid transparent}
  .t-pending{background:#fff7e6;color:#d48806;border-color:#ffe7ba}.t-approved{background:#f6ffed;color:#389e0d;border-color:#b7eb8f}.t-rejected{background:#fff1f0;color:#cf1322;border-color:#ffccc7}
  .t-stage{background:#e6f0ff;color:#2c5aa0;border-color:#c3d7f5}
  .t-urg{background:#fff1f0;color:#cf1322;border-color:#ffccc7;margin-left:6px}
  form.f label{display:block;color:#55606e;font-size:12.5px;margin:12px 0 5px}
  form.f input,form.f select,form.f textarea{width:100%;max-width:420px;padding:8px 10px;border:1px solid #d4dae2;border-radius:4px;font:inherit;background:#fff}
  form.f textarea{min-height:76px;max-width:560px;resize:vertical}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:2px 28px;max-width:640px}
  .btn{border:none;cursor:pointer;font-weight:600;color:#fff;background:var(--pri);padding:8px 18px;border-radius:4px;font-size:13.5px}
  .btn:hover{background:var(--pri2)} .btn.plain{background:#fff;color:#cf1322;border:1px solid #ffccc7} .btn.gray{background:#f2f4f7;color:#3a4250;border:1px solid #d4dae2}
  .acts{display:flex;gap:10px;margin-top:16px}
  .ok{background:#f6ffed;border:1px solid #b7eb8f;color:#389e0d;padding:9px 14px;border-radius:4px;margin-bottom:14px}
  .kv{display:grid;grid-template-columns:96px 1fr 96px 1fr;gap:9px 14px;font-size:13.5px;align-items:baseline}
  .kv .k{color:var(--muted)} .kv .full{grid-column:2/5}
  .stat{display:flex;gap:14px;margin-bottom:14px}
  .stat .c{flex:1;background:#fff;border:1px solid var(--bd);border-radius:6px;padding:14px 16px}
  .stat .n{font-size:24px;font-weight:800;color:var(--pri)} .stat .l{color:var(--muted);font-size:12.5px;margin-top:2px}
  .login-wrap{max-width:820px;margin:9vh auto;display:flex;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px rgba(30,60,110,.14)}
  .login-l{flex:1.1;background:linear-gradient(150deg,var(--pri),${cfg.priDark || cfg.pri});color:#fff;padding:40px 36px;display:flex;flex-direction:column;justify-content:center}
  .login-r{flex:1;padding:40px 36px}
  .muted{color:var(--muted)} .right{text-align:right}
</style></head><body>
${u ? `<div class="top"><span class="logo">${cfg.brand}<small>${cfg.brandSub}</small></span><span class="sp"></span>
<span class="u">👤 ${u}｜${cfg.dept}</span>
<form method="post" action="/api/demo/reset" style="display:inline;margin-left:14px" onsubmit="return confirm('复位演示数据？所有改动将恢复到初始状态。')"><button type="submit" style="background:none;border:0;padding:0;color:#ffe0b3;cursor:pointer;font:inherit;font-size:13px" title="一键恢复初始演示数据（仅演示环境）">⟳ 复位数据</button></form>
<a href="/logout">退出</a></div>
<div class="wrap"><aside>${nav}</aside><main><div class="crumb">${crumb}</div>${body}</main></div>` : body}
</body></html>`
  }

  // 登录 / 登出 / 根路径（首页路径可配，默认 /portal）
  function mountAuth(app, home = '/portal') {
    app.get('/login', (req, res) => {
      const next = req.query.next || home
      res.send(layout(req, '', '', `<div class="login-wrap">
    <div class="login-l"><div style="font-size:22px;font-weight:800">${cfg.brand} · ${cfg.brandSub}</div>
      <div style="opacity:.85;margin-top:10px;line-height:1.9">${cfg.loginLead}</div>
      <div style="opacity:.6;margin-top:26px;font-size:12px">${cfg.version} · 内网访问</div></div>
    <div class="login-r"><h2 style="margin:0 0 4px">用户登录</h2><p class="muted" style="margin:0 0 8px">演示环境：任意用户名/密码</p>
      <form class="f" method="post" action="/login"><input type="hidden" name="next" value="${next}">
        <label for="username">账号</label><input id="username" name="username" placeholder="域账号，如 wanglei" autofocus>
        <label for="password">密码</label><input id="password" name="password" type="password" placeholder="登录密码">
        <div class="acts"><button id="loginBtn" class="btn" type="submit" style="width:100%;max-width:420px">登 录</button></div>
      </form></div></div>`))
    })
    app.post('/login', (req, res) => {
      const { username, next } = req.body
      if (!username || !username.trim()) return res.redirect('/login')
      res.setHeader('Set-Cookie', `${cfg.cookieName}=${encodeURIComponent(username.trim())}; Path=/; HttpOnly; Max-Age=604800`)
      res.redirect(next && next.startsWith('/') ? next : home)
    })
    app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', `${cfg.cookieName}=; Path=/; Max-Age=0`); res.redirect('/login') })
    app.get('/', (req, res) => res.redirect(currentUser(req) ? home : '/login'))
  }

  // 一键复位演示数据：POST /api/demo/reset（顶栏「⟳ 复位数据」按钮 / curl 均可触发；仅演示环境，无鉴权）
  function mountDemoReset(app, resetFn, home = '/portal') {
    app.post('/api/demo/reset', (req, res) => {
      resetFn()
      const back = req.headers.referer && String(req.headers.referer).startsWith('http') ? req.headers.referer : home
      res.redirect(back)
    })
  }

  return { currentUser, requireAuth, layout, mountAuth, mountDemoReset }
}

module.exports = { parseCookie, money, optHtml, makeHelpers }
