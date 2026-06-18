// =====================================================================
// iML 自动化引擎（一份共享）：录制 + agent 主驱动执行
//   - RECORDER_JS：注入被录制页面，捕获点击/输入/选择/悬停，产出"带指纹的步骤"
//   - PAGE_JS：注入执行页面，提供 window.__iml.{snapshot, tryStep, actAt, centerOf, settle}
//   - runAgentic(adapter, steps, fieldValues, sop)：Node 侧 agent 主驱动状态机
// 设计：录制只产出"意图 + 指纹(强提示)"；定位最终以当前页面为准——
//   每步先用指纹高置信度匹配(免 LLM)，不中就让大模型读真实页面元素清单按 SOP 意图定位
//   (可 hover 展开/关弹窗/等待/停止)，执行后校验。
// =====================================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 录制脚本（注入被录制页）。事件 → console.log('__IMLREC__'+json)
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
  // 点击 / 选项点击
  document.addEventListener('click', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return; window.__lastHover=null;
    var opt=el.closest(OPT);
    if(opt){ emit({ act:'pickOption', label:clickLabel(opt), value:clean(opt.innerText), fp:fp(opt) }); return; }
    var t=el.closest('button,a,[role=button],[role=menuitem],[role=tab],.ant-btn,.ant-menu-item,li,td,span,div')||el;
    var tag=(t.tagName||'').toLowerCase(); if(tag==='body'||tag==='html') return;
    emit({ act:'click', label:clickLabel(t), value:'', fp:fp(t) });
  }, true);
  // 输入 / 原生下拉
  document.addEventListener('change', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return; var tag=(el.tagName||'').toLowerCase();
    if(tag==='select'){ var opts=[]; if(el.options){ for(var i=0;i<el.options.length;i++){ var ot=clean(el.options[i].text); if(ot&&el.options[i].value!=='') opts.push(ot); } } emit({ act:'select', label:fieldLabel(el), value:el.options&&el.selectedIndex>=0?clean(el.options[el.selectedIndex].text):el.value, options:opts, fp:fp(el) }); }
    else if(tag==='input'||tag==='textarea'){ if(el.type==='checkbox'||el.type==='radio') return; emit({ act:'fill', label:fieldLabel(el), value:el.value||'', fp:fp(el) }); }
  }, true);
  // 悬停（仅当真的展开了菜单/弹层才记）
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

// 执行页脚本：定义 window.__iml.{snapshot, tryStep, actAt, centerOf, settle}
const PAGE_JS = `(function(){
  if (window.__iml) return; var A = window.__iml = {};
  function vis(n){ try{ var r=n.getBoundingClientRect(); return n && n.offsetParent!==null && r.width>1 && r.height>1; }catch(e){ return false; } }
  function norm(s){ return String(s||'').replace(/[\\s*：:]/g,''); }
  function ownText(el){ var t=''; for(var i=0;i<el.childNodes.length;i++){ if(el.childNodes[i].nodeType===3) t+=el.childNodes[i].textContent; } return t.replace(/\\s+/g,' ').trim(); }
  function setVal(el,v){ var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; var setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function genSel(el){
    try{ if(el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id); }catch(e){}
    var a=['data-id','data-testid','data-name','name','aria-label']; for(var i=0;i<a.length;i++){ var v=el.getAttribute&&el.getAttribute(a[i]); if(v){ var s='['+a[i]+'=\"'+String(v).replace(/\"/g,'')+'\"]'; try{ if(document.querySelectorAll(s).length===1) return s; }catch(e){} } }
    var parts=[],e=el; while(e&&e.nodeType===1&&e.tagName!=='HTML'&&parts.length<8){ var tag=e.tagName.toLowerCase(),p=e.parentElement; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===e.tagName;}); if(sib.length>1) tag+=':nth-of-type('+(sib.indexOf(e)+1)+')'; } parts.unshift(tag); e=p; } return parts.join(' > ');
  }
  var RESULT='.ant-select-item-option,.ant-select-item,.el-select-dropdown__item,[role=option],.ant-cascader-menu-item,li[role=option],.dropdown-item,.ant-select-dropdown li,.el-autocomplete-suggestion li,.next-menu-item';
  function findOption(val){ var ns=document.querySelectorAll(RESULT),ex=null,pa=null; for(var i=0;i<ns.length;i++){ var n=ns[i]; if(!vis(n)) continue; var t=(n.innerText||n.textContent||'').trim(); if(!t) continue; if(val&&t===val){ ex=n; break; } if(!pa&&val&&t.indexOf(val)!==-1) pa=n; } return ex||pa; }
  // 按指纹高置信度定位（多信号），不确定返回 null
  function locate(fp){
    if(!fp) return null;
    var tries=[]; if(fp.id) tries.push('#'+CSS.escape(fp.id)); if(fp.dataId){ tries.push('[data-id=\"'+fp.dataId+'\"]','[data-testid=\"'+fp.dataId+'\"]'); } if(fp.name) tries.push('[name=\"'+fp.name+'\"]'); if(fp.aria) tries.push('[aria-label=\"'+fp.aria+'\"]');
    for(var i=0;i<tries.length;i++){ try{ var ns=document.querySelectorAll(tries[i]); if(ns.length===1&&vis(ns[0])) return ns[0]; }catch(e){} }
    if(fp.sel){ try{ var e=document.querySelector(fp.sel); if(vis(e)){ if(!fp.text || norm(e.innerText||e.textContent).indexOf(norm(fp.text))!==-1) return e; } }catch(e){} }
    if(fp.text){ var cand=[]; var all=document.querySelectorAll((fp.tag||'*')+',a,button,[role],span,div,li,td'); var nt=norm(fp.text); for(var j=0;j<all.length;j++){ var n=all[j]; if(!vis(n)) continue; if(norm(ownText(n))===nt){ cand.push(n); } } if(cand.length===1) return cand[0]; if(cand.length>1){ for(var k=0;k<cand.length;k++){ if((cand[k].tagName||'').toLowerCase()===fp.tag) return cand[k]; } } }
    return null;
  }
  function doAct(el, op, value){
    try{
      if(op==='hover'){ ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(tp){ try{ el.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window})); }catch(e){} }); return Promise.resolve({ok:true}); }
      if(op==='click'){ el.scrollIntoView({block:'center'}); el.click(); return Promise.resolve({ok:true}); }
      if(op==='fill'){ el.focus(); setVal(el,value); return Promise.resolve({ok:true}); }
      if(op==='select'){ if(el.tagName==='SELECT'){ for(var i=0;i<el.options.length;i++){ if(el.options[i].text===value||el.options[i].value===value){ el.selectedIndex=i; el.dispatchEvent(new Event('change',{bubbles:true})); break; } } return Promise.resolve({ok:true}); } el.scrollIntoView({block:'center'}); el.click(); return pollPick(value); }
      if(op==='search'){ el.focus(); setVal(el,value); return pollPick(value); }
      if(op==='pickOption'){ el.scrollIntoView({block:'center'}); el.click(); return Promise.resolve({ok:true}); }
      return Promise.resolve({ok:false,error:'未知动作'+op});
    }catch(err){ return Promise.resolve({ok:false,error:String(err)}); }
  }
  function pollPick(val){ return new Promise(function(res){ var n=0; (function p(){ n++; var h=findOption(val); if(h){ try{ h.scrollIntoView({block:'center'}); h.click(); res({ok:true}); }catch(e){ res({ok:false,error:String(e)}); } return; } if(n>=24){ res({ok:false,error:'未匹配到选项'+val}); return; } setTimeout(p,300); })(); }); }
  // 按指纹定位并执行（高置信度，免 LLM）；found=false 表示没定位到（交给上层 agent）
  A.tryStep = function(step){ var el=locate(step.fp); if(!el) return Promise.resolve({ok:false,found:false}); return doAct(el, step.op==='pickOption'?'pickOption':step.op, step.value).then(function(r){ r.found=true; return r; }); };
  // 按快照里的选择器执行（agent 选定后用）
  A.actAt = function(sel, op, value){ var el; try{ el=document.querySelector(sel); }catch(e){} if(!el||!vis(el)) return Promise.resolve({ok:false,error:'元素不存在'}); return doAct(el, op, value); };
  A.centerOf = function(sel){ var el; try{ el=document.querySelector(sel); }catch(e){} if(!el||!vis(el)) return null; el.scrollIntoView({block:'center'}); var r=el.getBoundingClientRect(); var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2); if(x<1||y<1||x>innerWidth-1||y>innerHeight-1) return null; return {x:x,y:y}; };
  // 当前页面可交互元素清单（给 agent 看）
  A.snapshot = function(){
    var nodes=document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=menuitem],[role=tab],[role=option],[onclick],.ant-btn,.ant-menu-item,li[role],[class*=btn],.ant-modal-close,.ant-modal-footer button,[class*=menu] li,[class*=nav] li,[class*=sider] li,[aria-label],[title]');
    var out=[],seen={}; for(var i=0;i<nodes.length&&out.length<70;i++){ var n=nodes[i]; if(!vis(n)) continue; var text=((n.innerText||n.value||(n.getAttribute&&(n.getAttribute('placeholder')||n.getAttribute('aria-label')||n.getAttribute('title')))||'')+'').replace(/\\s+/g,' ').trim().slice(0,40); var tag=n.tagName.toLowerCase(); if(!text&&tag!=='input'&&tag!=='textarea'&&tag!=='select') continue; var s=genSel(n); if(seen[s]) continue; seen[s]=1; out.push({tag:tag, role:(n.getAttribute&&n.getAttribute('role'))||'', text:text, sel:s}); }
    return out;
  };
  // 等待页面稳定
  A.settle = function(maxMs){ return new Promise(function(res){ var start=Date.now(),lastMut=Date.now(); var LOAD='.ant-spin-spinning,.ant-spin-dot,.el-loading-mask,.loading,.spinner,[class*=loading]:not([class*=loaded])'; var mo=null; try{ mo=new MutationObserver(function(){ lastMut=Date.now(); }); if(document.body) mo.observe(document.body,{childList:true,subtree:true,attributes:true}); }catch(e){} (function chk(){ var now=Date.now(); var loading=false; try{ if(document.querySelector(LOAD)) loading=true; }catch(e){} try{ var t=document.body?document.body.innerText:''; if(t.indexOf('努力加载中')!==-1||t.indexOf('加载中...')!==-1) loading=true; }catch(e){} if(document.readyState==='complete'&&!loading&&(now-lastMut)>500){ if(mo)mo.disconnect(); res(true); return; } if(now-start>maxMs){ if(mo)mo.disconnect(); res(false); return; } setTimeout(chk,200); })(); }); };
})();`

// 把录制步骤渲染成人类可读脚本（仅展示/SOP 生成用，不参与执行定位）
function stepsToReadable(steps) {
  return (steps || []).map(s => {
    const tgt = s.param ? `{{${s.param}}}` : (s.value ? `"${String(s.value).replace(/"/g, '')}"` : '')
    if (s.act === 'wait') return `wait ${s.value || 500}`
    if (s.act === 'waitText') return `waitText "${s.label}"`
    if (s.act === 'fill') return `fill "${s.label}" = ${tgt}`
    if (s.act === 'select') return `select "${s.label}" = ${tgt}`
    if (s.act === 'search') return `searchSelect "${s.label}" = ${tgt}`
    if (s.act === 'hover') return `hover "${s.label}"`
    if (s.act === 'pickOption') return `pick "${s.label}"`
    return `click "${s.label}"`
  }).join('\n')
}

// agent 主驱动执行器。adapter: { exec(jsString)->Promise, input(evt), llm(prompt)->Promise<string>, log(msg) }
async function runAgentic(adapter, steps, fieldValues, sop) {
  const { exec, input, llm, log } = adapter
  // 真实指针 hover（驱动纯 CSS:hover）
  const realHover = async (sel) => {
    const c = await exec(`window.__iml.centerOf(${JSON.stringify(sel)})`)
    if (c && typeof c.x === 'number') { try { input({ type: 'mouseMove', x: c.x, y: c.y }); await sleep(80); input({ type: 'mouseMove', x: c.x, y: c.y }) } catch (_) {} ; return true }
    return false
  }
  const actAt = async (el, op, value) => {
    if (op === 'hover') { const moved = await realHover(el.sel); const r = await exec(`window.__iml.actAt(${JSON.stringify(el.sel)},'hover','')`); return { ok: moved || (r && r.ok) } }
    return exec(`window.__iml.actAt(${JSON.stringify(el.sel)},${JSON.stringify(op)},${JSON.stringify(value || '')})`)
  }
  // 失败步 → 让大模型读真实页面定位
  const agentResolve = async (step, value) => {
    for (let round = 0; round < 3; round++) {
      let els = []; try { els = await exec(`window.__iml.snapshot()`) } catch (_) {}
      if (!els.length) { await sleep(700); continue }
      const list = els.map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`).join('\n')
      const intent = `${step.act}${step.label ? ' 「' + step.label + '」' : ''}${value ? ' 值=' + value : ''}`
      const prompt = `你在浏览器里执行业务自动化技能。整体标准流程(SOP)：\n${String(sop || '').slice(0, 1500)}\n\n当前这一步意图：${intent}\n（录制定位提示仅供参考：${step.fp && step.fp.sel ? step.fp.sel : '无'}；请以下面当前页面真实元素清单为准定位）\n按录制提示未命中。当前页面"可交互元素"清单（带编号）：\n${list}\n\n规则：\n- 很多菜单要先把鼠标悬停在图标/模块入口上才展开（左侧边栏图标、顶部一级菜单等）。目标看不到时不要急着 stop：先选最可能展开它的入口，action="hover"、completed=false（系统移真实指针展开后重试）。例如目标「客户管理」就 hover「CRM」「客户」等入口。\n- 有遮挡弹窗（权限提示/确认框）就先选关闭它的元素（"我知道了"/"确定"/关闭），completed=false。\n- 能直接完成就选对应元素 completed=true，需填值给 value。\n- 仅当 hover 展开相关入口后仍确实无法完成（明确无权限/目标不存在）才用 "stop"。\n只输出严格 JSON：{"action":"click|fill|select|search|hover|stop","index":<编号或-1>,"value":"<可选>","completed":true|false,"reason":"<简述>"}`
      let d = null
      try { const out = await llm(prompt); const s = (out || '').replace(/\`\`\`json/g, '').replace(/\`\`\`/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) d = JSON.parse(s.slice(a, b + 1)) } catch (_) {}
      if (!d) return { ok: false, reason: '自愈决策解析失败' }
      const tgt = (typeof d.index === 'number' && d.index >= 0 && els[d.index]) ? els[d.index] : null
      if (log) log(`智能定位：${d.action}${tgt ? ' 「' + (tgt.text || '') + '」' : ''} — ${d.reason || ''}`)
      if (d.action === 'stop') return { ok: false, reason: d.reason || '智能体判定无法继续' }
      if (!tgt) return { ok: false, reason: '未指定有效元素' }
      await actAt(tgt, d.action, d.value || value)
      await sleep(700)
      if (d.completed) return { ok: true }
      const rr = await exec(`window.__iml.tryStep(${JSON.stringify({ op: step.act === 'pickOption' ? 'pickOption' : step.act, fp: step.fp, value })})`)
      if (rr && rr.ok) return { ok: true }
    }
    return { ok: false, reason: '多轮智能定位仍未完成' }
  }

  let done = 0, prevAct = ''
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const value = step.param ? (fieldValues[step.param] !== undefined ? fieldValues[step.param] : '') : step.value
    const desc = `${step.act}${step.label ? ' 「' + step.label + '」' : ''}${value ? ' = ' + value : ''}`
    if (prevAct === 'click' || prevAct === 'hover' || prevAct === 'pickOption') { if (log) log('等待页面加载稳定…'); try { await exec(`window.__iml.settle(9000)`) } catch (_) {} }
    if (step.act === 'wait') { if (log) log(`[${i + 1}/${steps.length}] 等待 ${value || 500}ms`); await sleep(parseInt(value, 10) || 500); done++; prevAct = 'wait'; continue }
    if (step.act === 'waitText') { if (log) log(`[${i + 1}/${steps.length}] 等待文本「${step.label}」`); let ok = false; for (let k = 0; k < 30; k++) { const has = await exec(`(document.body?document.body.innerText:'').indexOf(${JSON.stringify(step.label)})!==-1`); if (has) { ok = true; break } await sleep(300) } done++; prevAct = 'waitText'; continue }
    if (log) log(`[${i + 1}/${steps.length}] ${desc}`)
    let r = null
    if (step.act === 'hover') { const moved = await realHover(step.fp && step.fp.sel); r = { ok: moved }; if (!moved) r = await agentResolve(step, value) }
    else { r = await exec(`window.__iml.tryStep(${JSON.stringify({ op: step.act === 'pickOption' ? 'pickOption' : step.act, fp: step.fp, value })})`) ; if (!r || !r.found || !r.ok) { if (log) log(`未命中 → 智能体读页面定位…`); r = await agentResolve(step, value) } }
    if (!r || !r.ok) return { ok: true, done, total: steps.length, failedAt: i, failLabel: desc, error: r && r.reason }
    done++; prevAct = step.act; await sleep(400)
  }
  return { ok: true, done, total: steps.length, failedAt: -1 }
}

module.exports = { RECORDER_JS, PAGE_JS, runAgentic, stepsToReadable, sleep }
