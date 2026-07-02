// 华信数字 · 企业协同平台（Mock）—— 一个「传统」的企业 OA/CRM 系统，用于演示本体层盖在真实系统之上。
// 有侧边栏菜单、流程编号、申请人、审批意见、跟进方式等传统字段与噪音，看不出本体痕迹。
// 底层路由/接口稳定（固定 id + 中文 label），便于 FDE 录制连接器动作并回放。数据在内存，重启复位。仅演示。
const express = require('express')
const app = express()
const PORT = process.env.MOCK_OA_PORT || 8090

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

function parseCookie(req) {
  const raw = req.headers.cookie || ''; const out = {}
  raw.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()) })
  return out
}
function currentUser(req) { return parseCookie(req)['hxoa_user'] || '' }
function requireAuth(req, res, next) { if (currentUser(req)) return next(); res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)) }

// ---- 内存数据（贴近真实系统的字段：流程号/部门/紧急度/跟进方式等）----
const db = {
  contracts: [
    { id: 'HT-2026-0028', name: '宝钢钢铁数字化项目采购合同', customer: '宝钢集团', party: '华信数字科技有限公司', amount: 2800000, applicant: '王磊', dept: '大客户事业部', urgency: '普通', applyAt: '2026-07-01 09:12', state: 'pending', opinion: '' },
    { id: 'HT-2026-0031', name: '宝钢产线智能改造服务合同', customer: '宝钢集团', party: '华信数字科技有限公司', amount: 60000000, applicant: '王磊', dept: '大客户事业部', urgency: '加急', applyAt: '2026-07-02 10:40', state: 'pending', opinion: '' },
    { id: 'HT-2026-0033', name: '华东电网智能巡检平台合同', customer: '华东电网', party: '华信数字科技有限公司', amount: 3200000, applicant: '李强', dept: '能源事业部', urgency: '普通', applyAt: '2026-07-02 11:05', state: 'pending', opinion: '' },
    { id: 'HT-2026-0034', name: '中石化管道监测系统合同', customer: '中国石化', party: '华信数字科技有限公司', amount: 8600000, applicant: '李强', dept: '能源事业部', urgency: '加急', applyAt: '2026-07-02 11:20', state: 'pending', opinion: '' },
    { id: 'HT-2026-0035', name: '招商银行数据中台建设合同', customer: '招商银行', party: '华信数字科技有限公司', amount: 12000000, applicant: '周敏', dept: '金融事业部', urgency: '普通', applyAt: '2026-07-02 13:30', state: 'pending', opinion: '' },
    { id: 'HT-2026-0036', name: '比亚迪产线视觉质检合同', customer: '比亚迪', party: '华信数字科技有限公司', amount: 4500000, applicant: '陈昊', dept: '制造事业部', urgency: '普通', applyAt: '2026-07-02 14:02', state: 'pending', opinion: '' },
    { id: 'HT-2026-0037', name: '国家电网调度平台升级合同', customer: '国家电网', party: '华信数字科技有限公司', amount: 45000000, applicant: '李强', dept: '能源事业部', urgency: '加急', applyAt: '2026-07-02 15:18', state: 'pending', opinion: '' },
    { id: 'HT-2026-0026', name: '常规办公用品年度采购', customer: '内部', party: '华信数字科技有限公司', amount: 86000, applicant: '孙婷', dept: '行政部', urgency: '普通', applyAt: '2026-06-28 14:05', state: 'approved', opinion: '同意' },
  ],
  opportunities: [
    { id: 'SJ20260012', name: '宝钢钢铁数字化项目', customer: '宝钢集团', amount: 2800000, stage: '初步接触', owner: '王磊', expectClose: '2026-09-30' },
    { id: 'SJ20260018', name: '宝钢产线智能改造', customer: '宝钢集团', amount: 60000000, stage: '方案报价', owner: '王磊', expectClose: '2026-12-15' },
  ],
  customers: [{ id: 'KH001', name: '宝钢集团', industry: '钢铁冶金', level: 'A（战略客户）', owner: '王磊' }],
  contacts: [{ id: 'LX001', customer: '宝钢集团', name: '李建国', title: '采购部主任', phone: '138****6621' }],
  visits: [],
  feedbacks: [],
  seq: 1,
}
// 传统 CRM 的销售阶段（中文、带更多阶段，看不出本体）
const STAGES = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单', '输单']
const STATE_CN = { pending: '审批中', approved: '已通过', rejected: '已退回' }
const money = n => '¥' + Number(n).toLocaleString('zh-CN')
// 「客户拜访反馈」复杂表单的下拉候选（贴近真实 CRM 的多级归属/枚举）
const FB = {
  visitType: ['现场拜访', '线上拜访', '电话拜访'],
  visitResult: ['线索挖掘（MTL）', '商机推动（LTO）', '履约回款（OTC）', '客户服务（其他）'],
  customer: ['宝钢集团', '华东电网', '中国石化', '招商银行', '比亚迪', '国家电网'],
  contact: ['李建国', '张伟', '王芳', '陈明', '刘洋'],
  salesPlatform: ['星火企业军团自营', '教育BG', '智慧城市BG', '金融事业部', '能源事业部', '智能汽车'],
  region: ['央国企销售部-销售一部', '央国企销售部-销售四部', '金融销售部-华北地区部', '金融销售部-华南地区部', '华东地区部', '中西地区部'],
  priority: ['高', '中', '低'],
}
const optHtml = (arr, sel) => arr.map(o => `<option value="${o}" ${o === sel ? 'selected' : ''}>${o}</option>`).join('')

function layout(req, active, crumb, body) {
  const u = currentUser(req)
  const menu = [
    { g: '协同办公', items: [['/portal', '门户首页', 'portal'], ['/todo', '我的待办', 'todo'], ['#', '公文流转', ''], ['#', '考勤打卡', '']] },
    { g: '合同管理', items: [['/contract/list', '合同审批', 'contract'], ['#', '合同台账', '']] },
    { g: '客户管理(CRM)', items: [['/crm/customers', '客户档案', 'customers'], ['/crm/opportunities', '商机管理', 'opp'], ['/crm/follow', '跟进记录', 'follow'], ['/crm/feedbacks', '拜访反馈', 'feedback']] },
    { g: '统计报表', items: [['#', '经营看板', ''], ['#', '销售漏斗', '']] },
  ]
  const nav = menu.map(sec => `<div class="menu-g">${sec.g}</div>` + sec.items.map(it =>
    `<a class="menu-i ${it[2] && it[2] === active ? 'on' : ''}" href="${it[0]}">${it[1]}</a>`).join('')).join('')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${crumb || '门户'} · 华信数字协同平台</title>
<style>
  :root{--pri:#2c5aa0;--pri2:#3a6cb5;--bd:#e3e8ef;--muted:#7b8794;--bg:#eef1f5;--ink:#2b3440}
  *{box-sizing:border-box} body{margin:0;font:13.5px/1.6 -apple-system,"Microsoft YaHei","PingFang SC",Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}
  .top{background:linear-gradient(90deg,#24507f,#2c5aa0);color:#fff;height:52px;display:flex;align-items:center;padding:0 18px;gap:12px;position:sticky;top:0;z-index:9}
  .top .logo{font-weight:800;font-size:16px;letter-spacing:.5px} .top .logo small{font-weight:400;opacity:.8;font-size:12px;margin-left:8px}
  .top .sp{flex:1} .top .u{font-size:13px;opacity:.95} .top a{color:#dbe6f5;text-decoration:none;margin-left:14px;font-size:13px}
  .wrap{display:flex;min-height:calc(100vh - 52px)}
  aside{width:196px;background:#fff;border-right:1px solid var(--bd);padding:10px 0;flex-shrink:0}
  .menu-g{font-size:11.5px;color:var(--muted);padding:12px 18px 4px;font-weight:700;letter-spacing:.5px}
  .menu-i{display:block;padding:8px 18px;color:#3a4250;text-decoration:none;border-left:3px solid transparent;font-size:13.5px}
  .menu-i:hover{background:#f4f7fb;color:var(--pri)} .menu-i.on{background:#eaf2fd;color:var(--pri);border-left-color:var(--pri);font-weight:600}
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
  .login-l{flex:1.1;background:linear-gradient(150deg,#2c5aa0,#1e3f6f);color:#fff;padding:40px 36px;display:flex;flex-direction:column;justify-content:center}
  .login-r{flex:1;padding:40px 36px}
  .muted{color:var(--muted)} .right{text-align:right}
</style></head><body>
${u ? `<div class="top"><span class="logo">华信数字<small>企业协同平台</small></span><span class="sp"></span>
<span class="u">👤 ${u}｜大客户事业部</span><a href="/logout">退出</a></div>
<div class="wrap"><aside>${nav}</aside><main><div class="crumb">${crumb}</div>${body}</main></div>` : body}
</body></html>`
}

// ---- 登录 ----
app.get('/login', (req, res) => {
  const next = req.query.next || '/portal'
  res.send(layout(req, '', '', `<div class="login-wrap">
    <div class="login-l"><div style="font-size:22px;font-weight:800">华信数字 · 企业协同平台</div>
      <div style="opacity:.85;margin-top:10px;line-height:1.9">协同办公 · 合同审批 · 客户关系管理<br>一体化企业数字化工作平台</div>
      <div style="opacity:.6;margin-top:26px;font-size:12px">v6.2 企业版 · 内网访问</div></div>
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
  res.setHeader('Set-Cookie', `hxoa_user=${encodeURIComponent(username.trim())}; Path=/; HttpOnly; Max-Age=604800`)
  res.redirect(next && next.startsWith('/') ? next : '/portal')
})
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'hxoa_user=; Path=/; Max-Age=0'); res.redirect('/login') })
app.get('/', (req, res) => res.redirect(currentUser(req) ? '/portal' : '/login'))

// ---- 门户首页 ----
app.get('/portal', requireAuth, (req, res) => {
  const pend = db.contracts.filter(c => c.state === 'pending').length
  const todoRows = db.contracts.filter(c => c.state === 'pending').map(c =>
    `<tr><td><a class="lnk" href="/contract/${c.id}">${c.name}</a></td><td>${c.applicant}</td><td>${c.applyAt}</td><td><span class="tag t-pending">待审批</span></td></tr>`).join('')
  res.send(layout(req, 'portal', '门户首页', `
    <div class="stat">
      <div class="c"><div class="n">${pend}</div><div class="l">待我审批</div></div>
      <div class="c"><div class="n">${db.opportunities.length}</div><div class="l">跟进中商机</div></div>
      <div class="c"><div class="n">${db.customers.length}</div><div class="l">我的客户</div></div>
      <div class="c"><div class="n">${db.visits.length}</div><div class="l">本月跟进</div></div>
    </div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>我的待办</div><div class="panel-b" style="padding:0">
      <table><tr><th>事项</th><th>发起人</th><th>发起时间</th><th>状态</th></tr>${todoRows || '<tr><td colspan="4" class="muted" style="padding:14px">暂无待办</td></tr>'}</table>
    </div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>系统公告</div><div class="panel-b muted">【运维通知】本平台为内网演示环境，数据仅供测试。</div></div>`))
})
app.get('/todo', requireAuth, (req, res) => res.redirect('/contract/list'))

// ================= 合同审批 =================
app.get('/contract/list', requireAuth, (req, res) => {
  const rows = db.contracts.map(c => `<tr>
    <td>${c.id}</td><td><a class="lnk" href="/contract/${c.id}">${c.name}</a></td>
    <td>${c.customer}</td><td class="right">${money(c.amount)}</td><td>${c.applicant}</td>
    <td><span class="tag t-${c.state}">${STATE_CN[c.state]}</span>${c.urgency === '加急' ? '<span class="tag t-urg">加急</span>' : ''}</td></tr>`).join('')
  res.send(layout(req, 'contract', '合同管理 / <b>合同审批</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>合同审批 · 待办列表<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.contracts.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>流程编号</th><th>合同名称</th><th>客户</th><th class="right">金额</th><th>申请人</th><th>状态</th></tr>${rows}</table></div></div>`))
})
app.get('/contract/:id', requireAuth, (req, res) => {
  const c = db.contracts.find(x => x.id === req.params.id)
  if (!c) return res.status(404).send(layout(req, 'contract', '合同审批', '<div class="panel"><div class="panel-b">流程不存在</div></div>'))
  const done = c.state !== 'pending'
  const ok = req.query.ok ? `<div class="ok">✅ 审批操作已提交：该流程当前状态为「${STATE_CN[c.state]}」</div>` : ''
  res.send(layout(req, 'contract', `合同管理 / 合同审批 / <b>${c.id}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>审批流程详情</div><div class="panel-b">
      <div class="kv">
        <div class="k">流程编号</div><div id="flowNo">${c.id}</div><div class="k">紧急程度</div><div>${c.urgency}</div>
        <div class="k">发起人</div><div>${c.applicant}</div><div class="k">发起部门</div><div>${c.dept}</div>
        <div class="k">发起时间</div><div>${c.applyAt}</div><div class="k">当前状态</div><div><span class="tag t-${c.state}">${STATE_CN[c.state]}</span></div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>合同信息</div><div class="panel-b">
      <div class="kv">
        <div class="k">合同名称</div><div id="contractName" class="full">${c.name}</div>
        <div class="k">客户名称</div><div id="customer">${c.customer}</div><div class="k">签约主体</div><div>${c.party}</div>
        <div class="k">合同金额</div><div id="amount">${money(c.amount)}</div><div class="k">合同类型</div><div>采购合同</div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>审批操作</div><div class="panel-b">
      ${done ? `<div class="muted">该流程已办结，审批意见：${c.opinion || '（无）'}</div>` : `
      <form class="f" method="post" action="/contract/${c.id}/approve">
        <label for="opinion">审批意见</label><textarea id="opinion" name="opinion" placeholder="请输入审批意见（可选）"></textarea>
        <div class="acts">
          <button id="approveBtn" class="btn" type="submit">同意</button>
          <button id="rejectBtn" class="btn plain" type="submit" formaction="/contract/${c.id}/reject">退回</button>
        </div></form>`}
    </div></div>`))
})
app.post('/contract/:id/approve', requireAuth, (req, res) => { const c = db.contracts.find(x => x.id === req.params.id); if (c) { c.state = 'approved'; c.opinion = (req.body.opinion || '同意').trim() } res.redirect(`/contract/${req.params.id}?ok=1`) })
app.post('/contract/:id/reject', requireAuth, (req, res) => { const c = db.contracts.find(x => x.id === req.params.id); if (c) { c.state = 'rejected'; c.opinion = (req.body.opinion || '退回').trim() } res.redirect(`/contract/${req.params.id}?ok=1`) })

// ================= CRM：客户 / 商机 / 跟进 =================
app.get('/crm/customers', requireAuth, (req, res) => {
  const rows = db.customers.map(c => `<tr><td>${c.id}</td><td>${c.name}</td><td>${c.industry}</td><td>${c.level}</td><td>${c.owner}</td></tr>`).join('')
  res.send(layout(req, 'customers', '客户管理 / <b>客户档案</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>客户档案</div><div class="panel-b" style="padding:0">
    <table><tr><th>客户编号</th><th>客户名称</th><th>所属行业</th><th>客户级别</th><th>负责人</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/opportunities', requireAuth, (req, res) => {
  const rows = db.opportunities.map(o => `<tr>
    <td>${o.id}</td><td><a class="lnk" href="/crm/opportunity/${o.id}">${o.name}</a></td><td>${o.customer}</td>
    <td class="right">${money(o.amount)}</td><td><span class="tag t-stage">${o.stage}</span></td><td>${o.owner}</td></tr>`).join('')
  res.send(layout(req, 'opp', '客户管理 / <b>商机管理</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>商机列表<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.opportunities.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>商机编号</th><th>商机名称</th><th>客户</th><th class="right">预计金额</th><th>销售阶段</th><th>负责人</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/opportunity/:id', requireAuth, (req, res) => {
  const o = db.opportunities.find(x => x.id === req.params.id)
  if (!o) return res.status(404).send(layout(req, 'opp', '商机', '<div class="panel"><div class="panel-b">商机不存在</div></div>'))
  const ok = req.query.ok ? `<div class="ok">✅ 已保存：销售阶段更新为「${o.stage}」</div>` : ''
  const opts = STAGES.map(s => `<option value="${s}" ${s === o.stage ? 'selected' : ''}>${s}</option>`).join('')
  res.send(layout(req, 'opp', `客户管理 / 商机管理 / <b>${o.name}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>商机详情</div><div class="panel-b">
      <div class="kv">
        <div class="k">商机编号</div><div>${o.id}</div><div class="k">负责人</div><div>${o.owner}</div>
        <div class="k">客户名称</div><div id="customer">${o.customer}</div><div class="k">预计金额</div><div id="amount">${money(o.amount)}</div>
        <div class="k">当前阶段</div><div><span class="tag t-stage" id="curStage">${o.stage}</span></div><div class="k">预计成交</div><div>${o.expectClose}</div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>更新销售阶段</div><div class="panel-b">
      <form class="f" method="post" action="/crm/opportunity/${o.id}/advance">
        <label for="stage">销售阶段</label><select id="stage" name="stage">${opts}</select>
        <div class="acts"><button id="advanceBtn" class="btn" type="submit">保存</button></div></form>
    </div></div>`))
})
app.post('/crm/opportunity/:id/advance', requireAuth, (req, res) => { const o = db.opportunities.find(x => x.id === req.params.id); if (o && STAGES.includes(req.body.stage)) o.stage = req.body.stage; res.redirect(`/crm/opportunity/${req.params.id}?ok=1`) })

// 跟进记录（传统 CRM「跟进记录」，其中「跟进方式=拜访」即一次拜访）
app.get('/crm/follow', requireAuth, (req, res) => {
  const rows = db.visits.length
    ? db.visits.map(v => `<tr><td>${v.visitDate || '—'}</td><td>${v.customer}</td><td>${v.contact}</td><td>${v.way || '拜访'}</td><td>${v.summary}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted" style="padding:14px">暂无跟进记录</td></tr>'
  res.send(layout(req, 'follow', '客户管理 / <b>跟进记录</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>跟进记录
      <span class="sp"></span><a class="lnk" href="/crm/follow/new" style="margin-left:auto">+ 新建跟进</a></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>跟进日期</th><th>客户</th><th>联系人</th><th>跟进方式</th><th>跟进内容</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/follow/new', requireAuth, (req, res) => {
  res.send(layout(req, 'follow', '客户管理 / 跟进记录 / <b>新建跟进</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>新建跟进记录</div><div class="panel-b">
      <form class="f" method="post" action="/crm/follow">
        <div class="grid2">
          <div><label for="customer">客户名称</label><input id="customer" name="customer" placeholder="如 宝钢集团"></div>
          <div><label for="contact">联系人</label><input id="contact" name="contact" placeholder="如 李建国"></div>
          <div><label for="way">跟进方式</label><select id="way" name="way"><option>拜访</option><option>电话</option><option>邮件</option><option>线上会议</option></select></div>
          <div><label for="visitDate">跟进日期</label><input id="visitDate" name="visitDate" placeholder="如 2026-07-02"></div>
        </div>
        <label for="summary">跟进内容</label><textarea id="summary" name="summary" placeholder="本次跟进的沟通内容与结论"></textarea>
        <label for="nextPlan">下次跟进计划</label><input id="nextPlan" name="nextPlan" placeholder="选填">
        <div class="acts"><button id="submitBtn" class="btn" type="submit">保存</button>
          <a class="btn gray" href="/crm/follow" style="text-decoration:none;display:inline-flex;align-items:center">取消</a></div>
      </form></div></div>`))
})
app.post('/crm/follow', requireAuth, (req, res) => {
  const { customer, contact, way, visitDate, summary, nextPlan } = req.body
  db.visits.unshift({ id: 'GJ' + (db.seq++), customer: customer || '', contact: contact || '', way: way || '拜访', visitDate: visitDate || '', summary: summary || '', nextPlan: nextPlan || '' })
  res.redirect('/crm/follow?ok=1')
})

// 兼容旧演示路径（拜访录入）
app.get('/crm/visit/new', requireAuth, (req, res) => res.redirect('/crm/follow/new'))
app.get('/crm/visits', requireAuth, (req, res) => res.redirect('/crm/follow'))

// ================= CRM：客户拜访反馈（复杂表单 · 多下拉） =================
app.get('/crm/feedbacks', requireAuth, (req, res) => {
  const rows = db.feedbacks.length
    ? db.feedbacks.map(f => `<tr><td>${f.id}</td><td>${f.customer}</td><td>${f.contact}</td><td>${f.visitType}</td><td>${f.visitResult}</td><td>${f.salesPlatform}</td><td>${f.progress || ''}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted" style="padding:14px">暂无拜访反馈</td></tr>'
  res.send(layout(req, 'feedback', '客户管理 / <b>拜访反馈</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>客户拜访反馈
      <span class="sp"></span><a class="lnk" href="/crm/feedback/new" style="margin-left:auto">+ 新建反馈</a></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>编号</th><th>客户</th><th>联系人</th><th>拜访形式</th><th>拜访结果</th><th>销售平台归属</th><th>当前进展</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/feedback/new', requireAuth, (req, res) => {
  res.send(layout(req, 'feedback', '客户管理 / 拜访反馈 / <b>新建拜访反馈</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>新建客户拜访反馈</div><div class="panel-b">
      <form class="f" method="post" action="/crm/feedback">
        <div class="grid2">
          <div><label for="visitType">拜访形式</label><select id="visitType" name="visitType">${optHtml(FB.visitType)}</select></div>
          <div><label for="visitResult">本次拜访结果</label><select id="visitResult" name="visitResult">${optHtml(FB.visitResult)}</select></div>
          <div><label for="customer">客户名称</label><select id="customer" name="customer">${optHtml(FB.customer)}</select></div>
          <div><label for="contact">联系人</label><select id="contact" name="contact">${optHtml(FB.contact)}</select></div>
          <div><label for="salesPlatform">销售平台归属</label><select id="salesPlatform" name="salesPlatform">${optHtml(FB.salesPlatform)}</select></div>
          <div><label for="region">区域平台归属</label><select id="region" name="region">${optHtml(FB.region)}</select></div>
          <div><label for="priority">优先级</label><select id="priority" name="priority">${optHtml(FB.priority)}</select></div>
          <div><label for="amount">预计商机金额(元)</label><input id="amount" name="amount" placeholder="如 2800000"></div>
          <div><label for="visitDate">拜访日期</label><input id="visitDate" name="visitDate" placeholder="如 2026-07-02"></div>
        </div>
        <label for="progress">当前进展</label><textarea id="progress" name="progress" placeholder="本次拜访了解到的进展"></textarea>
        <label for="nextPlan">下一步计划</label><textarea id="nextPlan" name="nextPlan" placeholder="后续推进计划"></textarea>
        <div class="acts"><button id="submitBtn" class="btn" type="submit">提交</button>
          <a class="btn gray" href="/crm/feedbacks" style="text-decoration:none;display:inline-flex;align-items:center">取消</a></div>
      </form></div></div>`))
})
app.post('/crm/feedback', requireAuth, (req, res) => {
  const b = req.body
  db.feedbacks.unshift({ id: 'FB' + (db.seq++), visitType: b.visitType || '', visitResult: b.visitResult || '', customer: b.customer || '', contact: b.contact || '', salesPlatform: b.salesPlatform || '', region: b.region || '', priority: b.priority || '', amount: b.amount || '', visitDate: b.visitDate || '', progress: b.progress || '', nextPlan: b.nextPlan || '' })
  res.redirect('/crm/feedbacks?ok=1')
})

// 状态快照（便于 curl 验证真实写入是否落库）
app.get('/api/state', requireAuth, (req, res) => res.json({ contracts: db.contracts, opportunities: db.opportunities, visits: db.visits, feedbacks: db.feedbacks }))

app.listen(PORT, () => console.log(`[iml-mock-oa] 华信数字协同平台(Mock) → http://localhost:${PORT}  （登录任意账号密码）`))
