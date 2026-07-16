// 华信数字 · 企业协同平台 OA（Mock）—— 统一待办 / 考勤打卡 / 差旅申请-审批 / 合同审批。
// 三套演示系统之一（OA :8090 / CRM :8091 / ERM :8092），用于演示系统对接、系统操作与本体建模。
// 合同审批页面与菜单位次保持与旧版逐字节兼容（已录制技能/本体执行器依赖）。数据在内存，重启复位。仅演示。
const express = require('express')
const { money, makeHelpers } = require('./lib/common')
const app = express()
const PORT = process.env.MOCK_OA_PORT || 8090
const CRM_BASE = process.env.MOCK_CRM_URL || 'http://localhost:8091'

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const { currentUser, requireAuth, layout, mountAuth, mountDemoReset } = makeHelpers({
  cookieName: 'hxoa_user',
  brand: '华信数字', brandSub: '企业协同平台', dept: '大客户事业部',
  pri: '#2c5aa0', pri2: '#3a6cb5', priDark: '#24507f',
  loginLead: '统一待办 · 考勤差旅 · 合同审批<br>一体化企业协同办公平台',
  version: 'v6.2 企业版',
  // ⚠️ 前 5 个 <a> 的位次不可变（已录制技能的 selector 依赖第 5 个是「合同审批」）
  menu: [
    { g: '协同办公', items: [['/portal', '门户首页', 'portal'], ['/todo', '统一待办', 'todo'], ['#', '公文流转', ''], ['/attendance', '考勤打卡', 'att']] },
    { g: '合同管理', items: [['/contract/list', '合同审批', 'contract'], ['#', '合同台账', '']] },
    { g: '差旅管理', items: [['/travel/new', '差旅申请', 'travelNew'], ['/travel/list', '差旅审批', 'travel']] },
    { g: '统计报表', items: [['#', '经营看板', '']] },
  ],
})

// ---- 内存数据 ----
const seedDb = () => ({
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
  travels: [
    { id: 'CL-2026-0007', applicant: '王磊', dept: '大客户事业部', dest: '上海 · 宝钢集团', reason: '宝钢产线智能改造项目现场调研', startAt: '2026-07-08', endAt: '2026-07-10', budget: 6800, state: 'pending', opinion: '' },
    { id: 'CL-2026-0009', applicant: '李强', dept: '能源事业部', dest: '南京 · 华东电网', reason: '智能巡检平台交付验收支持', startAt: '2026-07-09', endAt: '2026-07-11', budget: 5200, state: 'pending', opinion: '' },
    { id: 'CL-2026-0004', applicant: '周敏', dept: '金融事业部', dest: '深圳 · 招商银行', reason: '数据中台项目启动会', startAt: '2026-06-30', endAt: '2026-07-01', budget: 4300, state: 'approved', opinion: '同意' },
  ],
  attendance: [
    { user: 'wanglei', date: '2026-07-03', in: '08:52', out: '18:31' },
    { user: 'wanglei', date: '2026-07-04', in: '08:47', out: '19:05' },
  ],
  seq: 10,
})
// 内存数据实例；复位=用种子整体覆盖（对象引用不变，闭包安全）
const db = seedDb()
const resetDb = () => { Object.keys(db).forEach(k => delete db[k]); Object.assign(db, seedDb()) }
const STATE_CN = { pending: '审批中', approved: '已通过', rejected: '已退回' }

mountAuth(app)
mountDemoReset(app, resetDb)

// ---- 门户首页（统计 + 待办摘要） ----
app.get('/portal', requireAuth, (req, res) => {
  const pendC = db.contracts.filter(c => c.state === 'pending').length
  const pendT = db.travels.filter(t => t.state === 'pending').length
  const todoRows = [
    ...db.contracts.filter(c => c.state === 'pending').map(c =>
      `<tr><td>合同审批</td><td><a class="lnk" href="/contract/${c.id}">${c.name}</a></td><td>${c.applicant}</td><td>${c.applyAt}</td><td><span class="tag t-pending">待审批</span></td></tr>`),
    ...db.travels.filter(t => t.state === 'pending').map(t =>
      `<tr><td>差旅审批</td><td><a class="lnk" href="/travel/${t.id}">${t.dest}（${t.reason}）</a></td><td>${t.applicant}</td><td>${t.startAt}</td><td><span class="tag t-pending">待审批</span></td></tr>`),
  ].join('')
  res.send(layout(req, 'portal', '门户首页', `
    <div class="stat">
      <div class="c"><div class="n">${pendC + pendT}</div><div class="l">待我审批</div></div>
      <div class="c"><div class="n">${pendC}</div><div class="l">合同流程</div></div>
      <div class="c"><div class="n">${pendT}</div><div class="l">差旅申请</div></div>
      <div class="c"><div class="n">${db.attendance.length}</div><div class="l">本月打卡</div></div>
    </div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>我的待办</div><div class="panel-b" style="padding:0">
      <table><tr><th>类型</th><th>事项</th><th>发起人</th><th>时间</th><th>状态</th></tr>${todoRows || '<tr><td colspan="5" class="muted" style="padding:14px">暂无待办</td></tr>'}</table>
    </div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>系统公告</div><div class="panel-b muted">【运维通知】本平台为内网演示环境，数据仅供测试。CRM/ERM 请访问对应系统。</div></div>`))
})

// ---- 统一待办（聚合各流程的待审批项，跨模块统一入口） ----
app.get('/todo', requireAuth, (req, res) => {
  const rows = [
    ...db.contracts.filter(c => c.state === 'pending').map(c =>
      `<tr><td>${c.id}</td><td>合同审批</td><td><a class="lnk" href="/contract/${c.id}">${c.name}</a></td><td>${c.applicant} · ${c.dept}</td><td class="right">${money(c.amount)}</td><td>${c.applyAt}</td></tr>`),
    ...db.travels.filter(t => t.state === 'pending').map(t =>
      `<tr><td>${t.id}</td><td>差旅审批</td><td><a class="lnk" href="/travel/${t.id}">${t.dest} · ${t.reason}</a></td><td>${t.applicant} · ${t.dept}</td><td class="right">${money(t.budget)}</td><td>${t.startAt}</td></tr>`),
  ].join('')
  res.send(layout(req, 'todo', '协同办公 / <b>统一待办</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>统一待办<span class="muted" style="font-weight:400;margin-left:8px">跨流程聚合 · 点击进入办理</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>编号</th><th>流程类型</th><th>事项</th><th>发起人</th><th class="right">金额</th><th>发起时间</th></tr>${rows || '<tr><td colspan="6" class="muted" style="padding:14px">暂无待办</td></tr>'}</table></div></div>`))
})

// ---- 考勤打卡 ----
app.get('/attendance', requireAuth, (req, res) => {
  const u = currentUser(req)
  const mine = db.attendance.filter(a => a.user === u)
  const rows = mine.length
    ? mine.map(a => `<tr><td>${a.date}</td><td>${a.in || '—'}</td><td>${a.out || '—'}</td><td>${a.in && a.out ? '<span class="tag t-approved">正常</span>' : '<span class="tag t-pending">进行中</span>'}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted" style="padding:14px">暂无打卡记录</td></tr>'
  const ok = req.query.ok ? `<div class="ok">✅ 打卡成功（${req.query.ok}）</div>` : ''
  res.send(layout(req, 'att', '协同办公 / <b>考勤打卡</b>', `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>今日打卡</div><div class="panel-b">
      <form class="f" method="post" action="/attendance/punch" style="display:flex;gap:10px">
        <button id="punchInBtn" class="btn" type="submit" name="kind" value="in">上班打卡</button>
        <button id="punchOutBtn" class="btn gray" type="submit" name="kind" value="out">下班打卡</button>
      </form></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>我的打卡记录</div><div class="panel-b" style="padding:0">
      <table><tr><th>日期</th><th>上班</th><th>下班</th><th>状态</th></tr>${rows}</table></div></div>`))
})
app.post('/attendance/punch', requireAuth, (req, res) => {
  const u = currentUser(req)
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  let rec = db.attendance.find(a => a.user === u && a.date === date)
  if (!rec) { rec = { user: u, date, in: '', out: '' }; db.attendance.unshift(rec) }
  if (req.body.kind === 'out') rec.out = hm; else rec.in = rec.in || hm
  res.redirect('/attendance?ok=' + encodeURIComponent(`${req.body.kind === 'out' ? '下班' : '上班'} ${hm}`))
})

// ---- 差旅申请 / 审批 ----
app.get('/travel/new', requireAuth, (req, res) => {
  res.send(layout(req, 'travelNew', '差旅管理 / <b>差旅申请</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>新建差旅申请</div><div class="panel-b">
      <form class="f" method="post" action="/travel">
        <div class="grid2">
          <div><label for="dest">目的地</label><input id="dest" name="dest" placeholder="如 上海 · 宝钢集团"></div>
          <div><label for="budget">预算(元)</label><input id="budget" name="budget" type="number" min="0" step="100" placeholder="如 6800"></div>
          <div><label for="startAt">出发日期</label><input id="startAt" name="startAt" type="date"></div>
          <div><label for="endAt">返回日期</label><input id="endAt" name="endAt" type="date"></div>
        </div>
        <label for="reason">出差事由</label><textarea id="reason" name="reason" placeholder="出差目的与主要安排"></textarea>
        <div class="acts"><button id="submitBtn" class="btn" type="submit">提交申请</button></div>
      </form></div></div>`))
})
app.post('/travel', requireAuth, (req, res) => {
  const b = req.body
  const id = 'CL-2026-' + String(db.seq++).padStart(4, '0')
  db.travels.unshift({ id, applicant: currentUser(req), dept: '大客户事业部', dest: b.dest || '', reason: b.reason || '', startAt: b.startAt || '', endAt: b.endAt || '', budget: Number(b.budget) || 0, state: 'pending', opinion: '' })
  res.redirect('/travel/list')
})
app.get('/travel/list', requireAuth, (req, res) => {
  const rows = db.travels.map(t => `<tr>
    <td>${t.id}</td><td><a class="lnk" href="/travel/${t.id}">${t.dest}</a></td><td>${t.reason}</td>
    <td>${t.applicant}</td><td>${t.startAt} ~ ${t.endAt}</td><td class="right">${money(t.budget)}</td>
    <td><span class="tag t-${t.state}">${STATE_CN[t.state]}</span></td></tr>`).join('')
  res.send(layout(req, 'travel', '差旅管理 / <b>差旅审批</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>差旅审批 · 待办列表<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.travels.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>流程编号</th><th>目的地</th><th>事由</th><th>申请人</th><th>行程</th><th class="right">预算</th><th>状态</th></tr>${rows}</table></div></div>`))
})
app.get('/travel/:id', requireAuth, (req, res) => {
  const t = db.travels.find(x => x.id === req.params.id)
  if (!t) return res.status(404).send(layout(req, 'travel', '差旅审批', '<div class="panel"><div class="panel-b">流程不存在</div></div>'))
  const done = t.state !== 'pending'
  const ok = req.query.ok ? `<div class="ok">✅ 审批操作已提交：该流程当前状态为「${STATE_CN[t.state]}」</div>` : ''
  res.send(layout(req, 'travel', `差旅管理 / 差旅审批 / <b>${t.id}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>差旅申请详情</div><div class="panel-b">
      <div class="kv">
        <div class="k">流程编号</div><div id="flowNo">${t.id}</div><div class="k">申请人</div><div>${t.applicant}</div>
        <div class="k">目的地</div><div id="dest">${t.dest}</div><div class="k">所属部门</div><div>${t.dept}</div>
        <div class="k">行程</div><div>${t.startAt} ~ ${t.endAt}</div><div class="k">预算</div><div id="budget">${money(t.budget)}</div>
        <div class="k">出差事由</div><div class="full">${t.reason}</div>
        <div class="k">当前状态</div><div><span class="tag t-${t.state}">${STATE_CN[t.state]}</span></div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>审批操作</div><div class="panel-b">
      ${done ? `<div class="muted">该流程已办结，审批意见：${t.opinion || '（无）'}</div>` : `
      <form class="f" method="post" action="/travel/${t.id}/approve">
        <label for="opinion">审批意见</label><textarea id="opinion" name="opinion" placeholder="请输入审批意见（可选）"></textarea>
        <div class="acts">
          <button id="approveBtn" class="btn" type="submit">同意</button>
          <button id="rejectBtn" class="btn plain" type="submit" formaction="/travel/${t.id}/reject">退回</button>
        </div></form>`}
    </div></div>`))
})
app.post('/travel/:id/approve', requireAuth, (req, res) => { const t = db.travels.find(x => x.id === req.params.id); if (t) { t.state = 'approved'; t.opinion = (req.body.opinion || '同意').trim() } res.redirect(`/travel/${req.params.id}?ok=1`) })
app.post('/travel/:id/reject', requireAuth, (req, res) => { const t = db.travels.find(x => x.id === req.params.id); if (t) { t.state = 'rejected'; t.opinion = (req.body.opinion || '退回').trim() } res.redirect(`/travel/${req.params.id}?ok=1`) })

// ================= 合同审批（⚠️ 与旧版逐字节兼容：已录制技能/本体执行器依赖这些页面结构与元素 id） =================
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

// ---- CRM 已拆分为独立系统（:8091）：旧路径 302 兼容跳转 ----
app.get('/crm/*', (req, res) => res.redirect(302, CRM_BASE + req.originalUrl))

// 状态快照（便于 curl 验证真实写入是否落库）
app.get('/api/state', requireAuth, (req, res) => res.json({ contracts: db.contracts, travels: db.travels, attendance: db.attendance }))

app.listen(PORT, () => console.log(`[iml-mock-oa] 华信数字 · 企业协同平台 OA (Mock) → http://localhost:${PORT}  （登录任意账号密码）`))
