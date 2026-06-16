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
    width: 760, height: 720, title: 'iML Work 实操录制工具',
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
