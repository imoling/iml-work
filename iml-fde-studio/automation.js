// =====================================================================
// iML 自动化引擎（Playwright 驱动真实 Chrome）
//   录制：RECORDER_JS 注入页面，捕获操作 + 元素指纹 → 步骤
//   执行：runAgentic(page, steps, fieldValues, sop, hooks)
//     每个 SOP 节点：先在 DOM 代码树里按指纹/文本定位控件，再用 Playwright 真实操作
//     (locator.click/hover/fill/selectOption，自动等待可点)；定位不到才让大模型读页面决策
// =====================================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 录制脚本（Playwright addInitScript 注入；每步 console.log('__IMLREC__'+json)）
const RECORDER_JS = `(function(){
  if (window.__imlRec) return; window.__imlRec = true;
  function esc(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); }
  function uniq(sel){ try { return document.querySelectorAll(sel).length === 1; } catch(e){ return false; } }
  function ownText(el){ var t=''; for(var i=0;i<el.childNodes.length;i++){ if(el.childNodes[i].nodeType===3) t+=el.childNodes[i].textContent; } return t.replace(/\\s+/g,' ').trim(); }
  function clean(s){ return String(s||'').replace(/\\s+/g,' ').trim(); }
  function stableCls(el){ var c=(el.getAttribute&&el.getAttribute('class'))||''; return c.split(/\\s+/).filter(function(x){ return x && x.length<=24 && !/^css-|[0-9]{4,}|--[a-z0-9]{4,}/.test(x); }).slice(0,3); }
  function anchorOf(el){ var a=['data-id','data-testid','data-name'], e=el; while(e&&e.nodeType===1&&e.tagName!=='HTML'){ if(e.id&&uniq('#'+esc(e.id))) return {sel:'#'+esc(e.id),el:e}; for(var i=0;i<a.length;i++){ var v=e.getAttribute&&e.getAttribute(a[i]); if(v){ var s='['+a[i]+'=\"'+v.replace(/\"/g,'')+'\"]'; if(uniq(s)) return {sel:s,el:e}; } } e=e.parentElement; } return null; }
  function relPath(el,stop){ var parts=[],cur=el; while(cur&&cur.nodeType===1&&cur!==stop&&cur.tagName!=='HTML'&&parts.length<8){ var tag=cur.tagName.toLowerCase(),p=cur.parentElement; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===cur.tagName;}); if(sib.length>1) tag+=':nth-of-type('+(sib.indexOf(cur)+1)+')'; } parts.unshift(tag); cur=p; } return parts.join(' > '); }
  function bestSel(el){
    if(el.id && uniq('#'+esc(el.id))) return '#'+esc(el.id);
    var attrs=['data-testid','data-id','data-name','name','aria-label'];
    for(var i=0;i<attrs.length;i++){ var v=el.getAttribute&&el.getAttribute(attrs[i]); if(v){ var s='['+attrs[i]+'=\"'+v.replace(/\"/g,'')+'\"]'; if(uniq(s)) return s; } }
    var an=anchorOf(el); if(an){ var rp=relPath(el,an.el); return rp?an.sel+' > '+rp:an.sel; }
    return relPath(el,null);
  }
  function fp(el){
    return { tag:el.tagName.toLowerCase(), role:(el.getAttribute&&el.getAttribute('role'))||'',
      text:clean(ownText(el)).slice(0,60), id:el.id||'', name:(el.getAttribute&&el.getAttribute('name'))||'',
      dataId:(el.getAttribute&&(el.getAttribute('data-id')||el.getAttribute('data-testid')))||'',
      aria:(el.getAttribute&&el.getAttribute('aria-label'))||'', title:(el.getAttribute&&el.getAttribute('title'))||'',
      cls:stableCls(el), sel:bestSel(el) };
  }
  function fieldLabel(el){
    if(el.id){ var l=document.querySelector('label[for=\"'+esc(el.id)+'\"]'); if(l) return clean(l.innerText); }
    var box=el.closest&&el.closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li');
    if(box){ var lab=box.querySelector('label, .ant-form-item-label, .el-form-item__label, dt, th'); if(lab) return clean(lab.innerText); }
    return clean((el.getAttribute&&(el.getAttribute('aria-label')||el.placeholder))||'');
  }
  function clickLabel(el){ return clean(ownText(el)||(el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('title')))||el.innerText).slice(0,40); }
  function emit(s){ try{ console.log('__IMLREC__'+JSON.stringify(s)); }catch(e){} }
  function menuSig(){ var ms; try{ ms=document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden),.ant-menu-submenu-popup,[role=menu],[role=listbox],.ant-select-dropdown:not(.ant-select-dropdown-hidden),.ant-popover:not(.ant-popover-hidden),[class*=submenu],[class*=sub-menu],[class*=dropdown-menu],[class*=popover],[class*=flyout],[class*=secondary-menu],[class*=expand]'); }catch(e){ return 0; } var c=0; for(var i=0;i<ms.length;i++){ if(ms[i].offsetParent!==null) c++; } return c; }
  var OPT='.ant-select-item-option,.el-select-dropdown__item,[role=option],.ant-cascader-menu-item,li[role=option],.dropdown-item';
  document.addEventListener('click', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return; window.__lastHover=null;
    var opt=el.closest(OPT);
    if(opt){ emit({ act:'pickOption', label:clickLabel(opt), value:clean(opt.innerText), fp:fp(opt) }); return; }
    var t=el.closest('button,a,[role=button],[role=menuitem],[role=tab],.ant-btn,.ant-menu-item,li,td,span,div')||el;
    var tag=(t.tagName||'').toLowerCase(); if(tag==='body'||tag==='html') return;
    emit({ act:'click', label:clickLabel(t), value:'', fp:fp(t) });
  }, true);
  document.addEventListener('change', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return; var tag=(el.tagName||'').toLowerCase();
    if(tag==='select'){ var opts=[]; if(el.options){ for(var i=0;i<el.options.length;i++){ var ot=clean(el.options[i].text); if(ot&&el.options[i].value!=='') opts.push(ot); } } emit({ act:'select', label:fieldLabel(el), value:el.options&&el.selectedIndex>=0?clean(el.options[el.selectedIndex].text):el.value, options:opts, fp:fp(el) }); }
    else if(tag==='input'||tag==='textarea'){ if(el.type==='checkbox'||el.type==='radio') return; emit({ act:'fill', label:fieldLabel(el), value:el.value||'', fp:fp(el) }); }
  }, true);
  var hT=null;
  document.addEventListener('mouseover', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return;
    var t=el.closest('a,button,[role=menuitem],[role=button],[aria-haspopup],[class*=menu],[class*=nav],[class*=tab],li')||el;
    var tag=(t.tagName||'').toLowerCase(); if(tag==='body'||tag==='html'||tag==='main') return;
    var before=menuSig(); var key; try{ key=bestSel(t); }catch(_e){ return; }
    if(hT) clearTimeout(hT);
    hT=setTimeout(function(){ if(menuSig()<=before) return; if(key===window.__lastHover) return; window.__lastHover=key; emit({ act:'hover', label:clickLabel(t), value:'', fp:fp(t) }); }, 500);
  }, true);
})();`

// 页面可交互元素清单（给自愈 agent 看）；通过 page.evaluate('('+SNAPSHOT_FN+')()') 调用
const SNAPSHOT_FN = `function(){
  function vis(n){ try{ var r=n.getBoundingClientRect(); return n && n.offsetParent!==null && r.width>1 && r.height>1; }catch(e){ return false; } }
  function gen(el){
    try{ if(el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id); }catch(e){}
    var a=['data-id','data-testid','data-name','name','aria-label']; for(var i=0;i<a.length;i++){ var v=el.getAttribute&&el.getAttribute(a[i]); if(v){ var s='['+a[i]+'=\"'+String(v).replace(/\"/g,'')+'\"]'; try{ if(document.querySelectorAll(s).length===1) return s; }catch(e){} } }
    var parts=[],e=el; while(e&&e.nodeType===1&&e.tagName!=='HTML'&&parts.length<8){ var tag=e.tagName.toLowerCase(),p=e.parentElement; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===e.tagName;}); if(sib.length>1) tag+=':nth-of-type('+(sib.indexOf(e)+1)+')'; } parts.unshift(tag); e=p; } return parts.join(' > ');
  }
  var nodes=document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=menuitem],[role=tab],[role=option],[onclick],.ant-btn,.ant-menu-item,li[role],[class*=btn],.ant-modal-close,.ant-modal-footer button,[class*=menu] li,[class*=nav] li,[class*=sider] li,[aria-label],[title]');
  var out=[],seen={}; for(var i=0;i<nodes.length&&out.length<70;i++){ var n=nodes[i]; if(!vis(n)) continue; var text=((n.innerText||n.value||(n.getAttribute&&(n.getAttribute('placeholder')||n.getAttribute('aria-label')||n.getAttribute('title')))||'')+'').replace(/\\s+/g,' ').trim().slice(0,40); var tag=n.tagName.toLowerCase(); if(!text&&tag!=='input'&&tag!=='textarea'&&tag!=='select') continue; var s=gen(n); if(seen[s]) continue; seen[s]=1; out.push({tag:tag, role:(n.getAttribute&&n.getAttribute('role'))||'', text:text, sel:s}); }
  return out;
}`

function norm(s) { return String(s || '').replace(/[\s*：:]/g, '') }
function stepsToReadable(steps) {
  return (steps || []).map(s => {
    const t = s.param ? `{{${s.param}}}` : (s.value ? `"${String(s.value).replace(/"/g, '')}"` : '')
    if (s.act === 'fill') return `fill "${s.label}" = ${t}`
    if (s.act === 'select') return `select "${s.label}" = ${t}`
    if (s.act === 'search') return `searchSelect "${s.label}" = ${t}`
    if (s.act === 'hover') return `hover "${s.label}"`
    if (s.act === 'pickOption') return `pick "${s.label}"`
    return `click "${s.label}"`
  }).join('\n')
}

// ============ Playwright 执行引擎 ============
// page: Playwright Page；hooks: { llm(prompt)->Promise<string>, log(msg) }
async function runAgentic(page, steps, fieldValues, sop, hooks) {
  const { llm, log } = hooks || {}
  const RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li'

  async function settle(maxMs = 9000) {
    try { await page.waitForLoadState('domcontentloaded', { timeout: maxMs }) } catch (_) {}
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      const loading = await page.evaluate(`(function(){try{ if(document.querySelector('.ant-spin-spinning,.ant-spin-dot,.el-loading-mask,[class*=loading]:not([class*=loaded])')) return true; var t=document.body?document.body.innerText:''; return t.indexOf('努力加载中')!==-1||t.indexOf('加载中...')!==-1; }catch(e){ return false; }})()`).catch(() => false)
      if (!loading) break
      await sleep(300)
    }
    await sleep(250)
  }

  async function visible(loc) { try { return await loc.isVisible({ timeout: 500 }) } catch (_) { return false } }

  // 在 DOM 代码树里按指纹定位控件，返回可见的 Playwright Locator 或 null
  async function fpLocator(fp) {
    if (!fp) return null
    const cands = []
    if (fp.id) cands.push(`[id="${fp.id}"]`)
    if (fp.dataId) { cands.push(`[data-id="${fp.dataId}"]`, `[data-testid="${fp.dataId}"]`) }
    if (fp.name) cands.push(`[name="${fp.name}"]`)
    if (fp.aria) cands.push(`[aria-label="${fp.aria}"]`)
    if (fp.sel) cands.push(fp.sel)
    for (const c of cands) {
      try {
        const loc = page.locator(c)
        const n = await loc.count()
        if (n >= 1) {
          const f = loc.first()
          if (await visible(f)) {
            if (!fp.text) return f
            const tx = await f.innerText().catch(() => '')
            if (norm(tx).indexOf(norm(fp.text)) !== -1) return f
          }
        }
      } catch (_) {}
    }
    if (fp.text) {
      try { const loc = page.getByText(fp.text, { exact: true }).first(); if (await visible(loc)) return loc } catch (_) {}
      try { const loc = page.getByText(fp.text).first(); if (await visible(loc)) return loc } catch (_) {}
    }
    return null
  }

  async function byLabelText(label) {
    if (!label) return null
    try { const loc = page.getByText(label, { exact: true }).first(); if (await visible(loc)) return loc } catch (_) {}
    try { const loc = page.getByRole('button', { name: label }).first(); if (await visible(loc)) return loc } catch (_) {}
    try { const loc = page.getByText(label).first(); if (await visible(loc)) return loc } catch (_) {}
    return null
  }

  async function pickResult(value) {
    try { const opt = page.locator(RESULT_SEL).filter({ hasText: value }).first(); await opt.click({ timeout: 6000 }); return { ok: true } }
    catch (e) { return { ok: false, error: '未匹配到选项「' + value + '」' } }
  }

  // 用 Playwright 真实操作
  async function act(loc, op, value) {
    try {
      if (op === 'hover') { await loc.hover({ timeout: 5000 }); return { ok: true } }
      if (op === 'click' || op === 'pickOption') { await loc.click({ timeout: 7000 }); return { ok: true } }
      if (op === 'fill') { await loc.fill(String(value || ''), { timeout: 5000 }); return { ok: true } }
      if (op === 'select') { try { await loc.selectOption({ label: String(value || '') }, { timeout: 2500 }); return { ok: true } } catch (e) { await loc.click({ timeout: 4000 }); return pickResult(value) } }
      if (op === 'search') { await loc.fill(String(value || ''), { timeout: 5000 }); return pickResult(value) }
      return { ok: false, error: '未知动作 ' + op }
    } catch (e) { return { ok: false, error: e.message } }
  }

  // 定位不到 → 大模型读页面元素清单决策（找控件 / 悬停展开 / 关弹窗 / 停止）
  async function agentResolve(step, value) {
    for (let round = 0; round < 3; round++) {
      let els = []
      try { els = await page.evaluate('(' + SNAPSHOT_FN + ')()') } catch (_) {}
      if (!els.length) { await sleep(700); continue }
      const list = els.map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`).join('\n')
      const intent = `${step.act}${step.label ? ' 「' + step.label + '」' : ''}${value ? ' 值=' + value : ''}`
      const prompt = `你在用浏览器执行业务自动化技能。整体标准流程(SOP)：\n${String(sop || '').slice(0, 1500)}\n\n当前这一步意图：${intent}\n（录制定位提示仅供参考：${step.fp && step.fp.sel ? step.fp.sel : '无'}；请以下面当前页面真实元素清单为准定位）\n按录制提示未命中。当前页面"可交互元素"清单（带编号）：\n${list}\n\n规则：\n- 很多菜单要先把鼠标悬停在图标/模块入口上才展开（左侧边栏图标、顶部一级菜单等）。目标看不到时不要急着 stop：先选最可能展开它的入口，action="hover"、completed=false（系统会真实悬停展开后重试）。例如目标「客户管理」就 hover「CRM」「客户」等入口。\n- 有遮挡弹窗（权限提示/确认框）就先选关闭它的元素（"我知道了"/"确定"/关闭），completed=false。\n- 能直接完成就选对应元素 completed=true，需填值给 value。\n- 仅当 hover 展开相关入口后仍确实无法完成（明确无权限/目标不存在）才用 "stop"。\n只输出严格 JSON：{"action":"click|fill|select|search|hover|stop","index":<编号数字或-1>,"value":"<可选>","completed":true|false,"reason":"<简述>"}`
      let d = null
      try { const out = await llm(prompt); const s = (out || '').replace(/\`\`\`json/g, '').replace(/\`\`\`/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) d = JSON.parse(s.slice(a, b + 1)) } catch (_) {}
      if (!d) return { ok: false, reason: '智能决策解析失败' }
      const idx = (typeof d.index === 'number') ? d.index : parseInt(d.index, 10)
      const tgt = (Number.isFinite(idx) && idx >= 0 && els[idx]) ? els[idx] : null
      if (log) log(`智能定位：${d.action}${tgt ? ' 「' + (tgt.text || '') + '」' : ''} — ${d.reason || ''}`)
      if (d.action === 'stop') return { ok: false, reason: d.reason || '智能体判定无法继续' }
      if (!tgt) return { ok: false, reason: '未指定有效元素' }
      const loc = page.locator(tgt.sel).first()
      await act(loc, d.action === 'pickOption' ? 'pickOption' : d.action, d.value || value)
      await sleep(700)
      if (d.completed) return { ok: true }
      // 关闭遮挡/展开后重试原步骤
      const l2 = await fpLocator(step.fp) || await byLabelText(step.label)
      if (l2) { const rr = await act(l2, step.act === 'pickOption' ? 'pickOption' : step.act, value); if (rr.ok) return { ok: true } }
    }
    return { ok: false, reason: '多轮智能定位仍未完成' }
  }

  let done = 0, prevAct = ''
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const value = step.param ? (fieldValues[step.param] !== undefined ? fieldValues[step.param] : '') : step.value
    const desc = `${step.act}${step.label ? ' 「' + step.label + '」' : ''}${value ? ' = ' + value : ''}`
    if (prevAct === 'click' || prevAct === 'hover' || prevAct === 'pickOption' || prevAct === 'search') { if (log) log('等待页面加载稳定…'); await settle() }
    if (step.act === 'wait') { await sleep(parseInt(value, 10) || 500); done++; prevAct = 'wait'; continue }
    if (step.act === 'waitText') { try { await page.getByText(step.label).first().waitFor({ timeout: 9000 }) } catch (_) {}; done++; prevAct = 'waitText'; continue }
    if (log) log(`[${i + 1}/${steps.length}] ${desc}`)
    let loc = await fpLocator(step.fp)
    if (!loc && step.act !== 'fill' && step.act !== 'select' && step.act !== 'search') loc = await byLabelText(step.label)
    let r
    if (loc) {
      r = await act(loc, step.act === 'pickOption' ? 'pickOption' : step.act, value)
      if (!r.ok) { if (log) log('操作未成功 → 智能体读页面重试…'); r = await agentResolve(step, value) }
    } else {
      if (log) log('未命中 → 智能体读页面定位…')
      r = await agentResolve(step, value)
    }
    if (!r || !r.ok) {
      if (hooks && hooks.diag) { try { await hooks.diag(i, desc, r && r.reason) } catch (_) {} }
      return { ok: true, done, total: steps.length, failedAt: i, failLabel: desc, error: r && r.reason }
    }
    done++; prevAct = step.act; await sleep(300)
  }
  return { ok: true, done, total: steps.length, failedAt: -1 }
}

module.exports = { RECORDER_JS, SNAPSHOT_FN, runAgentic, stepsToReadable, sleep }
