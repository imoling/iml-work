// 华信数字 · 企业资源管理系统 ERM（Mock）—— 供应链（供应商/零件物料/采购）+ 生产（排产/工单/产线）。
// 对象关系完整可读，供本体建模演示：供应商 --供货--> 零件 --BOM--> 产品(工单) --排产--> 产线。
// 核心演示场景：零件「断供/缺口」→ 供应风险分析推导受影响工单 → 给出补货（建采购单→收货回补库存）或改排建议。
// 数据在内存、规则确定性推导（非编造），重启复位。仅演示。
const express = require('express')
const { money, makeHelpers } = require('./lib/common')
const app = express()
const PORT = process.env.MOCK_ERM_PORT || 8092

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const { requireAuth, layout, mountAuth, mountDemoReset } = makeHelpers({
  cookieName: 'hxerm_user',
  brand: '华信数字', brandSub: '企业资源管理系统 (ERM)', dept: '生产计划部',
  pri: '#b45309', pri2: '#c96a12', priDark: '#8f4407',
  loginLead: '供应链管理 · 排产管理 · 生产协同<br>制造企业一体化资源计划平台',
  version: 'v3.6 企业版',
  menu: [
    { g: '供应链管理', items: [['/scm/suppliers', '供应商档案', 'suppliers'], ['/scm/parts', '零件物料', 'parts'], ['/scm/purchase', '采购订单', 'po'], ['/scm/impact', '供应风险分析', 'impact']] },
    { g: '生产制造', items: [['/mes/schedule', '排产管理', 'schedule'], ['/mes/orders', '生产工单', 'wo'], ['/mes/lines', '产线档案', 'lines']] },
    { g: '统计报表', items: [['#', '产能看板', ''], ['#', '库存报表', '']] },
  ],
})

// ---- 内存数据 ----
// 供应商（who 供货）
const seedDb = () => ({
  suppliers: [
    { id: 'GYS001', name: '安徽精工机械有限公司', category: '机加工件', level: 'A', contact: '钱国强', phone: '0551-63****88' },
    { id: 'GYS002', name: '苏州汇成电子科技', category: '电子元件', level: 'A', contact: '吴晓丽', phone: '0512-68****21' },
    { id: 'GYS003', name: '山东恒力钢材集团', category: '原材料·钢材', level: 'B', contact: '刘振', phone: '0531-82****53' },
    { id: 'GYS004', name: '深圳兆芯电子有限公司', category: '电子元件', level: 'B', contact: '黄志明', phone: '0755-26****19' },
    { id: 'GYS005', name: '河北普阳钢铁贸易', category: '原材料·钢材', level: 'B', contact: '宋建华', phone: '0310-57****42' },
    { id: 'GYS006', name: '武汉光谷传感科技', category: '光电模组', level: 'A', contact: '陈雪', phone: '027-87****65' },
  ],
  // 零件/物料（supply: normal 正常 / cut 断供；primary/backup 供应商 + 参考交期天数）
  parts: [
    { id: 'PN-2001', name: '高精度齿轮箱体', spec: 'GJX-2001/铸铝', unit: '件', stock: 100, safety: 40, supply: 'normal', primary: 'GYS001', primaryLead: 12, backup: '', backupLead: 0 },
    { id: 'PN-3005', name: '工业控制器主板', spec: 'ICB-3005/四核', unit: '片', stock: 260, safety: 100, supply: 'normal', primary: 'GYS002', primaryLead: 10, backup: 'GYS004', backupLead: 7 },
    { id: 'PN-1010', name: '机柜钢板套件', spec: 'Q235B/整机套', unit: '套', stock: 45, safety: 20, supply: 'normal', primary: 'GYS003', primaryLead: 15, backup: 'GYS005', backupLead: 9 },
    { id: 'PN-4002', name: '激光雷达模组', spec: 'LR-4002/16线', unit: '只', stock: 30, safety: 50, supply: 'normal', primary: 'GYS006', primaryLead: 20, backup: '', backupLead: 0 },
  ],
  // BOM：产品 → 用到的零件与单台用量（工单经产品关联零件）
  bom: {
    '智能巡检机器人 A2': [{ part: 'PN-2001', qtyPer: 2 }, { part: 'PN-4002', qtyPer: 1 }],
    '产线视觉质检一体机': [{ part: 'PN-3005', qtyPer: 1 }, { part: 'PN-4002', qtyPer: 2 }],
    '管道监测传感终端': [{ part: 'PN-3005', qtyPer: 1 }],
    '调度平台专用服务器': [{ part: 'PN-3005', qtyPer: 1 }, { part: 'PN-1010', qtyPer: 1 }],
  },
  purchases: [
    { id: 'PO-2026-0112', supplier: '山东恒力钢材集团', item: 'Q235B 机柜钢板套件 200 套', partId: 'PN-1010', qty: 200, amount: 860000, applicant: '赵工', needBy: '2026-07-20', state: 'pending', note: '' },
    { id: 'PO-2026-0115', supplier: '苏州汇成电子科技', item: '工业控制器主板 500 片', partId: 'PN-3005', qty: 500, amount: 425000, applicant: '孙工', needBy: '2026-07-25', state: 'pending', note: '' },
    { id: 'PO-2026-0108', supplier: '安徽精工机械有限公司', item: '高精度齿轮箱体 120 件', partId: 'PN-2001', qty: 120, amount: 336000, applicant: '赵工', needBy: '2026-07-12', state: 'confirmed', note: '已确认排期' },
  ],
  workorders: [
    { id: 'WO-2026-0301', product: '智能巡检机器人 A2', qty: 40, line: '', planStart: '', planEnd: '', state: 'unscheduled', priority: '高' },
    { id: 'WO-2026-0302', product: '产线视觉质检一体机', qty: 25, line: '', planStart: '', planEnd: '', state: 'unscheduled', priority: '中' },
    { id: 'WO-2026-0298', product: '管道监测传感终端', qty: 300, line: '二号产线', planStart: '2026-07-06', planEnd: '2026-07-15', state: 'scheduled', priority: '高' },
    { id: 'WO-2026-0295', product: '调度平台专用服务器', qty: 60, line: '三号产线', planStart: '2026-06-28', planEnd: '2026-07-08', state: 'producing', priority: '中' },
  ],
  seq: 20,
})
// 内存数据实例；复位=用种子整体覆盖（对象引用不变，闭包安全）
const db = seedDb()
const resetDb = () => { Object.keys(db).forEach(k => delete db[k]); Object.assign(db, seedDb()) }
const PO_CN = { pending: '待确认', confirmed: '已确认', received: '已收货' }
const WO_CN = { unscheduled: '待排产', scheduled: '已排产', producing: '生产中', done: '已完工' }
const LINES = ['一号产线', '二号产线', '三号产线', '四号产线']
const poTag = s => `<span class="tag ${s === 'pending' ? 't-pending' : s === 'confirmed' ? 't-stage' : 't-approved'}">${PO_CN[s]}</span>`
const woTag = s => `<span class="tag ${s === 'unscheduled' ? 't-pending' : s === 'scheduled' ? 't-stage' : s === 'producing' ? 't-urg' : 't-approved'}" style="margin-left:0">${WO_CN[s]}</span>`
const supTag = s => s === 'cut' ? '<span class="tag t-rejected">断供</span>' : '<span class="tag t-approved">正常</span>'
const supName = id => (db.suppliers.find(s => s.id === id) || {}).name || '—'

// ===== 供应风险分析（确定性推导，非编造） =====
// 对某零件：汇总在制/待产工单需求 → 按（生产中 > 已排产按开工日 > 待排产）顺序分配现有库存 →
// 分配不足的工单即「受影响」；结合主/备供应商与断供状态给出补货/改排建议。
function analyzePart(part) {
  const users = Object.entries(db.bom).filter(([, items]) => items.some(i => i.part === part.id))
  const active = db.workorders.filter(w => w.state !== 'done' && db.bom[w.product] && db.bom[w.product].some(i => i.part === part.id))
  const rank = w => w.state === 'producing' ? 0 : w.state === 'scheduled' ? 1 : 2
  const sorted = [...active].sort((a, b) => rank(a) - rank(b) || String(a.planStart || '9999').localeCompare(String(b.planStart || '9999')))
  let remain = part.stock
  const rows = sorted.map(w => {
    const qtyPer = db.bom[w.product].find(i => i.part === part.id).qtyPer
    const need = w.qty * qtyPer
    const alloc = Math.max(0, Math.min(remain, need)); remain -= alloc
    return { wo: w, need, alloc, short: need - alloc }
  })
  const totalNeed = rows.reduce((s, r) => s + r.need, 0)
  const gap = Math.max(0, totalNeed - part.stock)
  const affected = rows.filter(r => r.short > 0)
  const inbound = db.purchases.filter(p => p.partId === part.id && p.state !== 'received').reduce((s, p) => s + (p.qty || 0), 0)
  const risky = part.supply === 'cut' || gap > 0 || part.stock < part.safety

  // 建议（规则推导）
  const advise = []
  if (part.supply === 'cut' || gap > 0) {
    const buyQty = gap + part.safety
    if (part.supply !== 'cut' && part.primary) advise.push(`补货：向主供「${supName(part.primary)}」采购 ${buyQty} ${part.unit}（缺口 ${gap} + 安全库存 ${part.safety}），参考交期 ${part.primaryLead} 天`)
    if (part.backup) advise.push(`${part.supply === 'cut' ? '补货（主供断供）' : '备选补货'}：向备选「${supName(part.backup)}」采购 ${buyQty} ${part.unit}，参考交期 ${part.backupLead} 天`)
    if (part.supply === 'cut' && !part.backup) advise.push('⚠️ 主供断供且无备选供应商：建议紧急寻源新供应商，或工程评估替代料')
    affected.forEach(r => {
      if (r.wo.state === 'producing') advise.push(`改排：工单 ${r.wo.id}（生产中）缺 ${r.short} ${part.unit}——建议与采购确认到货优先保障，必要时降速生产`)
      else if (r.wo.state === 'scheduled') advise.push(`改排：工单 ${r.wo.id} 计划 ${r.wo.planStart} 开工、缺 ${r.short} ${part.unit}——建议顺延至补货到货后，或与 ${r.wo.line} 上其它工单对调`)
      else advise.push(`改排：工单 ${r.wo.id}（待排产）缺 ${r.short} ${part.unit}——建议暂缓排产，待补货到货后再排`)
    })
    if (inbound > 0) advise.push(`在途提示：已有未收货采购在途 ${inbound} ${part.unit}，收货后缺口将相应减少`)
  } else if (part.stock < part.safety) {
    advise.push(`库存 ${part.stock} 低于安全库存 ${part.safety}：建议补货 ${part.safety - part.stock + part.safety} ${part.unit}`)
  }
  return { users, rows, totalNeed, gap, affected, inbound, risky, advise }
}

mountAuth(app, '/mes/schedule')
mountDemoReset(app, resetDb, '/mes/schedule')

// ================= 供应商 =================
app.get('/scm/suppliers', requireAuth, (req, res) => {
  const rows = db.suppliers.map(s => {
    const supplied = db.parts.filter(p => p.primary === s.id || p.backup === s.id).map(p => p.name).join('、') || '—'
    return `<tr><td>${s.id}</td><td><a class="lnk" href="/scm/supplier/${s.id}">${s.name}</a></td><td>${s.category}</td><td>${s.level}</td><td>${supplied}</td><td>${s.contact}</td></tr>`
  }).join('')
  res.send(layout(req, 'suppliers', '供应链管理 / <b>供应商档案</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>供应商档案</div><div class="panel-b" style="padding:0">
    <table><tr><th>编号</th><th>供应商名称</th><th>供货品类</th><th>等级</th><th>供货零件</th><th>联系人</th></tr>${rows}</table></div></div>`))
})
app.get('/scm/supplier/:id', requireAuth, (req, res) => {
  const s = db.suppliers.find(x => x.id === req.params.id)
  if (!s) return res.status(404).send(layout(req, 'suppliers', '供应商', '<div class="panel"><div class="panel-b">供应商不存在</div></div>'))
  const partRows = db.parts.filter(p => p.primary === s.id || p.backup === s.id).map(p =>
    `<tr><td><a class="lnk" href="/scm/part/${p.id}">${p.id}</a></td><td>${p.name}</td><td>${p.primary === s.id ? '主供' : '备选'}</td><td>${p.primary === s.id ? p.primaryLead : p.backupLead} 天</td><td>${supTag(p.supply)}</td></tr>`).join('')
  const poRows = db.purchases.filter(p => p.supplier === s.name).map(p =>
    `<tr><td><a class="lnk" href="/scm/purchase/${p.id}">${p.id}</a></td><td>${p.item}</td><td class="right">${money(p.amount)}</td><td>${poTag(p.state)}</td></tr>`).join('')
  res.send(layout(req, 'suppliers', `供应链管理 / 供应商档案 / <b>${s.name}</b>`, `
    <div class="panel"><div class="panel-h"><span class="bar"></span>供应商信息</div><div class="panel-b">
      <div class="kv"><div class="k">编号</div><div>${s.id}</div><div class="k">等级</div><div>${s.level}</div>
      <div class="k">品类</div><div>${s.category}</div><div class="k">联系人</div><div>${s.contact} · ${s.phone}</div></div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>供货零件</div><div class="panel-b" style="padding:0">
      <table><tr><th>零件号</th><th>名称</th><th>角色</th><th>参考交期</th><th>供货状态</th></tr>${partRows || '<tr><td colspan="5" class="muted" style="padding:14px">暂无供货零件</td></tr>'}</table></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>相关采购单</div><div class="panel-b" style="padding:0">
      <table><tr><th>订单号</th><th>内容</th><th class="right">金额</th><th>状态</th></tr>${poRows || '<tr><td colspan="4" class="muted" style="padding:14px">暂无采购单</td></tr>'}</table></div></div>`))
})

// ================= 零件物料 =================
app.get('/scm/parts', requireAuth, (req, res) => {
  const rows = db.parts.map(p => {
    const a = analyzePart(p)
    return `<tr><td><a class="lnk" href="/scm/part/${p.id}">${p.id}</a></td><td>${p.name}</td><td>${p.stock} ${p.unit}</td><td>${p.safety} ${p.unit}</td>
      <td>${supName(p.primary)}</td><td>${p.backup ? supName(p.backup) : '—'}</td><td>${supTag(p.supply)}</td>
      <td>${a.risky ? `<span class="tag t-rejected">缺口 ${a.gap || '低库存'}</span>` : '<span class="tag t-approved">充足</span>'}</td></tr>`
  }).join('')
  res.send(layout(req, 'parts', '供应链管理 / <b>零件物料</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>零件物料台账<span class="muted" style="font-weight:400;margin-left:8px">库存按（生产中→已排产→待排产）顺序分配</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>零件号</th><th>名称</th><th>库存</th><th>安全库存</th><th>主供应商</th><th>备选供应商</th><th>供货状态</th><th>供需</th></tr>${rows}</table></div></div>`))
})
app.get('/scm/part/:id', requireAuth, (req, res) => {
  const p = db.parts.find(x => x.id === req.params.id)
  if (!p) return res.status(404).send(layout(req, 'parts', '零件', '<div class="panel"><div class="panel-b">零件不存在</div></div>'))
  const a = analyzePart(p)
  const ok = req.query.ok ? `<div class="ok">✅ ${decodeURIComponent(req.query.ok)}</div>` : ''
  const usedRows = a.users.map(([prod, items]) => `<tr><td>${prod}</td><td>${items.find(i => i.part === p.id).qtyPer} ${p.unit}/台</td></tr>`).join('')
  const woRows = a.rows.map(r => `<tr><td><a class="lnk" href="/mes/order/${r.wo.id}">${r.wo.id}</a></td><td>${r.wo.product}</td><td>${woTag(r.wo.state)}</td>
    <td class="right">${r.need}</td><td class="right">${r.alloc}</td><td class="right">${r.short > 0 ? `<b style="color:#cf1322">${r.short}</b>` : '0'}</td></tr>`).join('')
  const adviseHtml = a.advise.length ? `<ul style="margin:0;padding-left:18px;line-height:2">${a.advise.map(x => `<li>${x}</li>`).join('')}</ul>` : '<div class="muted">供需正常，暂无建议。</div>'
  const buyQty = a.gap + p.safety
  const supplierOpts = [p.primary && p.supply !== 'cut' ? `<option value="${p.primary}">主供 · ${supName(p.primary)}（${p.primaryLead}天）</option>` : '', p.backup ? `<option value="${p.backup}">备选 · ${supName(p.backup)}（${p.backupLead}天）</option>` : ''].join('')
  res.send(layout(req, 'parts', `供应链管理 / 零件物料 / <b>${p.name}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>零件信息</div><div class="panel-b">
      <div class="kv">
        <div class="k">零件号</div><div id="partNo">${p.id}</div><div class="k">规格</div><div>${p.spec}</div>
        <div class="k">库存</div><div id="stock">${p.stock} ${p.unit}</div><div class="k">安全库存</div><div>${p.safety} ${p.unit}</div>
        <div class="k">主供应商</div><div>${supName(p.primary)}（交期 ${p.primaryLead} 天）</div><div class="k">备选供应商</div><div>${p.backup ? `${supName(p.backup)}（交期 ${p.backupLead} 天）` : '—'}</div>
        <div class="k">供货状态</div><div>${supTag(p.supply)}</div><div class="k">采购在途</div><div>${a.inbound} ${p.unit}</div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>用于产品（BOM）</div><div class="panel-b" style="padding:0">
      <table><tr><th>产品</th><th>单台用量</th></tr>${usedRows || '<tr><td colspan="2" class="muted" style="padding:14px">未用于任何产品</td></tr>'}</table></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>供需与受影响工单<span class="muted" style="font-weight:400;margin-left:8px">总需求 ${a.totalNeed} · 库存 ${p.stock} · 缺口 <b style="color:${a.gap ? '#cf1322' : '#389e0d'}">${a.gap}</b></span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>工单</th><th>产品</th><th>状态</th><th class="right">需求</th><th class="right">可分配</th><th class="right">缺口</th></tr>${woRows || '<tr><td colspan="6" class="muted" style="padding:14px">暂无在制/待产工单使用该零件</td></tr>'}</table></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>处置建议</div><div class="panel-b">${adviseHtml}</div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>零件操作</div><div class="panel-b">
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <form class="f" method="post" action="/scm/part/${p.id}/${p.supply === 'cut' ? 'restore' : 'cut'}">
          <div class="acts" style="margin-top:0"><button id="${p.supply === 'cut' ? 'restoreBtn' : 'cutBtn'}" class="btn ${p.supply === 'cut' ? '' : 'plain'}" type="submit">${p.supply === 'cut' ? '恢复供应' : '标记断供'}</button></div>
        </form>
        ${supplierOpts ? `<form class="f" method="post" action="/scm/part/${p.id}/replenish" style="display:flex;gap:10px;align-items:flex-end">
          <div><label for="supplier">补货供应商</label><select id="supplier" name="supplier" style="min-width:230px">${supplierOpts}</select></div>
          <div><label for="qty">数量(${p.unit})</label><input id="qty" name="qty" value="${buyQty > 0 ? buyQty : p.safety}" style="width:110px"></div>
          <div class="acts" style="margin-top:0"><button id="replenishBtn" class="btn" type="submit">发起补货采购</button></div>
        </form>` : ''}
      </div></div></div>`))
})
app.post('/scm/part/:id/cut', requireAuth, (req, res) => { const p = db.parts.find(x => x.id === req.params.id); if (p) p.supply = 'cut'; res.redirect(`/scm/part/${req.params.id}?ok=${encodeURIComponent('已标记断供，请查看受影响工单与处置建议')}`) })
app.post('/scm/part/:id/restore', requireAuth, (req, res) => { const p = db.parts.find(x => x.id === req.params.id); if (p) p.supply = 'normal'; res.redirect(`/scm/part/${req.params.id}?ok=${encodeURIComponent('已恢复供应')}`) })
app.post('/scm/part/:id/replenish', requireAuth, (req, res) => {
  const p = db.parts.find(x => x.id === req.params.id)
  if (!p) return res.redirect('/scm/parts')
  const qty = Math.max(1, Number(req.body.qty) || 0)
  const sup = db.suppliers.find(s => s.id === req.body.supplier) || db.suppliers.find(s => s.id === p.backup) || db.suppliers.find(s => s.id === p.primary)
  const id = 'PO-2026-' + String(db.seq++).padStart(4, '0')
  db.purchases.unshift({ id, supplier: sup ? sup.name : '—', item: `${p.name} ${qty} ${p.unit}（补货）`, partId: p.id, qty, amount: 0, applicant: '系统补货', needBy: '', state: 'pending', note: '供应风险补货' })
  res.redirect(`/scm/purchase/${id}?ok=1`)
})

// ================= 供应风险分析（全局看板） =================
app.get('/scm/impact', requireAuth, (req, res) => {
  const risky = db.parts.map(p => ({ p, a: analyzePart(p) })).filter(x => x.a.risky)
  const blocks = risky.length ? risky.map(({ p, a }) => `
    <div class="panel"><div class="panel-h"><span class="bar"></span>
      <a class="lnk" href="/scm/part/${p.id}">${p.id} ${p.name}</a>
      <span style="margin-left:8px">${supTag(p.supply)}</span>
      <span class="muted" style="font-weight:400;margin-left:8px">库存 ${p.stock}/${p.safety} · 总需求 ${a.totalNeed} · 缺口 <b style="color:#cf1322">${a.gap}</b> · 在途 ${a.inbound}</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>受影响工单</th><th>产品</th><th>状态</th><th>产线</th><th class="right">缺口(${p.unit})</th></tr>
      ${a.affected.map(r => `<tr><td><a class="lnk" href="/mes/order/${r.wo.id}">${r.wo.id}</a></td><td>${r.wo.product}</td><td>${woTag(r.wo.state)}</td><td>${r.wo.line || '—'}</td><td class="right"><b style="color:#cf1322">${r.short}</b></td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:12px">库存暂可覆盖全部工单（低于安全库存预警）</td></tr>'}
    </table></div>
    <div class="panel-b" style="border-top:1px solid var(--bd)"><b style="font-size:12.5px">处置建议</b>
      <ul style="margin:6px 0 0;padding-left:18px;line-height:2">${a.advise.map(x => `<li>${x}</li>`).join('')}</ul></div></div>`).join('')
    : '<div class="panel"><div class="panel-b muted">当前无供应风险：所有零件供货正常、库存可覆盖在制与待产工单。</div></div>'
  res.send(layout(req, 'impact', '供应链管理 / <b>供应风险分析</b>', `
    <div class="stat">
      <div class="c"><div class="n">${risky.length}</div><div class="l">风险零件</div></div>
      <div class="c"><div class="n">${risky.reduce((s, x) => s + x.a.affected.length, 0)}</div><div class="l">受影响工单</div></div>
      <div class="c"><div class="n">${db.parts.filter(x => x.supply === 'cut').length}</div><div class="l">断供零件</div></div>
      <div class="c"><div class="n">${db.purchases.filter(x => x.state !== 'received').length}</div><div class="l">在途采购单</div></div>
    </div>${blocks}`))
})

// ================= 采购订单（收货回补库存 → 补货闭环） =================
app.get('/scm/purchase', requireAuth, (req, res) => {
  const rows = db.purchases.map(p => `<tr>
    <td>${p.id}</td><td><a class="lnk" href="/scm/purchase/${p.id}">${p.item}</a></td><td>${p.supplier}</td>
    <td>${p.partId ? `<a class="lnk" href="/scm/part/${p.partId}">${p.partId}</a>` : '—'}</td>
    <td class="right">${p.amount ? money(p.amount) : '—'}</td><td>${p.needBy || '—'}</td><td>${poTag(p.state)}</td></tr>`).join('')
  res.send(layout(req, 'po', '供应链管理 / <b>采购订单</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>采购订单<span class="muted" style="font-weight:400;margin-left:8px">共 ${db.purchases.length} 单 · 状态流：待确认 → 已确认 → 已收货（收货自动回补零件库存）</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>订单编号</th><th>采购内容</th><th>供应商</th><th>关联零件</th><th class="right">金额</th><th>需求日期</th><th>状态</th></tr>${rows}</table></div></div>`))
})
app.get('/scm/purchase/:id', requireAuth, (req, res) => {
  const p = db.purchases.find(x => x.id === req.params.id)
  if (!p) return res.status(404).send(layout(req, 'po', '采购订单', '<div class="panel"><div class="panel-b">订单不存在</div></div>'))
  const ok = req.query.ok ? `<div class="ok">✅ 操作已提交：订单当前状态为「${PO_CN[p.state]}」</div>` : ''
  const act = p.state === 'pending'
    ? `<form class="f" method="post" action="/scm/purchase/${p.id}/confirm"><div class="acts"><button id="confirmBtn" class="btn" type="submit">确认下单</button></div></form>`
    : p.state === 'confirmed'
      ? `<form class="f" method="post" action="/scm/purchase/${p.id}/receive"><div class="acts"><button id="receiveBtn" class="btn" type="submit">确认收货</button></div></form>`
      : '<div class="muted">该订单已收货入库，流程结束。</div>'
  res.send(layout(req, 'po', `供应链管理 / 采购订单 / <b>${p.id}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>订单详情</div><div class="panel-b">
      <div class="kv">
        <div class="k">订单编号</div><div id="poNo">${p.id}</div><div class="k">申请人</div><div>${p.applicant}</div>
        <div class="k">采购内容</div><div id="item" class="full">${p.item}</div>
        <div class="k">供应商</div><div id="supplier">${p.supplier}</div><div class="k">金额</div><div id="amount">${p.amount ? money(p.amount) : '—'}</div>
        <div class="k">关联零件</div><div>${p.partId ? `<a class="lnk" href="/scm/part/${p.partId}">${p.partId}</a> × ${p.qty}` : '—'}</div><div class="k">当前状态</div><div>${poTag(p.state)}</div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>订单操作</div><div class="panel-b">${act}</div></div>`))
})
app.post('/scm/purchase/:id/confirm', requireAuth, (req, res) => { const p = db.purchases.find(x => x.id === req.params.id); if (p && p.state === 'pending') p.state = 'confirmed'; res.redirect(`/scm/purchase/${req.params.id}?ok=1`) })
app.post('/scm/purchase/:id/receive', requireAuth, (req, res) => {
  const p = db.purchases.find(x => x.id === req.params.id)
  if (p && p.state === 'confirmed') {
    p.state = 'received'
    const part = db.parts.find(x => x.id === p.partId)
    if (part && p.qty) part.stock += p.qty   // 收货回补库存 → 供应风险随之解除
  }
  res.redirect(`/scm/purchase/${req.params.id}?ok=1`)
})

// ================= 排产管理 =================
app.get('/mes/schedule', requireAuth, (req, res) => {
  const un = db.workorders.filter(w => w.state === 'unscheduled')
  const rows = un.length
    ? un.map(w => `<tr><td>${w.id}</td><td><a class="lnk" href="/mes/order/${w.id}">${w.product}</a></td><td class="right">${w.qty}</td><td>${w.priority}</td><td>${woTag(w.state)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted" style="padding:14px">暂无待排产工单</td></tr>'
  const scheduled = db.workorders.filter(w => w.state !== 'unscheduled').map(w =>
    `<tr><td>${w.id}</td><td>${w.product}</td><td>${w.line}</td><td>${w.planStart} ~ ${w.planEnd}</td><td>${woTag(w.state)}</td></tr>`).join('')
  res.send(layout(req, 'schedule', '生产制造 / <b>排产管理</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>待排产工单<span class="muted" style="font-weight:400;margin-left:8px">点击工单进入排产</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>工单号</th><th>产品</th><th class="right">数量</th><th>优先级</th><th>状态</th></tr>${rows}</table></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>排产计划</div><div class="panel-b" style="padding:0"><table>
      <tr><th>工单号</th><th>产品</th><th>产线</th><th>计划周期</th><th>状态</th></tr>${scheduled || '<tr><td colspan="5" class="muted" style="padding:14px">暂无排产计划</td></tr>'}</table></div></div>`))
})
app.get('/mes/orders', requireAuth, (req, res) => {
  const rows = db.workorders.map(w => `<tr>
    <td>${w.id}</td><td><a class="lnk" href="/mes/order/${w.id}">${w.product}</a></td><td class="right">${w.qty}</td>
    <td>${w.line || '—'}</td><td>${w.planStart ? `${w.planStart} ~ ${w.planEnd}` : '—'}</td><td>${woTag(w.state)}</td></tr>`).join('')
  res.send(layout(req, 'wo', '生产制造 / <b>生产工单</b>', `
    <div class="panel"><div class="panel-h"><span class="bar"></span>生产工单<span class="muted" style="font-weight:400;margin-left:8px">状态流：待排产 → 已排产 → 生产中 → 已完工</span></div>
    <div class="panel-b" style="padding:0"><table>
      <tr><th>工单号</th><th>产品</th><th class="right">数量</th><th>产线</th><th>计划周期</th><th>状态</th></tr>${rows}</table></div></div>`))
})
app.get('/mes/order/:id', requireAuth, (req, res) => {
  const w = db.workorders.find(x => x.id === req.params.id)
  if (!w) return res.status(404).send(layout(req, 'wo', '生产工单', '<div class="panel"><div class="panel-b">工单不存在</div></div>'))
  const ok = req.query.ok ? `<div class="ok">✅ 操作已提交：工单当前状态为「${WO_CN[w.state]}」</div>` : ''
  const lineOpts = LINES.map(l => `<option value="${l}" ${l === w.line ? 'selected' : ''}>${l}</option>`).join('')
  // BOM 用料与风险（工单视角把零件关系反打出来）
  const bomRows = (db.bom[w.product] || []).map(i => {
    const p = db.parts.find(x => x.id === i.part)
    const a = p ? analyzePart(p) : null
    const mine = a ? a.rows.find(r => r.wo.id === w.id) : null
    return `<tr><td><a class="lnk" href="/scm/part/${i.part}">${i.part}</a></td><td>${p ? p.name : i.part}</td><td class="right">${i.qtyPer}</td>
      <td class="right">${w.qty * i.qtyPer}</td><td>${p ? supTag(p.supply) : '—'}</td>
      <td class="right">${mine && mine.short > 0 ? `<b style="color:#cf1322">缺 ${mine.short}</b>` : '<span class="tag t-approved" style="margin-left:0">可满足</span>'}</td></tr>`
  }).join('')
  const act = w.state === 'unscheduled'
    ? `<form class="f" method="post" action="/mes/order/${w.id}/schedule">
        <div class="grid2">
          <div><label for="line">指定产线</label><select id="line" name="line">${lineOpts}</select></div>
          <div><label for="planStart">计划开工</label><input id="planStart" name="planStart" placeholder="如 2026-07-08"></div>
          <div><label for="planEnd">计划完工</label><input id="planEnd" name="planEnd" placeholder="如 2026-07-18"></div>
        </div>
        <div class="acts"><button id="scheduleBtn" class="btn" type="submit">确认排产</button></div></form>`
    : w.state === 'scheduled'
      ? `<div style="display:flex;gap:18px;flex-wrap:wrap">
          <form class="f" method="post" action="/mes/order/${w.id}/start"><div class="acts" style="margin-top:0"><button id="startBtn" class="btn" type="submit">开工</button></div></form>
          <form class="f" method="post" action="/mes/order/${w.id}/reschedule" style="display:flex;gap:10px;align-items:flex-end">
            <div><label for="planStart2">顺延开工至</label><input id="planStart2" name="planStart" placeholder="如 2026-07-20" style="width:140px"></div>
            <div><label for="planEnd2">完工</label><input id="planEnd2" name="planEnd" placeholder="如 2026-07-30" style="width:140px"></div>
            <div class="acts" style="margin-top:0"><button id="rescheduleBtn" class="btn gray" type="submit">改排</button></div>
          </form></div>`
      : w.state === 'producing'
        ? `<form class="f" method="post" action="/mes/order/${w.id}/finish"><div class="acts"><button id="finishBtn" class="btn" type="submit">报工完工</button></div></form>`
        : '<div class="muted">该工单已完工，流程结束。</div>'
  res.send(layout(req, 'wo', `生产制造 / 生产工单 / <b>${w.id}</b>`, `${ok}
    <div class="panel"><div class="panel-h"><span class="bar"></span>工单详情</div><div class="panel-b">
      <div class="kv">
        <div class="k">工单号</div><div id="woNo">${w.id}</div><div class="k">优先级</div><div>${w.priority}</div>
        <div class="k">产品</div><div id="product" class="full">${w.product}</div>
        <div class="k">数量</div><div id="qty">${w.qty}</div><div class="k">产线</div><div>${w.line || '（待排产）'}</div>
        <div class="k">计划周期</div><div>${w.planStart ? `${w.planStart} ~ ${w.planEnd}` : '（待排产）'}</div>
        <div class="k">当前状态</div><div>${woTag(w.state)}</div>
      </div></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>用料清单（BOM）与供应风险</div><div class="panel-b" style="padding:0"><table>
      <tr><th>零件号</th><th>名称</th><th class="right">单台用量</th><th class="right">本单需求</th><th>供货状态</th><th class="right">供需</th></tr>${bomRows || '<tr><td colspan="6" class="muted" style="padding:14px">该产品暂无 BOM</td></tr>'}</table></div></div>
    <div class="panel"><div class="panel-h"><span class="bar"></span>工单操作</div><div class="panel-b">${act}</div></div>`))
})
app.post('/mes/order/:id/schedule', requireAuth, (req, res) => {
  const w = db.workorders.find(x => x.id === req.params.id)
  if (w && w.state === 'unscheduled') { w.line = req.body.line || LINES[0]; w.planStart = req.body.planStart || ''; w.planEnd = req.body.planEnd || ''; w.state = 'scheduled' }
  res.redirect(`/mes/order/${req.params.id}?ok=1`)
})
app.post('/mes/order/:id/reschedule', requireAuth, (req, res) => {
  const w = db.workorders.find(x => x.id === req.params.id)
  if (w && w.state === 'scheduled') { if (req.body.planStart) w.planStart = req.body.planStart; if (req.body.planEnd) w.planEnd = req.body.planEnd }
  res.redirect(`/mes/order/${req.params.id}?ok=1`)
})
app.post('/mes/order/:id/start', requireAuth, (req, res) => { const w = db.workorders.find(x => x.id === req.params.id); if (w && w.state === 'scheduled') w.state = 'producing'; res.redirect(`/mes/order/${req.params.id}?ok=1`) })
app.post('/mes/order/:id/finish', requireAuth, (req, res) => { const w = db.workorders.find(x => x.id === req.params.id); if (w && w.state === 'producing') w.state = 'done'; res.redirect(`/mes/order/${req.params.id}?ok=1`) })

// ================= 产线档案 =================
app.get('/mes/lines', requireAuth, (req, res) => {
  const blocks = LINES.map(l => {
    const wos = db.workorders.filter(w => w.line === l && w.state !== 'done')
    const rows = wos.map(w => `<tr><td><a class="lnk" href="/mes/order/${w.id}">${w.id}</a></td><td>${w.product}</td><td class="right">${w.qty}</td><td>${w.planStart} ~ ${w.planEnd}</td><td>${woTag(w.state)}</td></tr>`).join('')
    return `<div class="panel"><div class="panel-h"><span class="bar"></span>${l}<span class="muted" style="font-weight:400;margin-left:8px">在制/已排 ${wos.length} 单</span></div>
      <div class="panel-b" style="padding:0"><table><tr><th>工单</th><th>产品</th><th class="right">数量</th><th>计划周期</th><th>状态</th></tr>${rows || '<tr><td colspan="5" class="muted" style="padding:12px">空闲</td></tr>'}</table></div></div>`
  }).join('')
  res.send(layout(req, 'lines', '生产制造 / <b>产线档案</b>', blocks))
})

// 状态快照（便于 curl 验证真实写入是否落库）
app.get('/api/state', requireAuth, (req, res) => res.json({ suppliers: db.suppliers, parts: db.parts, bom: db.bom, purchases: db.purchases, workorders: db.workorders }))

app.listen(PORT, () => console.log(`[iml-mock-erm] 华信数字 · 企业资源管理系统 ERM (Mock) → http://localhost:${PORT}  （登录任意账号密码）`))
