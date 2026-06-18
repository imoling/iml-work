const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

let toolWin = null
let recorderWin = null
let recorderSteps = []

// 注入到被录制页面里的脚本：计算稳健选择器并监听 click / change，通过 console 通道上报。
// 与主客户端 iml-work-client 中的 RECORDER_BOOTSTRAP 保持一致（已验证）。
const RECORDER_BOOTSTRAP = `(function(){
  if (window.__recInstalled) return; window.__recInstalled = true;
  function esc(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); }
  function uniq(sel){ try { return document.querySelectorAll(sel).length === 1; } catch(e){ return false; } }
  function cssPath(el){
    var parts = [];
    while (el && el.nodeType === 1 && el.tagName !== 'HTML'){
      var tag = el.tagName.toLowerCase();
      var p = el.parentElement;
      if (!p){ parts.unshift(tag); break; }
      var sameTag = Array.prototype.filter.call(p.children, function(c){ return c.tagName === el.tagName; });
      if (sameTag.length > 1){ tag += ':nth-of-type(' + (sameTag.indexOf(el)+1) + ')'; }
      parts.unshift(tag);
      if (parts.length >= 6) break;
      el = p;
    }
    return parts.join(' > ');
  }
  function robust(el){
    if (el.id && uniq('#'+esc(el.id))) return '#'+esc(el.id);
    var attrs = ['data-testid','data-test','data-id','data-name','name','aria-label'];
    for (var i=0;i<attrs.length;i++){ var v=el.getAttribute && el.getAttribute(attrs[i]); if(v){ var s='['+attrs[i]+'="'+v.replace(/"/g,'\\\\"')+'"]'; if(uniq(s)) return s; if(uniq(el.tagName.toLowerCase()+s)) return el.tagName.toLowerCase()+s; } }
    return cssPath(el);
  }
  function labelOf(el){
    if (el.id){ var l=document.querySelector('label[for="'+esc(el.id)+'"]'); if(l) return (l.innerText||'').trim(); }
    var box = el.closest && el.closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li');
    if (box){ var lab = box.querySelector('label, .ant-form-item-label, .el-form-item__label, dt, th'); if(lab) return (lab.innerText||'').trim(); }
    return (el.getAttribute && (el.getAttribute('aria-label')||el.placeholder)) || (el.innerText||'').trim().slice(0,30);
  }
  function emit(step){ try { if(step.label) step.label=String(step.label).replace(/\\s+/g,' ').trim(); console.log('__REC__'+JSON.stringify(step)); } catch(e){} }
  var OPT_SEL = '.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item';
  function optionTexts(container){ var r=[]; if(!container) return r; var ns=container.querySelectorAll('.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], option, .dropdown-item'); for(var i=0;i<ns.length;i++){ var t=(ns[i].innerText||ns[i].textContent||'').trim(); if(t && r.indexOf(t)===-1) r.push(t); } return r.slice(0,60); }
  function __menuSig(){
    var ms; try{ ms=document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden), .ant-menu-submenu-popup, [role=menu], [role=listbox], .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-popover:not(.ant-popover-hidden), [class*=submenu], [class*=sub-menu], [class*=dropdown-menu], [class*=popover]'); }catch(e){ return 0; }
    var c=0; for(var i=0;i<ms.length;i++){ if(ms[i].offsetParent!==null) c++; } return c;
  }
  var __hoverTimer=null, __lastHover=null;
  document.addEventListener('mouseover', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return;
    var t = el.closest('a, button, [role=menuitem], [role=button], [aria-haspopup], [class*=menu], [class*=nav], [class*=tab], li') || el;
    var tag=(t.tagName||'').toLowerCase(); if(tag==='body'||tag==='html'||tag==='main') return;
    var sel; try{ sel=robust(t); }catch(_e){ return; }
    var before=__menuSig();
    if (__hoverTimer) clearTimeout(__hoverTimer);
    __hoverTimer = setTimeout(function(){
      if(__menuSig() <= before) return;          // 只在悬停真的揭开了菜单/弹层时才记录，过滤鼠标路过
      if(sel===__lastHover) return; __lastHover=sel;
      emit({ action:'hover', selector:sel, value:'', label:(t.innerText||t.getAttribute('aria-label')||'').trim().slice(0,40), tag:tag, url:location.href });
    }, 500);
  }, true);
  document.addEventListener('click', function(e){
    var el = e.target; if(!el || el.nodeType!==1) return;
    __lastHover=null;
    var opt = el.closest(OPT_SEL);
    if (opt){
      var pop = opt.closest('.ant-select-dropdown, .el-select-dropdown, .ant-cascader-menus, [role=listbox], .dropdown-menu, ul') || opt.parentElement;
      var ot = (opt.innerText||'').trim().slice(0,40);
      emit({ action:'click', selector: robust(opt), value: ot, label: ot, tag:(opt.tagName||'').toLowerCase(), url: location.href, options: optionTexts(pop) });
      return;
    }
    var clickable = el.closest('button, a, [role=button], [role=menuitem], .ant-select-item, li, td, span, div');
    var t = clickable || el;
    emit({ action:'click', selector: robust(t), value:'', label:(t.innerText||t.getAttribute('aria-label')||'').trim().slice(0,40), tag:(t.tagName||'').toLowerCase(), url: location.href });
  }, true);
  document.addEventListener('change', function(e){
    var el = e.target; if(!el || el.nodeType!==1) return;
    var tag = (el.tagName||'').toLowerCase();
    if (tag === 'select'){
      var txt = el.options && el.selectedIndex>=0 ? el.options[el.selectedIndex].text : el.value;
      var opts = []; if (el.options){ for (var i=0;i<el.options.length;i++){ var ot2=(el.options[i].text||'').trim(); if(ot2 && el.options[i].value !== '') opts.push(ot2); } }
      emit({ action:'select', selector: robust(el), value: txt, label: labelOf(el), tag: tag, url: location.href, options: opts });
    } else if (tag === 'input' || tag === 'textarea'){
      if (el.type === 'checkbox' || el.type === 'radio') return;
      emit({ action:'fill', selector: robust(el), value: el.value || '', label: labelOf(el), tag: tag, url: location.href });
    }
  }, true);
})();`

function injectRecorder(wc) { wc.executeJavaScript(RECORDER_BOOTSTRAP).catch(() => {}) }

function createWindow() {
  toolWin = new BrowserWindow({
    width: 820, height: 860, title: 'iML Work · FDE 工作台',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  toolWin.loadFile('index.html')
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// 拉取管理端业务系统连接列表。
ipcMain.handle('admin:systems', async (_e, { adminBaseUrl }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const res = await fetch(`${base}/api/v1/integrations`)
    if (!res.ok) return { ok: false, systems: [], error: `HTTP ${res.status}` }
    const list = await res.json()
    const systems = (Array.isArray(list) ? list : []).map(s => ({ id: s.id, type: s.type, name: s.name, baseUrl: s.baseUrl }))
    return { ok: true, systems }
  } catch (e) { return { ok: false, systems: [], error: e.message } }
})

// 上传录制结果到管理端：由后端经企业模型中转站转换成「语义脚本(DSL)+SOP」的标准技能。
// 仅含步骤/选择器/字段，绝不含登录态。
ipcMain.handle('admin:save-skill', async (_e, { adminBaseUrl, name, triggerKeywords, targetSystemId, steps, fields, engine, script, sop }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const body = { name, triggerKeywords: triggerKeywords || [], targetSystemId: targetSystemId || '', steps: steps || [], fields: fields || [], engine: engine || 'browser', script: script || '', sop: sop || '' }
    const res = await fetch(`${base}/api/v1/skills/from-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, skill: await res.json() }
  } catch (e) { return { ok: false, error: e.message } }
})

// 试运行阶段：根据脚本生成 SOP（经管理端模型中转站），供 FDE 编辑后随技能同步。
ipcMain.handle('skill:gen-sop', async (_e, { adminBaseUrl, name, script, fields, engine }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const res = await fetch(`${base}/api/v1/skills/gen-sop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, script: script || '', fields: fields || [], engine: engine || 'browser' })
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const d = await res.json()
    return { ok: true, sop: d.sop || '' }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('recorder:start', async (_e, { systemId, baseUrl, systemName }) => {
  try {
    if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
    recorderSteps = []
    const win = new BrowserWindow({
      show: true, width: 1280, height: 860, title: `实操录制 · ${systemName || ''}`,
      webPreferences: { partition: `persist:rec-${systemId}` }
    })
    recorderWin = win
    const onStep = (_ev, _level, message) => {
      if (typeof message === 'string' && message.startsWith('__REC__')) {
        try {
          const step = JSON.parse(message.slice('__REC__'.length))
          const last = recorderSteps[recorderSteps.length - 1]
          if (step.action === 'fill' && last && last.action === 'fill' && last.selector === step.selector) last.value = step.value
          else recorderSteps.push(step)
          if (toolWin && !toolWin.isDestroyed()) toolWin.webContents.send('recorder:step', step)
        } catch (_) {}
      }
    }
    win.webContents.on('console-message', onStep)
    win.webContents.on('did-finish-load', () => injectRecorder(win.webContents))
    win.webContents.on('did-frame-navigate', () => injectRecorder(win.webContents))
    win.on('closed', () => { recorderWin = null })
    await win.loadURL(baseUrl)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('recorder:stop', async () => {
  const steps = recorderSteps.slice()
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
  recorderWin = null
  return { ok: true, steps }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
  recorderWin = null
  return { ok: true }
})

// ===== 试运行：在可见浏览器里按语义脚本(DSL)解释执行，FDE 亲眼看技能跑得对不对 =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function parseDsl(code) {
  const out = []
  for (const raw of (code || '').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let sel = ''
    const sm = line.match(/\s@sel=(.+)$/)
    if (sm) { sel = sm[1].trim(); line = line.slice(0, sm.index).trim() }
    let m
    if ((m = line.match(/^wait\s+(\d+)/i))) { out.push({ op: 'wait', arg: '', valueExpr: m[1] }); continue }
    if ((m = line.match(/^waitText\s+"([^"]*)"/i))) { out.push({ op: 'waitText', arg: m[1], valueExpr: '', sel }); continue }
    if ((m = line.match(/^(\w+)\s+"([^"]*)"\s*(?:=\s*(.+))?$/))) { out.push({ op: m[1], arg: m[2], valueExpr: (m[3] || '').trim(), sel }); continue }
  }
  return out
}
function resolveDslValue(valueExpr, fieldValues) {
  if (!valueExpr) return ''
  const pm = valueExpr.match(/^\{\{\s*([\w.]+)\s*\}\}$/)
  if (pm) return fieldValues[pm[1]] !== undefined ? fieldValues[pm[1]] : ''
  return valueExpr.replace(/^"|"$/g, '')
}

const SEMANTIC_FN = `function(step){
  return new Promise(function(resolve){
    var op=step.op, arg=step.arg, value=step.value;
    function norm(s){ return (s||'').replace(/[\\s*：:]/g,''); }
    function visible(n){ return n && n.offsetParent !== null; }
    function bySel(){ if(!step.sel) return null; try{ var e=document.querySelector(step.sel); return visible(e)?e:null; }catch(_e){ return null; } }
    function setNativeValue(el, val){
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function labelBox(label){
      var t = norm(label);
      var labels = Array.prototype.slice.call(document.querySelectorAll('label, .ant-form-item-label, .el-form-item__label, .form-label, dt, th'));
      for (var i=0;i<labels.length;i++){ if (norm(labels[i].innerText).indexOf(t) !== -1){
        return { lab: labels[i], box: labels[i].closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li') || labels[i].parentElement };
      } }
      return null;
    }
    function labelControl(label){
      var lb = labelBox(label); if(!lb) return null;
      var c = lb.box ? lb.box.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select') : null;
      if (!c && lb.lab.htmlFor) c = document.getElementById(lb.lab.htmlFor);
      return c;
    }
    function labelTrigger(label){
      var lb = labelBox(label); if(!lb || !lb.box) return null;
      return lb.box.querySelector('.ant-select-selector, .ant-select, [role=combobox], .el-select, .el-input__inner, input:not([type=hidden]), .form-control, .ant-picker');
    }
    function clickByText(text){
      var t = (text||'').trim();
      var sel = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], .ant-btn, .ant-menu-item, .el-button, li, td, span, div';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      var ownMatch=null, fullMatches=[], partial=null;
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue;
        var own=''; for(var k=0;k<n.childNodes.length;k++){ if(n.childNodes[k].nodeType===3) own+=n.childNodes[k].textContent; }
        own=own.trim(); var full=(n.innerText||'').trim();
        if(own===t){ ownMatch=n; break; }
        if(full===t) fullMatches.push(n);
        if(!partial && t && full.indexOf(t)!==-1 && full.length < t.length+12) partial=n;
      }
      if (ownMatch) return ownMatch;
      if (fullMatches.length){ fullMatches.sort(function(a,b){ return a.querySelectorAll('*').length - b.querySelectorAll('*').length; }); return fullMatches[0]; }
      return partial;
    }
    var RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li';
    function findOption(val){
      var nodes=document.querySelectorAll(RESULT_SEL); var exact=null,partial=null;
      for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue; var tx=(n.innerText||n.textContent||'').trim(); if(!tx) continue;
        if(val && tx===val){ exact=n; break; } if(!partial && val && tx.indexOf(val)!==-1) partial=n; }
      return exact||partial;
    }
    function pollClickOption(val, done){
      var tries=0; (function p(){ tries++; var h=findOption(val);
        if(h){ try{ h.scrollIntoView({block:'center'}); h.click(); done({ok:true}); }catch(e){ done({ok:false,error:String(e)}); } return; }
        if(tries>=24){ done({ok:false,error:'未匹配到选项“'+val+'”'}); return; } setTimeout(p,300); })();
    }
    function withRetry(fn){ var tries=0; (function a(){ tries++; if(fn()) return; if(tries>=20){ resolve({ok:false,error:'未找到元素：'+(arg||op)}); return; } setTimeout(a,250); })(); }
    function dispatchHover(el){ ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(tp){ try{ el.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window})); }catch(e){} }); }
    try {
      if (op==='wait'){ setTimeout(function(){ resolve({ok:true}); }, parseInt(value||'500',10)||500); return; }
      if (op==='waitText'){ var wt=0; (function w(){ wt++; if((document.body?document.body.innerText:'').indexOf(arg)!==-1){ resolve({ok:true}); return; } if(wt>=32){ resolve({ok:false,error:'未等到文本“'+arg+'”'}); return; } setTimeout(w,300); })(); return; }
      if (op==='hover'){ withRetry(function(){ var el=bySel()||clickByText(arg)||labelControl(arg); if(!el) return false; el.scrollIntoView({block:'center'}); dispatchHover(el); resolve({ok:true}); return true; }); return; }
      if (op==='click'){ withRetry(function(){ var el=bySel()||clickByText(arg); if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); resolve({ok:true}); return true; }); return; }
      if (op==='fill'){ withRetry(function(){ var c=bySel()||labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); resolve({ok:true}); return true; }); return; }
      if (op==='select'){ withRetry(function(){ var c=bySel()||labelControl(arg); if(c && c.tagName==='SELECT'){ for(var i=0;i<c.options.length;i++){ if(c.options[i].text===value||c.options[i].value===value){ c.selectedIndex=i; c.dispatchEvent(new Event('change',{bubbles:true})); break; } } resolve({ok:true}); return true; } var tg=(c||labelTrigger(arg)); if(tg){ tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; } return false; }); return; }
      if (op==='dropdown'){ withRetry(function(){ var tg=bySel()||labelTrigger(arg)||labelControl(arg); if(!tg) return false; tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; }); return; }
      if (op==='searchSelect'){ withRetry(function(){ var c=bySel()||labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); pollClickOption(value, resolve); return true; }); return; }
      resolve({ok:false, error:'未知动作：'+op});
    } catch(err){ resolve({ok:false, error:String(err)}); }
  });
}`

// 定位元素中心坐标，供主进程派发真实指针移动（驱动纯 CSS :hover 菜单）。
const HOVER_LOCATE_FN = `function(arg, sel){
  function vis(n){ return n && n.offsetParent !== null; }
  if (sel){ try{ var es=document.querySelector(sel); if(vis(es)){ try{es.scrollIntoView({block:'center'});}catch(e){} var rs=es.getBoundingClientRect(); var xs=Math.round(rs.left+rs.width/2), ys=Math.round(rs.top+rs.height/2); if(!(xs<1||ys<1||xs>(window.innerWidth-1)||ys>(window.innerHeight-1))) return {ok:true,x:xs,y:ys}; } }catch(e){} }
  var t=(arg||'').trim();
  var sel='button, a, [role=button], [role=menuitem], [role=tab], [aria-haspopup], .ant-menu-item, .el-menu-item, li, span, div';
  var nodes=Array.prototype.slice.call(document.querySelectorAll(sel));
  var own=null, fulls=[];
  for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!vis(n)) continue;
    var o=''; for(var k=0;k<n.childNodes.length;k++){ if(n.childNodes[k].nodeType===3) o+=n.childNodes[k].textContent; }
    o=o.trim(); var f=(n.innerText||'').trim();
    if(o===t){ own=n; break; } if(f===t) fulls.push(n);
  }
  var el=own; if(!el && fulls.length){ fulls.sort(function(a,b){ return a.querySelectorAll('*').length-b.querySelectorAll('*').length; }); el=fulls[0]; }
  if(!el) return {ok:false};
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  var r=el.getBoundingClientRect();
  var x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
  if(x<1||y<1||x>(window.innerWidth-1)||y>(window.innerHeight-1)) return {ok:false,off:true};
  return {ok:true,x:x,y:y};
}`

async function realHover(wc, arg, sel) {
  let loc = null
  try { loc = await wc.executeJavaScript(`(${HOVER_LOCATE_FN})(${JSON.stringify(arg)}, ${JSON.stringify(sel || '')})`) } catch (_) {}
  if (loc && loc.ok) {
    try { wc.sendInputEvent({ type: 'mouseMove', x: loc.x, y: loc.y }); await sleep(80); wc.sendInputEvent({ type: 'mouseMove', x: loc.x, y: loc.y }) } catch (_) {}
  }
  let syn = null
  try { syn = await wc.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify({ op: 'hover', arg, value: '', sel: sel || '' })})`) } catch (_) {}
  await sleep(350)
  return ((loc && loc.ok) || (syn && syn.ok)) ? { ok: true } : { ok: false, error: (syn && syn.error) || '未找到悬停目标' }
}

// 抓取页面可交互元素清单（自愈智能体看页面用）
const SNAPSHOT_FN = `function(){
  function vis(n){ try{ var r=n.getBoundingClientRect(); return n.offsetParent!==null && r.width>1 && r.height>1; }catch(e){ return false; } }
  function sel(el){
    try{ if(el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id); }catch(e){}
    var attrs=['data-id','data-testid','data-name','name','aria-label'];
    for(var i=0;i<attrs.length;i++){ var v=el.getAttribute&&el.getAttribute(attrs[i]); if(v){ var s='['+attrs[i]+'=\"'+String(v).replace(/\"/g,'')+'\"]'; try{ if(document.querySelectorAll(s).length===1) return s; }catch(e){} } }
    var parts=[], e=el;
    while(e && e.nodeType===1 && e.tagName!=='HTML' && parts.length<7){ var t=e.tagName.toLowerCase(); var p=e.parentElement; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===e.tagName;}); if(sib.length>1) t+=':nth-of-type('+(sib.indexOf(e)+1)+')'; } parts.unshift(t); e=p; }
    return parts.join(' > ');
  }
  var nodes=Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=menuitem],[role=tab],[role=option],[onclick],.ant-btn,.ant-menu-item,li[role],[class*=btn],.ant-modal-close,.ant-modal-footer button'));
  var out=[], seen={};
  for(var i=0;i<nodes.length && out.length<60;i++){ var n=nodes[i]; if(!vis(n)) continue;
    var text=(n.innerText||n.value||(n.getAttribute&&n.getAttribute('placeholder'))||(n.getAttribute&&n.getAttribute('aria-label'))||'').replace(/\\s+/g,' ').trim().slice(0,40);
    var tag=n.tagName.toLowerCase();
    if(!text && tag!=='input' && tag!=='textarea' && tag!=='select') continue;
    var s=sel(n); if(seen[s]) continue; seen[s]=1;
    out.push({ tag:tag, role:(n.getAttribute&&n.getAttribute('role'))||'', text:text, sel:s });
  }
  return out;
}`

// 经企业模型中转站做一次决策
async function callRelay(adminBaseUrl, prompt) {
  const base = (adminBaseUrl || '').replace(/\/$/, '')
  const res = await fetch(`${base}/api/v1/model/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-corp-default-key' },
    body: JSON.stringify({ model: 'corp-default', messages: [{ role: 'user', content: prompt }] })
  })
  if (!res.ok) throw new Error('relay ' + res.status)
  const data = await res.json()
  return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
}

const PAGE_SETTLE_FN = `function(maxMs){
  return new Promise(function(res){
    var start=Date.now(), lastMut=Date.now();
    var LOAD='.ant-spin-spinning, .ant-spin-dot, .el-loading-mask, .loading, .spinner, [class*=loading]:not([class*=loaded])';
    var mo=null; try{ mo=new MutationObserver(function(){ lastMut=Date.now(); }); if(document.body) mo.observe(document.body,{childList:true,subtree:true,attributes:true}); }catch(e){}
    function loading(){
      try{ if(document.querySelector(LOAD)) return true; }catch(e){}
      try{ var t=document.body?document.body.innerText:''; if(t.indexOf('努力加载中')!==-1||t.indexOf('加载中...')!==-1) return true; }catch(e){}
      return false;
    }
    (function check(){
      var now=Date.now();
      if(document.readyState==='complete' && !loading() && (now-lastMut)>500){ if(mo)mo.disconnect(); res({settled:true,ms:now-start}); return; }
      if(now-start>maxMs){ if(mo)mo.disconnect(); res({settled:false,ms:now-start}); return; }
      setTimeout(check,200);
    })();
  });
}`
async function settlePage(wc, maxMs) { try { await wc.executeJavaScript(`(${PAGE_SETTLE_FN})(${maxMs || 9000})`) } catch (_) {} }

async function execStep(wc, step) {
  if (step.op === 'hover') return realHover(wc, step.arg, step.sel)
  try { return await wc.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify(step)})`) } catch (e) { return { ok: false, error: e.message } }
}

async function selfHeal(wc, adminBaseUrl, procedure, step, log) {
  if (!adminBaseUrl) return { ok: false, reason: '未配置管理端地址，无法自愈' }
  for (let round = 0; round < 3; round++) {
    let els = []
    try { els = await wc.executeJavaScript(`(${SNAPSHOT_FN})()`) } catch (_) {}
    if (!els.length) { await sleep(800); continue }
    const list = els.map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`).join('\n')
    const intent = `${step.op}${step.arg ? ' “' + step.arg + '”' : ''}${step.value ? ' 值=' + step.value : ''}`
    const prompt = `你在浏览器里执行一个业务自动化技能。整体标准流程(SOP)/脚本如下：\n${String(procedure || '').slice(0, 1500)}\n\n当前要完成的这一步意图：${intent}\n但按录制的定位没有找到目标。下面是当前页面"可交互元素"清单（带编号）：\n${list}\n\n请决定如何完成这一步。规则：\n- 若有遮挡弹窗（权限提示/确认框/引导层）挡住目标，先选关闭它的元素（如"我知道了"/"确定"/关闭），并设 completed=false。\n- 若能直接完成这一步，选对应元素并设 completed=true；需要填值时给 value。\n- 若确实无法完成（如无权限、目标不存在），action 用 "stop" 并在 reason 说明。\n只输出严格 JSON：{"action":"click|fill|select|hover|stop","index":<编号或-1>,"value":"<可选>","completed":true|false,"reason":"<简述>"}`
    let d = null
    try { const out = await callRelay(adminBaseUrl, prompt); const s = (out || '').replace(/```json/g, '').replace(/```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) d = JSON.parse(s.slice(a, b + 1)) } catch (_) {}
    if (!d) return { ok: false, reason: '自愈决策解析失败' }
    const tgt = (typeof d.index === 'number' && d.index >= 0 && els[d.index]) ? els[d.index] : null
    if (log) log({ heal: true, action: d.action, text: tgt ? tgt.text : '', reason: d.reason })
    if (d.action === 'stop') return { ok: false, reason: d.reason || '智能体判定无法继续' }
    if (!tgt) return { ok: false, reason: '自愈未指定有效元素' }
    await execStep(wc, { op: d.action, arg: '', value: d.value || '', sel: tgt.sel })
    await sleep(700)
    if (d.completed) return { ok: true }
    const rr = await execStep(wc, step)
    if (rr && rr.ok) return { ok: true }
  }
  return { ok: false, reason: '多轮自愈仍未完成' }
}

let dryRunWin = null
function toolSend(channel, payload) { if (toolWin && !toolWin.isDestroyed()) toolWin.webContents.send(channel, payload) }

ipcMain.handle('skill:dry-run', async (_e, { systemId, baseUrl, systemName, dsl, fieldValues, adminBaseUrl }) => {
  return new Promise((resolve) => {
    if (dryRunWin && !dryRunWin.isDestroyed()) { try { dryRunWin.close() } catch (_) {} }
    const steps = parseDsl(dsl)
    const win = new BrowserWindow({ show: true, width: 1280, height: 860, title: `试运行 · ${systemName || ''}`, webPreferences: { partition: `persist:rec-${systemId}` } })
    dryRunWin = win
    let settled = false
    const finish = (res) => { if (settled) return; settled = true; resolve(res) } // 不关闭窗口，FDE 自行查看结果
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2500)
        const pre = await win.webContents.executeJavaScript(`(function(){return {text:(document.body?document.body.innerText:'').slice(0,1500)}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          toolSend('dryrun:step', { i: -1, ok: false, desc: '未登录', error: '目标系统未登录' })
          finish({ ok: true, loggedIn: false, done: 0, total: steps.length }); return
        }
        let done = 0
        let prevOp = ''
        for (let i = 0; i < steps.length; i++) {
          const value = resolveDslValue(steps[i].valueExpr, fieldValues || {})
          const step = { op: steps[i].op, arg: steps[i].arg, value, sel: steps[i].sel || '' }
          const desc = `${step.op}${step.arg ? ' 「' + step.arg + '」' : ''}${value ? ' = ' + value : ''}`
          if (prevOp === 'click' || prevOp === 'hover') { toolSend('dryrun:step', { i, total: steps.length, desc: '等待页面加载稳定…', running: true }); await settlePage(win.webContents) }
          toolSend('dryrun:step', { i, total: steps.length, desc, running: true })
          let r = await execStep(win.webContents, step)
          if (!r || !r.ok) {
            toolSend('dryrun:step', { i, total: steps.length, desc: desc + '（按录制未命中，智能自愈中…）', running: true })
            const h = await selfHeal(win.webContents, adminBaseUrl, dsl, step, (ev) => toolSend('dryrun:step', { i, total: steps.length, desc: `自愈 ${ev.action} ${ev.text ? '「' + ev.text + '」' : ''} — ${ev.reason || ''}`, running: true }))
            r = h.ok ? { ok: true } : { ok: false, error: h.reason || (r && r.error) }
          }
          toolSend('dryrun:step', { i, total: steps.length, desc, ok: !!(r && r.ok), error: r && r.error })
          if (!r || !r.ok) { finish({ ok: true, loggedIn: true, done, total: steps.length, failedAt: i, error: r && r.error }); return }
          done++; prevOp = step.op; await sleep(500)
        }
        finish({ ok: true, loggedIn: true, done, total: steps.length, failedAt: -1 })
      } catch (e) { finish({ ok: false, error: e.message }) }
    })
    win.webContents.once('did-fail-load', (_e, c, d) => finish({ ok: false, error: `页面加载失败(${c}): ${d}` }))
    win.on('closed', () => { if (dryRunWin === win) dryRunWin = null })
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => finish({ ok: false, error: '试运行总超时（120秒）' }), 120000)
  })
})

ipcMain.handle('skill:dry-run-close', async () => {
  if (dryRunWin && !dryRunWin.isDestroyed()) { try { dryRunWin.close() } catch (_) {} }
  dryRunWin = null
  return { ok: true }
})

// =====================================================================
// 桌面自动化技能构建：uiohook-napi 全局录制 + nut-js 回放（原生可选依赖，懒加载）
// =====================================================================
let deskSteps = []
let deskHookOn = false

function loadDesktopNative() {
  const res = { uiohook: null, nut: null, errors: [] }
  try { res.uiohook = require('uiohook-napi') } catch (e) { res.errors.push('uiohook-napi（全局输入录制）') }
  try { res.nut = require('@nut-tree-fork/nut-js') } catch (e) { res.errors.push('@nut-tree-fork/nut-js（桌面回放）') }
  return res
}

ipcMain.handle('desktop:check', async () => {
  const nat = loadDesktopNative()
  return {
    recordReady: !!nat.uiohook,
    replayReady: !!nat.nut,
    platform: process.platform,
    missing: nat.errors,
    permissionNote: process.platform === 'darwin'
      ? 'macOS 需在「系统设置 → 隐私与安全性 → 辅助功能」中授权本应用，才能录制全局输入与模拟操作。'
      : ''
  }
})

ipcMain.handle('desktop:record-start', async () => {
  const nat = loadDesktopNative()
  if (!nat.uiohook) return { ok: false, error: '未安装 ' + nat.errors.join('、') + '。请在工具目录执行 npm install 后重试。' }
  try {
    const { uIOhook, UiohookKey } = nat.uiohook
    const KEYNAME = {}; Object.keys(UiohookKey || {}).forEach(k => { KEYNAME[UiohookKey[k]] = k })
    deskSteps = []; deskHookOn = true
    let typeBuf = ''; let shift = false; const mod = { Meta: false, Ctrl: false, Alt: false }
    const push = (st) => { deskSteps.push(st); toolSend('desktop:step', st) }
    const flush = () => { if (typeBuf) { push({ op: 'type', value: typeBuf }); typeBuf = '' } }
    const PRINTABLE = /^[A-Za-z0-9]$/
    const SPECIAL = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Space: 'Space', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

    uIOhook.removeAllListeners && uIOhook.removeAllListeners()
    uIOhook.on('mousedown', (e) => { flush(); const op = e.button === 2 ? 'rightClick' : (e.clicks === 2 ? 'doubleClick' : 'click'); push({ op, x: e.x, y: e.y }) })
    uIOhook.on('keydown', (e) => {
      const name = KEYNAME[e.keycode] || ''
      if (/^(Shift)/.test(name)) { shift = true; return }
      if (/^(Meta|Cmd)/.test(name)) { mod.Meta = true; return }
      if (/^(Ctrl|Control)/.test(name)) { mod.Ctrl = true; return }
      if (/^(Alt|Option)/.test(name)) { mod.Alt = true; return }
      const activeMod = mod.Meta ? 'cmd' : mod.Ctrl ? 'ctrl' : mod.Alt ? 'alt' : ''
      if (activeMod && PRINTABLE.test(name)) { flush(); push({ op: 'hotkey', value: `${activeMod}+${name.toLowerCase()}` }); return }
      if (SPECIAL[name]) { flush(); push({ op: 'key', value: SPECIAL[name] }); return }
      if (PRINTABLE.test(name)) { typeBuf += shift ? name.toUpperCase() : name.toLowerCase(); return }
    })
    uIOhook.on('keyup', (e) => {
      const name = KEYNAME[e.keycode] || ''
      if (/^(Shift)/.test(name)) shift = false
      else if (/^(Meta|Cmd)/.test(name)) mod.Meta = false
      else if (/^(Ctrl|Control)/.test(name)) mod.Ctrl = false
      else if (/^(Alt|Option)/.test(name)) mod.Alt = false
    })
    uIOhook.start()
    return { ok: true }
  } catch (e) { deskHookOn = false; return { ok: false, error: e.message } }
})

ipcMain.handle('desktop:record-stop', async () => {
  const nat = loadDesktopNative()
  try { if (nat.uiohook && deskHookOn) { nat.uiohook.uIOhook.stop() } } catch (_) {}
  deskHookOn = false
  return { ok: true, steps: deskSteps.slice() }
})

ipcMain.handle('desktop:record-cancel', async () => {
  const nat = loadDesktopNative()
  try { if (nat.uiohook && deskHookOn) { nat.uiohook.uIOhook.stop() } } catch (_) {}
  deskHookOn = false; deskSteps = []
  return { ok: true }
})

function parseDesktopDsl(code) {
  const out = []
  for (const raw of (code || '').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue
    let m
    if ((m = line.match(/^(move|click|doubleClick|rightClick)\s+(-?\d+)[ ,]+(-?\d+)/))) { out.push({ op: m[1], x: +m[2], y: +m[3] }); continue }
    if ((m = line.match(/^(type|key|hotkey)\s+"([^"]*)"/))) { out.push({ op: m[1], value: m[2] }); continue }
    if ((m = line.match(/^wait\s+(\d+)/))) { out.push({ op: 'wait', value: m[1] }); continue }
  }
  return out
}
function resolveDesktopValue(v, fv) {
  return String(v || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, n) => (fv && fv[n] !== undefined ? fv[n] : ''))
}

ipcMain.handle('desktop:dry-run', async (_e, { dsl, fieldValues }) => {
  const nat = loadDesktopNative()
  if (!nat.nut) return { ok: false, error: '未安装 ' + (nat.errors.join('、') || '@nut-tree-fork/nut-js') + '。请在工具目录执行 npm install 后重试。' }
  const { mouse, keyboard, Point, Button, Key } = nat.nut
  try { mouse.config.autoDelayMs = 80; keyboard.config.autoDelayMs = 8 } catch (_) {}
  const mapKey = (tok) => {
    const t = tok.trim().toLowerCase()
    if (t === 'cmd' || t === 'meta' || t === 'win') return Key.LeftSuper !== undefined ? Key.LeftSuper : Key.LeftCmd
    if (t === 'ctrl' || t === 'control') return Key.LeftControl
    if (t === 'alt' || t === 'option') return Key.LeftAlt
    if (t === 'shift') return Key.LeftShift
    return Key[t.toUpperCase()]
  }
  const steps = parseDesktopDsl(dsl)
  let done = 0
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const desc = s.op + (s.x !== undefined ? ` ${s.x},${s.y}` : s.value ? ` "${resolveDesktopValue(s.value, fieldValues)}"` : '')
    toolSend('dryrun:step', { i, total: steps.length, desc, running: true })
    try {
      if (s.op === 'wait') { await sleep(parseInt(s.value, 10) || 500) }
      else if (s.op === 'move') { await mouse.setPosition(new Point(s.x, s.y)) }
      else if (s.op === 'click') { await mouse.setPosition(new Point(s.x, s.y)); await mouse.leftClick() }
      else if (s.op === 'doubleClick') { await mouse.setPosition(new Point(s.x, s.y)); await mouse.doubleClick(Button.LEFT) }
      else if (s.op === 'rightClick') { await mouse.setPosition(new Point(s.x, s.y)); await mouse.rightClick() }
      else if (s.op === 'type') { await keyboard.type(resolveDesktopValue(s.value, fieldValues)) }
      else if (s.op === 'key') { const k = Key[s.value]; if (k === undefined) throw new Error('未知按键 ' + s.value); await keyboard.pressKey(k); await keyboard.releaseKey(k) }
      else if (s.op === 'hotkey') { const ks = s.value.split('+').map(mapKey).filter(k => k !== undefined); if (!ks.length) throw new Error('无法解析组合键 ' + s.value); await keyboard.pressKey(...ks); await keyboard.releaseKey(...ks.reverse()) }
      toolSend('dryrun:step', { i, total: steps.length, desc, ok: true })
      done++
    } catch (err) {
      toolSend('dryrun:step', { i, total: steps.length, desc, ok: false, error: err.message })
      return { ok: true, ran: true, done, total: steps.length, failedAt: i, error: err.message }
    }
    await sleep(250)
  }
  return { ok: true, ran: true, done, total: steps.length, failedAt: -1 }
})
