// 华信数字 · 客户关系管理系统 CRM（Mock）—— 客户管理 / 商机进度管理 / 跟进记录 / 拜访反馈 / 商机拜访记录。
// 三套演示系统之一（OA :8090 / CRM :8091 / ERM :8092）。/crm/* 路由与页面结构从旧混合版原样搬入
// （已录制的「CRM拜访反馈录入」技能与本体消解依赖元素 id 与路径）。数据在内存，重启复位。仅演示。
const express = require('express')
const { money, optHtml, makeHelpers } = require('./lib/common')
const app = express()
const PORT = process.env.MOCK_CRM_PORT || 8091

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const { requireAuth, layout, mountAuth, mountDemoReset } = makeHelpers({
  cookieName: 'hxcrm_user',
  brand: '华信数字', brandSub: '客户关系管理系统 (CRM)', dept: '央国企销售一部',
  pri: '#0f766e', pri2: '#14907f', priDark: '#0b5d57',
  loginLead: '客户管理 · 商机进度 · 拜访记录<br>以客户为中心的销售过程管理平台',
  version: 'v4.8 企业版',
  menu: [
    { g: '客户管理', items: [['/crm/customers', '客户档案', 'customers'], ['/crm/contacts', '联系人', 'contacts']] },
    { g: '商机管理', items: [['/crm/opportunities', '商机管理', 'opp'], ['/crm/opp-visits', '商机拜访记录', 'oppVisit']] },
    { g: '拜访管理', items: [['/crm/follow', '跟进记录', 'follow'], ['/crm/feedbacks', '拜访反馈', 'feedback']] },
    { g: '统计报表', items: [['#', '销售漏斗', ''], ['#', '经营看板', '']] },
  ],
})

// ---- 内存数据 ----
const seedDb = () => ({
  opportunities: [
    { id: 'SJ20260012', name: '宝钢钢铁数字化项目', customer: '宝钢集团', amount: 2800000, stage: '初步接触', owner: '王磊', expectClose: '2026-09-30' },
    { id: 'SJ20260018', name: '宝钢产线智能改造', customer: '宝钢集团', amount: 60000000, stage: '方案报价', owner: '王磊', expectClose: '2026-12-15' },
    { id: 'SJ20260021', name: '华东电网巡检平台二期', customer: '华东电网', amount: 5600000, stage: '需求确认', owner: '李强', expectClose: '2026-11-30' },
  ],
  customers: [
    { id: 'KH001', name: '宝钢集团', industry: '钢铁冶金', level: 'A（战略客户）', owner: '王磊' },
    { id: 'KH002', name: '华东电网', industry: '能源电力', level: 'A（战略客户）', owner: '李强' },
    { id: 'KH003', name: '招商银行', industry: '金融银行', level: 'B（重点客户）', owner: '周敏' },
  ],
  contacts: [
    { id: 'LX001', customer: '宝钢集团', name: '李建国', title: '采购部主任', phone: '138****6621' },
    { id: 'LX002', customer: '华东电网', name: '张伟', title: '信息中心处长', phone: '139****3382' },
  ],
  visits: [],
  feedbacks: [],
  oppVisits: [
    { id: 'SBF1', opp: '宝钢产线智能改造', customer: '宝钢集团', contact: '李建国', visitDate: '2026-07-01', stageAt: '方案报价', summary: '汇报整体方案与报价构成，客户关注产线停机窗口', nextPlan: '一周内出停机影响评估' },
  ],
  seq: 10,
})
// 内存数据实例；复位=用种子整体覆盖（对象引用不变，闭包安全）
const db = seedDb()
const resetDb = () => { Object.keys(db).forEach(k => delete db[k]); Object.assign(db, seedDb()) }
const STAGES = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单', '输单']
const FB = {
  visitType: ['现场拜访', '线上拜访', '电话拜访'],
  visitResult: ['线索挖掘（MTL）', '商机推动（LTO）', '履约回款（OTC）', '客户服务（其他）'],
  customer: ['宝钢集团', '华东电网', '中国石化', '招商银行', '比亚迪', '国家电网'],
  contact: ['李建国', '张伟', '王芳', '陈明', '刘洋'],
  salesPlatform: ['星火企业军团自营', '教育BG', '智慧城市BG', '金融事业部', '能源事业部', '智能汽车'],
  region: ['央国企销售部-销售一部', '央国企销售部-销售四部', '金融销售部-华北地区部', '金融销售部-华南地区部', '华东地区部', '中西地区部'],
  priority: ['高', '中', '低'],
}

mountAuth(app, '/crm/customers')
mountDemoReset(app, resetDb, '/crm/customers')

// ================= 客户 / 联系人 =================
app.get('/crm/customers', requireAuth, (req, res) => {
  const rows = db.customers.map(c => `<tr><td>${c.id}</td><td>${c.name}</td><td>${c.industry}</td><td>${c.level}</td><td>${c.owner}</td></tr>`).join('')
  res.send(layout(req, 'customers', '客户管理 / <b>客户档案</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>客户档案</div><div class="panel-b" style="padding:0">
    <table><tr><th>客户编号</th><th>客户名称</th><th>所属行业</th><th>客户级别</th><th>负责人</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/contacts', requireAuth, (req, res) => {
  const rows = db.contacts.map(c => `<tr><td>${c.id}</td><td>${c.customer}</td><td>${c.name}</td><td>${c.title}</td><td>${c.phone}</td></tr>`).join('')
  res.send(layout(req, 'contacts', '客户管理 / <b>联系人</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>联系人</div><div class="panel-b" style="padding:0">
    <table><tr><th>编号</th><th>客户</th><th>姓名</th><th>职务</th><th>电话</th></tr>${rows}</table></div></div>`))
})

// ================= 商机（阶段推进 = 商机进度管理） =================
app.get('/crm/opportunities', requireAuth, (req, res) => {
  const rows = db.opportunities.map(o => `<tr>
    <td>${o.id}</td><td><a class="lnk" href="/crm/opportunity/${o.id}">${o.name}</a></td><td>${o.customer}</td>
    <td class="right">${money(o.amount)}</td><td><span class="tag t-stage">${o.stage}</span></td><td>${o.owner}</td></tr>`).join('')
  res.send(layout(req, 'opp', '商机管理 / <b>商机管理</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>商机列表<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.opportunities.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>商机编号</th><th>商机名称</th><th>客户</th><th class="right">预计金额</th><th>销售阶段</th><th>负责人</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/opportunity/:id', requireAuth, (req, res) => {
  const o = db.opportunities.find(x => x.id === req.params.id)
  if (!o) return res.status(404).send(layout(req, 'opp', '商机', '<div class="panel"><div class="panel-b">商机不存在</div></div>'))
  const ok = req.query.ok ? `<div class="ok">✅ 已保存：销售阶段更新为「${o.stage}」</div>` : ''
  const opts = STAGES.map(s => `<option value="${s}" ${s === o.stage ? 'selected' : ''}>${s}</option>`).join('')
  const oppVisitRows = db.oppVisits.filter(v => v.opp === o.name).map(v =>
    `<tr><td>${v.visitDate}</td><td>${v.contact}</td><td>${v.stageAt}</td><td>${v.summary}</td></tr>`).join('')
  res.send(layout(req, 'opp', `商机管理 / 商机管理 / <b>${o.name}</b>`, `${ok}
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
    </div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>本商机拜访记录
      <span class="sp"></span><a class="lnk" href="/crm/opp-visit/new?opp=${encodeURIComponent(o.name)}" style="margin-left:auto">+ 新建拜访</a></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>拜访日期</th><th>联系人</th><th>拜访时阶段</th><th>纪要</th></tr>${oppVisitRows || '<tr><td colspan="4" class="muted" style="padding:14px">暂无拜访记录</td></tr>'}</table></div></div>`))
})
app.post('/crm/opportunity/:id/advance', requireAuth, (req, res) => { const o = db.opportunities.find(x => x.id === req.params.id); if (o && STAGES.includes(req.body.stage)) o.stage = req.body.stage; res.redirect(`/crm/opportunity/${req.params.id}?ok=1`) })

// ================= 商机拜访记录（挂在具体商机下的拜访） =================
app.get('/crm/opp-visits', requireAuth, (req, res) => {
  const rows = db.oppVisits.length
    ? db.oppVisits.map(v => `<tr><td>${v.visitDate}</td><td>${v.opp}</td><td>${v.customer}</td><td>${v.contact}</td><td><span class="tag t-stage">${v.stageAt}</span></td><td>${v.summary}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted" style="padding:14px">暂无商机拜访记录</td></tr>'
  res.send(layout(req, 'oppVisit', '商机管理 / <b>商机拜访记录</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>商机拜访记录
      <span class="sp"></span><a class="lnk" href="/crm/opp-visit/new" style="margin-left:auto">+ 新建商机拜访</a></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>拜访日期</th><th>关联商机</th><th>客户</th><th>联系人</th><th>拜访时阶段</th><th>纪要</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/opp-visit/new', requireAuth, (req, res) => {
  const pre = req.query.opp || ''
  const oppOpts = db.opportunities.map(o => `<option value="${o.name}" ${o.name === pre ? 'selected' : ''}>${o.name}</option>`).join('')
  res.send(layout(req, 'oppVisit', '商机管理 / 商机拜访记录 / <b>新建商机拜访</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>新建商机拜访记录</div><div class="panel-b">
      <form class="f" method="post" action="/crm/opp-visit">
        <div class="grid2">
          <div><label for="opp">关联商机</label><select id="opp" name="opp">${oppOpts}</select></div>
          <div><label for="contact">联系人</label><input id="contact" name="contact" placeholder="如 李建国"></div>
          <div><label for="visitDate">拜访日期</label><input id="visitDate" name="visitDate" placeholder="如 2026-07-05"></div>
        </div>
        <label for="summary">拜访纪要</label><textarea id="summary" name="summary" placeholder="本次拜访沟通内容与结论"></textarea>
        <label for="nextPlan">下一步计划</label><input id="nextPlan" name="nextPlan" placeholder="选填">
        <div class="acts"><button id="submitBtn" class="btn" type="submit">保存</button>
          <a class="btn gray" href="/crm/opp-visits" style="text-decoration:none;display:inline-flex;align-items:center">取消</a></div>
      </form></div></div>`))
})
app.post('/crm/opp-visit', requireAuth, (req, res) => {
  const b = req.body
  const o = db.opportunities.find(x => x.name === b.opp)
  db.oppVisits.unshift({ id: 'SBF' + (db.seq++), opp: b.opp || '', customer: o ? o.customer : '', contact: b.contact || '', visitDate: b.visitDate || '', stageAt: o ? o.stage : '', summary: b.summary || '', nextPlan: b.nextPlan || '' })
  res.redirect('/crm/opp-visits?ok=1')
})

// ================= 跟进记录（「跟进方式=拜访」即一次拜访） =================
app.get('/crm/follow', requireAuth, (req, res) => {
  const rows = db.visits.length
    ? db.visits.map(v => `<tr><td>${v.visitDate || '—'}</td><td>${v.customer}</td><td>${v.contact}</td><td>${v.way || '拜访'}</td><td>${v.summary}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted" style="padding:14px">暂无跟进记录</td></tr>'
  res.send(layout(req, 'follow', '拜访管理 / <b>跟进记录</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>跟进记录
      <span class="sp"></span><a class="lnk" href="/crm/follow/new" style="margin-left:auto">+ 新建跟进</a></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>跟进日期</th><th>客户</th><th>联系人</th><th>跟进方式</th><th>跟进内容</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/follow/new', requireAuth, (req, res) => {
  res.send(layout(req, 'follow', '拜访管理 / 跟进记录 / <b>新建跟进</b>', `
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

// ================= 客户拜访反馈（复杂表单 · 多下拉 · ⚠️ 元素 id 与旧版一致，录制技能依赖） =================
app.get('/crm/feedbacks', requireAuth, (req, res) => {
  const rows = db.feedbacks.length
    ? db.feedbacks.map(f => `<tr><td>${f.id}</td><td>${f.customer}</td><td>${f.contact}</td><td>${f.visitType}</td><td>${f.visitResult}</td><td>${f.salesPlatform}</td><td>${f.progress || ''}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted" style="padding:14px">暂无拜访反馈</td></tr>'
  res.send(layout(req, 'feedback', '拜访管理 / <b>拜访反馈</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>客户拜访反馈
      <span class="sp"></span><a class="lnk" href="/crm/feedback/new" style="margin-left:auto">+ 新建反馈</a></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>编号</th><th>客户</th><th>联系人</th><th>拜访形式</th><th>拜访结果</th><th>销售平台归属</th><th>当前进展</th></tr>${rows}</table></div></div>`))
})
app.get('/crm/feedback/new', requireAuth, (req, res) => {
  res.send(layout(req, 'feedback', '拜访管理 / 拜访反馈 / <b>新建拜访反馈</b>', `
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
app.get('/api/state', requireAuth, (req, res) => res.json({ opportunities: db.opportunities, customers: db.customers, visits: db.visits, feedbacks: db.feedbacks, oppVisits: db.oppVisits }))

app.listen(PORT, () => console.log(`[iml-mock-crm] 华信数字 · 客户关系管理系统 CRM (Mock) → http://localhost:${PORT}  （登录任意账号密码）`))
