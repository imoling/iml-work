// 长庆石化 · 智能工厂协同平台（Mock）—— 面向炼化/危化行业的演示系统。
//
// 术语与模块对齐真实客户的《平台功能清单》：装置、生产指令、作业票、隐患排查、平稳率、报警。
// 三个演示闭环，各打一个岗位、各展示一种落地形态：
//   ① 生产指令审批（领导）      → 本体读驱动消解 + 审批卡（单据只读 / 审批动作 / 审批意见）
//   ② 隐患排查录入（普通员工）  → 自然语言抽字段 → 人工确认 → 真写入
//   ③ 生产数据监控（专业技术人员）→ SOP 免录制读页面 → 沙箱分析 → 产出日报
//
// 数据在内存、重启复位。仅演示，不含任何真实生产数据。
const express = require('express')
const { makeHelpers } = require('./lib/common')
const app = express()
const PORT = process.env.MOCK_PLANT_PORT || 8093

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const { requireAuth, layout, mountAuth, mountDemoReset } = makeHelpers({
  cookieName: 'hxplant_user',
  brand: '长庆石化', brandSub: '智能工厂协同平台', dept: '生产运行部',
  pri: '#0e7490', pri2: '#1595ad', priDark: '#0a5566',
  loginLead: '计划调度协同 · 生产运行管理 · HSE 现场管理<br>炼化一体化智能工厂协同平台',
  version: 'v5.2 企业版',
  menu: [
    { g: '计划调度协同', items: [['/order/list', '生产指令审批', 'order'], ['/order/new', '生产指令下发', 'orderNew']] },
    { g: 'HSE 现场管理', items: [['/hazard/new', '隐患排查录入', 'hazardNew'], ['/hazard/list', '隐患台账', 'hazard']] },
    { g: '生产运行监控', items: [['/monitor/units', '装置运行监控', 'units'], ['/monitor/alarms', '报警管理', 'alarms']] },
    { g: '统计报表', items: [['#', '平稳率报表', ''], ['#', '能耗看板', '']] },
  ],
})

const STATE_CN = { pending: '待审批', approved: '已批准', rejected: '已退回' }
const LEVEL_CN = { high: '重大', mid: '一般', low: '轻微' }

const seedDb = () => ({
  // 生产指令：领导审批的对象（对应客户表 27「生产指令下发、审批」）
  orders: [
    { id: 'SCZL-2026-0181', title: '常减压装置提负荷至 96%', unit: '常减压装置', issuer: '赵工', dept: '生产运行部', urgency: '加急', effectAt: '2026-07-14 08:00', basis: '按七月炼油计划，汽油产量缺口 3200 吨，需提负荷补产。', state: 'pending', opinion: '' },
    { id: 'SCZL-2026-0182', title: '催化裂化装置反应温度下调 2℃', unit: '催化裂化装置', issuer: '孙工', dept: '工艺技术部', urgency: '普通', effectAt: '2026-07-14 14:00', basis: '近三日焦炭产率偏高 0.6 个百分点，按工艺卡片下调反应温度。', state: 'pending', opinion: '' },
    { id: 'SCZL-2026-0183', title: '延迟焦化装置切塔操作变动', unit: '延迟焦化装置', issuer: '周工', dept: '生产运行部', urgency: '加急', effectAt: '2026-07-15 06:00', basis: '一号焦炭塔达到生焦周期，按操作规程执行切塔。', state: 'pending', opinion: '' },
    { id: 'SCZL-2026-0179', title: '重整装置氢气外送量调整', unit: '连续重整装置', issuer: '李工', dept: '生产运行部', urgency: '普通', effectAt: '2026-07-11 08:00', basis: '下游加氢裂化装置检修，减少氢气外送。', state: 'approved', opinion: '同意，按计划执行。' },
  ],
  // 隐患：普通员工现场录入的对象（对应客户表 41「隐患排查」）
  hazards: [
    { id: 'YH-2026-0473', unit: '常减压装置', place: '初馏塔顶回流泵区', desc: 'P-101B 泵机械密封轻微渗漏，地面有油迹。', level: 'mid', reporter: '陈师傅', foundAt: '2026-07-11', state: '整改中' },
    { id: 'YH-2026-0471', unit: '罐区', place: '5#原油罐north侧', desc: '消防泡沫管线保温层破损。', level: 'low', reporter: '王师傅', foundAt: '2026-07-10', state: '已验证' },
  ],
  // 装置运行数据：查询/监控类（对应客户表 31/32/34/64）
  units: [
    { name: '常减压装置', load: 92.4, stable: 98.7, energy: 8.62, alarms: 3, status: '运行' },
    { name: '催化裂化装置', load: 88.1, stable: 96.2, energy: 12.35, alarms: 7, status: '运行' },
    { name: '连续重整装置', load: 95.6, stable: 99.1, energy: 10.08, alarms: 1, status: '运行' },
    { name: '延迟焦化装置', load: 78.3, stable: 93.4, energy: 15.77, alarms: 11, status: '运行' },
    { name: '加氢裂化装置', load: 0, stable: 0, energy: 0, alarms: 0, status: '检修' },
    { name: '硫磺回收装置', load: 84.9, stable: 97.5, energy: 6.41, alarms: 2, status: '运行' },
  ],
  alarms: [
    { at: '2026-07-13 02:14', unit: '延迟焦化装置', tag: 'TI-2043', desc: '焦炭塔顶温度高高报', level: '高', ack: false },
    { at: '2026-07-13 01:52', unit: '催化裂化装置', tag: 'PI-1187', desc: '再生器压力波动超限', level: '高', ack: false },
    { at: '2026-07-13 01:30', unit: '延迟焦化装置', tag: 'FI-2210', desc: '急冷油流量低报', level: '中', ack: true },
    { at: '2026-07-12 23:41', unit: '常减压装置', tag: 'LI-1002', desc: '初馏塔液位高报', level: '中', ack: true },
    { at: '2026-07-12 22:07', unit: '硫磺回收装置', tag: 'AI-3301', desc: '尾气 SO2 浓度接近限值', level: '中', ack: true },
  ],
})
let db = seedDb()

mountAuth(app)
mountDemoReset(app, () => { db = seedDb() })

// ── 首页：待办 ──────────────────────────────────────────────
// 路径必须是 /portal：makeHelpers 的 mountAuth 默认首页就是 /portal，且它自己注册了 '/' → 重定向到 /portal。
// 写成 '/' 会被 mountAuth 的 '/' 抢先，而 /portal 不存在 → 登录后直接 Cannot GET /portal。
app.get('/portal', requireAuth, (req, res) => {
  const pend = db.orders.filter(o => o.state === 'pending')
  const unack = db.alarms.filter(a => !a.ack)
  res.send(layout(req, '', '工作台', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>我的待办</div><div class="panel-b" style="padding:0"><table>
      <tr><th>类型</th><th>事项</th><th>发起人</th><th>生效时间</th><th>状态</th></tr>
      ${pend.map(o => `<tr><td>生产指令审批</td><td><a class="lnk" href="/order/${o.id}">${o.title}</a></td><td>${o.issuer}</td><td>${o.effectAt}</td><td><span class="tag t-pending">待审批</span></td></tr>`).join('')}
    </table></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>未确认报警 <span class="muted" style="font-weight:400">共 ${unack.length} 条</span></div><div class="panel-b" style="padding:0"><table>
      <tr><th>时间</th><th>装置</th><th>位号</th><th>描述</th><th>级别</th></tr>
      ${unack.map(a => `<tr><td>${a.at}</td><td>${a.unit}</td><td>${a.tag}</td><td>${a.desc}</td><td>${a.level}</td></tr>`).join('')}
    </table></div></div>`))
})

// ── ① 生产指令审批（领导）────────────────────────────────────
app.get('/order/list', requireAuth, (req, res) => {
  const rows = db.orders.map(o => `<tr>
    <td>${o.id}</td><td><a class="lnk" href="/order/${o.id}">${o.title}</a></td><td>${o.unit}</td>
    <td>${o.issuer} · ${o.dept}</td><td>${o.urgency === '加急' ? '<span class="tag t-urg">加急</span>' : '普通'}</td>
    <td>${o.effectAt}</td><td><span class="tag t-${o.state}">${STATE_CN[o.state]}</span></td></tr>`).join('')
  res.send(layout(req, 'order', '计划调度协同 / <b>生产指令审批</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>生产指令 · 待审批列表<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.orders.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>指令编号</th><th>指令内容</th><th>所属装置</th><th>下发人</th><th>紧急程度</th><th>生效时间</th><th>状态</th></tr>${rows}</table></div></div>`))
})

app.get('/order/:id', requireAuth, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id)
  if (!o) return res.status(404).send(layout(req, 'order', '生产指令审批', '<div class="panel"><div class="panel-b">指令不存在</div></div>'))
  const done = o.state !== 'pending'
  const ok = req.query.ok ? `<div class="ok">✅ 审批操作已提交：该指令当前状态为「${STATE_CN[o.state]}」</div>` : ''
  res.send(layout(req, 'order', `计划调度协同 / 生产指令审批 / <b>${o.id}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>生产指令详情</div><div class="panel-b">
      <div class="kv">
        <div class="k">指令编号</div><div id="orderNo">${o.id}</div><div class="k">紧急程度</div><div>${o.urgency}</div>
        <div class="k">指令内容</div><div id="title" class="full">${o.title}</div>
        <div class="k">所属装置</div><div id="unit">${o.unit}</div><div class="k">生效时间</div><div>${o.effectAt}</div>
        <div class="k">下发人</div><div>${o.issuer}</div><div class="k">下发部门</div><div>${o.dept}</div>
        <div class="k">下达依据</div><div class="full">${o.basis}</div>
        <div class="k">当前状态</div><div><span class="tag t-${o.state}">${STATE_CN[o.state]}</span></div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>审批操作</div><div class="panel-b">
      ${done ? `<div class="muted">该指令已办结，审批意见：${o.opinion || '（无）'}</div>` : `
      <form class="f" method="post" action="/order/${o.id}/approve">
        <label for="opinion">审批意见</label><textarea id="opinion" name="opinion" placeholder="请输入审批意见（可选）"></textarea>
        <div class="acts">
          <button id="approveBtn" class="btn" type="submit">批准</button>
          <button id="rejectBtn" class="btn plain" type="submit" formaction="/order/${o.id}/reject">退回</button>
        </div></form>`}
    </div></div>`))
})
app.post('/order/:id/approve', requireAuth, (req, res) => { const o = db.orders.find(x => x.id === req.params.id); if (o) { o.state = 'approved'; o.opinion = (req.body.opinion || '同意').trim() } res.redirect(`/order/${req.params.id}?ok=1`) })
app.post('/order/:id/reject', requireAuth, (req, res) => { const o = db.orders.find(x => x.id === req.params.id); if (o) { o.state = 'rejected'; o.opinion = (req.body.opinion || '退回').trim() } res.redirect(`/order/${req.params.id}?ok=1`) })

app.get('/order/new', requireAuth, (req, res) => {
  res.send(layout(req, 'orderNew', '计划调度协同 / <b>生产指令下发</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>新建生产指令</div><div class="panel-b">
      <form class="f" method="post" action="/order">
        <div class="grid2">
          <div><label for="title">指令内容</label><input id="title" name="title" placeholder="如 常减压装置提负荷至 96%"></div>
          <div><label for="unit">所属装置</label><input id="unit" name="unit" placeholder="如 常减压装置"></div>
          <div><label for="urgency">紧急程度</label><select id="urgency" name="urgency"><option>普通</option><option>加急</option></select></div>
          <div><label for="effectAt">生效时间</label><input id="effectAt" name="effectAt" type="datetime-local"></div>
        </div>
        <label for="basis">下达依据</label><textarea id="basis" name="basis" placeholder="下达该指令的工艺/计划依据"></textarea>
        <div class="acts"><button id="submitBtn" class="btn" type="submit">提交审批</button></div>
      </form></div></div>`))
})
app.post('/order', requireAuth, (req, res) => {
  const b = req.body
  const id = 'SCZL-2026-' + String(184 + db.orders.length).padStart(4, '0')
  db.orders.unshift({ id, title: b.title || '', unit: b.unit || '', issuer: require('./lib/common').parseCookie(req)['hxplant_user'] || '', dept: '生产运行部', urgency: b.urgency || '普通', effectAt: (b.effectAt || '').replace('T', ' '), basis: b.basis || '', state: 'pending', opinion: '' })
  res.redirect('/order/list')
})

// ── ② 隐患排查录入（普通员工）────────────────────────────────
app.get('/hazard/new', requireAuth, (req, res) => {
  res.send(layout(req, 'hazardNew', 'HSE 现场管理 / <b>隐患排查录入</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>新增隐患</div><div class="panel-b">
      <form class="f" method="post" action="/hazard">
        <div class="grid2">
          <div><label for="unit">所属装置</label><input id="unit" name="unit" placeholder="如 常减压装置"></div>
          <div><label for="place">具体部位</label><input id="place" name="place" placeholder="如 初馏塔顶回流泵区"></div>
          <div><label for="level">隐患等级</label><select id="level" name="level"><option value="low">轻微</option><option value="mid">一般</option><option value="high">重大</option></select></div>
          <div><label for="foundAt">发现日期</label><input id="foundAt" name="foundAt" type="date"></div>
        </div>
        <label for="desc">隐患描述</label><textarea id="desc" name="desc" placeholder="描述隐患现象、位号、可能后果"></textarea>
        <div class="acts"><button id="submitBtn" class="btn" type="submit">提交隐患</button></div>
      </form></div></div>`))
})
app.post('/hazard', requireAuth, (req, res) => {
  const b = req.body
  const id = 'YH-2026-' + String(474 + db.hazards.length).padStart(4, '0')
  db.hazards.unshift({ id, unit: b.unit || '', place: b.place || '', desc: b.desc || '', level: b.level || 'low', reporter: require('./lib/common').parseCookie(req)['hxplant_user'] || '', foundAt: b.foundAt || '', state: '待评估' })
  res.redirect('/hazard/list')
})
app.get('/hazard/list', requireAuth, (req, res) => {
  const rows = db.hazards.map(h => `<tr>
    <td>${h.id}</td><td>${h.unit}</td><td>${h.place}</td><td>${h.desc}</td>
    <td>${LEVEL_CN[h.level] || h.level}</td><td>${h.reporter}</td><td>${h.foundAt}</td><td>${h.state}</td></tr>`).join('')
  res.send(layout(req, 'hazard', 'HSE 现场管理 / <b>隐患台账</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>隐患台账<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.hazards.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>隐患编号</th><th>所属装置</th><th>具体部位</th><th>隐患描述</th><th>等级</th><th>上报人</th><th>发现日期</th><th>状态</th></tr>${rows}</table></div></div>`))
})

// ── ③ 生产数据监控（专业技术人员）────────────────────────────
app.get('/monitor/units', requireAuth, (req, res) => {
  const rows = db.units.map(u => `<tr>
    <td>${u.name}</td><td class="right">${u.load.toFixed(1)}%</td><td class="right">${u.stable.toFixed(1)}%</td>
    <td class="right">${u.energy.toFixed(2)}</td><td class="right">${u.alarms}</td><td>${u.status}</td></tr>`).join('')
  res.send(layout(req, 'units', '生产运行监控 / <b>装置运行监控</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>全厂装置运行数据<span class="muted" style="font-weight:400;margin-left:8px">数据截止 2026-07-13 03:00</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>装置名称</th><th class="right">负荷率</th><th class="right">平稳率</th><th class="right">综合能耗(kgEO/t)</th><th class="right">报警数</th><th>运行状态</th></tr>${rows}</table></div></div>`))
})
app.get('/monitor/alarms', requireAuth, (req, res) => {
  const rows = db.alarms.map(a => `<tr>
    <td>${a.at}</td><td>${a.unit}</td><td>${a.tag}</td><td>${a.desc}</td><td>${a.level}</td><td>${a.ack ? '已确认' : '<span class="tag t-pending">未确认</span>'}</td></tr>`).join('')
  res.send(layout(req, 'alarms', '生产运行监控 / <b>报警管理</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>报警记录<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.alarms.length} 条</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>时间</th><th>装置</th><th>位号</th><th>报警描述</th><th>级别</th><th>确认状态</th></tr>${rows}</table></div></div>`))
})

app.get('/api/state', requireAuth, (req, res) => res.json({ orders: db.orders, hazards: db.hazards, units: db.units, alarms: db.alarms }))

app.listen(PORT, () => console.log(`[iml-mock-plant] 长庆石化 · 智能工厂协同平台 (Mock) → http://localhost:${PORT}  （登录任意账号密码）`))
