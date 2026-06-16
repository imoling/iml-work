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
  function emit(step){ try { console.log('__REC__'+JSON.stringify(step)); } catch(e){} }
  var OPT_SEL = '.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item';
  function optionTexts(container){ var r=[]; if(!container) return r; var ns=container.querySelectorAll('.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], option, .dropdown-item'); for(var i=0;i<ns.length;i++){ var t=(ns[i].innerText||ns[i].textContent||'').trim(); if(t && r.indexOf(t)===-1) r.push(t); } return r.slice(0,60); }
  document.addEventListener('click', function(e){
    var el = e.target; if(!el || el.nodeType!==1) return;
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
ipcMain.handle('admin:save-skill', async (_e, { adminBaseUrl, name, triggerKeywords, targetSystemId, steps, fields }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const body = { name, triggerKeywords: triggerKeywords || [], targetSystemId: targetSystemId || '', steps: steps || [], fields: fields || [] }
    const res = await fetch(`${base}/api/v1/skills/from-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, skill: await res.json() }
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
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let m
    if ((m = line.match(/^wait\s+(\d+)/i))) { out.push({ op: 'wait', arg: '', valueExpr: m[1] }); continue }
    if ((m = line.match(/^waitText\s+"([^"]*)"/i))) { out.push({ op: 'waitText', arg: m[1], valueExpr: '' }); continue }
    if ((m = line.match(/^(\w+)\s+"([^"]*)"\s*(?:=\s*(.+))?$/))) { out.push({ op: m[1], arg: m[2], valueExpr: (m[3] || '').trim() }); continue }
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
      var exact=null, partial=null;
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue;
        var own=''; for(var k=0;k<n.childNodes.length;k++){ if(n.childNodes[k].nodeType===3) own+=n.childNodes[k].textContent; }
        own=own.trim(); var full=(n.innerText||'').trim();
        if(own===t || full===t){ exact=n; break; }
        if(!partial && t && full.indexOf(t)!==-1 && full.length < t.length+12) partial=n;
      }
      return exact||partial;
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
    try {
      if (op==='wait'){ setTimeout(function(){ resolve({ok:true}); }, parseInt(value||'500',10)||500); return; }
      if (op==='waitText'){ var wt=0; (function w(){ wt++; if((document.body?document.body.innerText:'').indexOf(arg)!==-1){ resolve({ok:true}); return; } if(wt>=32){ resolve({ok:false,error:'未等到文本“'+arg+'”'}); return; } setTimeout(w,300); })(); return; }
      if (op==='click'){ withRetry(function(){ var el=clickByText(arg); if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); resolve({ok:true}); return true; }); return; }
      if (op==='fill'){ withRetry(function(){ var c=labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); resolve({ok:true}); return true; }); return; }
      if (op==='select'){ withRetry(function(){ var c=labelControl(arg); if(c && c.tagName==='SELECT'){ for(var i=0;i<c.options.length;i++){ if(c.options[i].text===value||c.options[i].value===value){ c.selectedIndex=i; c.dispatchEvent(new Event('change',{bubbles:true})); break; } } resolve({ok:true}); return true; } var tg=labelTrigger(arg); if(tg){ tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; } return false; }); return; }
      if (op==='dropdown'){ withRetry(function(){ var tg=labelTrigger(arg)||labelControl(arg); if(!tg) return false; tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; }); return; }
      if (op==='searchSelect'){ withRetry(function(){ var c=labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); pollClickOption(value, resolve); return true; }); return; }
      resolve({ok:false, error:'未知动作：'+op});
    } catch(err){ resolve({ok:false, error:String(err)}); }
  });
}`

let dryRunWin = null
function toolSend(channel, payload) { if (toolWin && !toolWin.isDestroyed()) toolWin.webContents.send(channel, payload) }

ipcMain.handle('skill:dry-run', async (_e, { systemId, baseUrl, systemName, dsl, fieldValues }) => {
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
        for (let i = 0; i < steps.length; i++) {
          const value = resolveDslValue(steps[i].valueExpr, fieldValues || {})
          const step = { op: steps[i].op, arg: steps[i].arg, value }
          const desc = `${step.op}${step.arg ? ' 「' + step.arg + '」' : ''}${value ? ' = ' + value : ''}`
          toolSend('dryrun:step', { i, total: steps.length, desc, running: true })
          const r = await win.webContents.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify(step)})`)
          toolSend('dryrun:step', { i, total: steps.length, desc, ok: !!(r && r.ok), error: r && r.error })
          if (!r || !r.ok) { finish({ ok: true, loggedIn: true, done, total: steps.length, failedAt: i, error: r && r.error }); return }
          done++; await sleep(600)
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
