// 浏览器/桌面自动化：注入到业务系统页面执行的 JS 脚本常量（纯字符串，无 TS 依赖）。
// 由 main.ts 的回放/录制/截图引擎通过 executeJavaScript 调用。
// 下拉近似匹配算法唯一来源在 select-match-core（主进程 import、此处 toString 嵌入——同一实现零漂移）。
// 注意：脚本内的空 catch 是选择器/DOM 探测的控制流（无效选择器抛错=换下一策略），
// 页面上下文拿不到主进程 swallow()，属「空 catch 禁令」的既定豁免，勿机械改写。

import { FUZZY_PICK_SRC } from './select-match-core'

export const VISIT_FILL_FN = `function(items){
  function setNativeValue(el, value){
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function norm(s){ return (s || '').replace(/[\\s*：:]/g, ''); }
  var filled = [], missing = [];
  items.forEach(function(it){
    var target = norm(it.label), value = it.value, done = false;
    var labels = Array.prototype.slice.call(document.querySelectorAll('label, .ant-form-item-label, .el-form-item__label, .form-label, dt, th'));
    for (var i = 0; i < labels.length && !done; i++){
      if (norm(labels[i].innerText).indexOf(target) === -1) continue;
      var scope = labels[i].closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li') || labels[i].parentElement;
      var ctrl = scope ? scope.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea') : null;
      if (!ctrl && labels[i].htmlFor) ctrl = document.getElementById(labels[i].htmlFor);
      if (ctrl){ try { ctrl.focus(); setNativeValue(ctrl, value); filled.push(it.label); done = true; } catch(e){} }
    }
    if (!done){
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]), textarea'));
      for (var j = 0; j < inputs.length && !done; j++){
        var hint = (inputs[j].placeholder || '') + (inputs[j].getAttribute('aria-label') || '');
        if (hint && hint.indexOf(it.label) !== -1){ try { inputs[j].focus(); setNativeValue(inputs[j], value); filled.push(it.label); done = true; } catch(e){} }
      }
    }
    if (!done) missing.push(it.label);
  });
  return { filled: filled, missing: missing };
}`

export const RECORDER_BOOTSTRAP = `(function(){
  if (window.__recInstalled) return; window.__recInstalled = true;
  var __imlTop=true; try{ __imlTop=(window.top===window.self); }catch(e){ __imlTop=false; }   // 浮层只在顶层 frame 建，避免每个 iframe 各造一个
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
  function anchorOf(el){
    var a=['data-id','data-testid','data-name','data-test'], e=el;
    while(e && e.nodeType===1 && e.tagName!=='HTML'){
      if(e.id && uniq('#'+esc(e.id))) return {sel:'#'+esc(e.id), el:e};
      for(var i=0;i<a.length;i++){ var v=e.getAttribute && e.getAttribute(a[i]); if(v){ var s='['+a[i]+'="'+v.replace(/"/g,'\\\\"')+'"]'; if(uniq(s)) return {sel:s, el:e}; } }
      e=e.parentElement;
    }
    return null;
  }
  function relPath(el, stop){
    var parts=[], cur=el;
    while(cur && cur.nodeType===1 && cur!==stop && cur.tagName!=='HTML' && parts.length<8){
      var tag=cur.tagName.toLowerCase(); var p=cur.parentElement;
      if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===cur.tagName;}); if(sib.length>1) tag+=':nth-of-type('+(sib.indexOf(cur)+1)+')'; }
      parts.unshift(tag); cur=p;
    }
    return parts.join(' > ');
  }
  function robust(el){
    if (el.id && uniq('#'+esc(el.id))) return '#'+esc(el.id);
    var attrs = ['data-testid','data-test','data-id','data-name','name','aria-label'];
    for (var i=0;i<attrs.length;i++){ var v=el.getAttribute && el.getAttribute(attrs[i]); if(v){ var s='['+attrs[i]+'="'+v.replace(/"/g,'\\\\"')+'"]'; if(uniq(s)) return s; if(uniq(el.tagName.toLowerCase()+s)) return el.tagName.toLowerCase()+s; } }
    var an=anchorOf(el);                                  // 锚定到最近的稳定祖先(唯一 id/data-*)，相对它生成路径，远比无锚 nth 路径可靠
    if(an){ var rp=relPath(el, an.el); return rp ? an.sel+' > '+rp : an.sel; }
    return cssPath(el);
  }
  function labelOf(el){
    if (el.id){ var l=document.querySelector('label[for="'+esc(el.id)+'"]'); if(l) return (l.innerText||'').trim(); }
    var ch = colHeader(el); if (ch) return ch;   // 数据表格单元格里的控件：优先所在列表头（讯飞"类型/原因说明"列内输入框；tr 兜底会误抓行首文本）
    var box = el.closest && el.closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li');
    if (box){ var lab = box.querySelector('label, .ant-form-item-label, .el-form-item__label, dt, th'); if(lab) return (lab.innerText||'').trim(); }
    return (el.getAttribute && (el.getAttribute('aria-label')||el.placeholder)) || (el.innerText||'').trim().slice(0,30);
  }
  // 控件所在表格列的表头文本：td 在行内的下标 → 表头行同下标单元格。抓不到/过长返回空。
  function colHeader(el){
    try{
      var td = el.closest && el.closest('td'); if(!td) return '';
      var tr = td.parentElement; var table = td.closest && td.closest('table'); if(!table||!tr) return '';
      var idx = Array.prototype.indexOf.call(tr.children, td);
      var hrow = (table.tHead && table.tHead.rows[0]) || table.querySelector('tr');
      if(!hrow || hrow===tr || idx<0 || idx>=hrow.children.length) return '';
      var t = (hrow.children[idx].innerText||'').replace(/\s+/g,' ').trim();
      return (t && t.length<=12) ? t : '';
    }catch(e){ return ''; }
  }
  // 行内容摘要：点表格行（勾选/选记录）时 label 常为空——取行内前几个短单元格文本（如日期/时间），
  // 让 AI 转译知道"点的是哪条记录"（选日期行 → 参数化 {{日期}}）。
  function rowSummary(el){
    try{
      var tr = el.closest && el.closest('tr'); if(!tr) return '';
      var tds = tr.querySelectorAll('td'); var out=[];
      for(var i=0;i<tds.length&&out.length<3;i++){ var t=(tds[i].innerText||'').replace(/\s+/g,' ').trim(); if(t&&t.length<=20) out.push(t); }
      return out.join(' ');
    }catch(e){ return ''; }
  }
  function emit(step){ try { if(step.label) step.label=String(step.label).replace(/\\s+/g,' ').trim(); console.log('__REC__'+JSON.stringify(step)); } catch(e){} }
  var OPT_SEL = '.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item';
  function optionTexts(container){ var r=[]; if(!container) return r; var ns=container.querySelectorAll('.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], option, .dropdown-item'); for(var i=0;i<ns.length;i++){ var t=(ns[i].innerText||ns[i].textContent||'').trim(); if(t && r.indexOf(t)===-1) r.push(t); } return r.slice(0,60); }
  function __menuSig(){
    var ms; try{ ms=document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden), .ant-menu-submenu-popup, [role=menu], [role=listbox], .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-popover:not(.ant-popover-hidden), [class*=submenu], [class*=sub-menu], [class*=dropdown-menu], [class*=popover], [class*=flyout], [class*=fly-out], [class*=secondary-menu], [class*=second-menu], [class*=expand], [class*=panel-pop], [class*=menu-pop]'); }catch(e){ return 0; }
    var c=0; for(var i=0;i<ms.length;i++){ if(ms[i].offsetParent!==null) c++; } return c;
  }
  var __hoverTimer=null, __lastHover=null;
  document.addEventListener('mouseover', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return;
    if(el.closest && el.closest('#__iml_rec_bar')) return;   // 浮层自身悬停不记
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
    if(el.closest && el.closest('#__iml_rec_bar')) return;   // 录制监控浮层自身的点击不记
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
    var lbl = (t.innerText||t.getAttribute('aria-label')||'').trim().slice(0,40);
    if (!lbl) lbl = rowSummary(el).slice(0,40);   // 点表格行（勾选/选记录）常无自身文本 → 用行内容摘要（AI 转译据此识别"选的哪条记录"）
    emit({ action:'click', selector: robust(t), value:'', label: lbl, tag:(t.tagName||'').toLowerCase(), url: location.href });
  }, true);
  document.addEventListener('change', function(e){
    var el = e.target; if(!el || el.nodeType!==1) return;
    if(el.closest && el.closest('#__iml_rec_bar')) return;   // 浮层自身变更不记
    var tag = (el.tagName||'').toLowerCase();
    if (tag === 'select'){
      var txt = el.options && el.selectedIndex>=0 ? el.options[el.selectedIndex].text : el.value;
      var opts = []; if (el.options){ for (var i=0;i<el.options.length;i++){ var ot2=(el.options[i].text||'').trim(); if(ot2 && el.options[i].value !== '') opts.push(ot2); } }
      emit({ action:'select', selector: robust(el), value: txt, label: labelOf(el), tag: tag, url: location.href, options: opts });
    } else if (tag === 'input' || tag === 'textarea'){
      if (el.type === 'checkbox' || el.type === 'radio') return;
      // 记下 DOM 的 input type（date/number/email…）——确认卡据此渲染同款控件（日期给日期选择器，
      // 而不是让人手敲 2026-07-13）。只记 tag 的话，日期框会被一律降级成纯文本框。
      emit({ action:'fill', selector: robust(el), value: el.value || '', label: labelOf(el), tag: tag, inputType: (tag==='input' ? (el.type||'text') : 'textarea'), url: location.href });
    }
  }, true);
  // ===== 录制监控浮层：红点「正在录制」+ 实时步数 + 结束/取消按钮，直接在录制窗口里操作，不用切回主窗 =====
  function __imlEnsureBar(){
    try {
      if (!__imlTop) return;                                   // 只顶层 frame 显示浮层
      if (document.getElementById('__iml_rec_bar')) return;
      var host = document.body || document.documentElement; if (!host) return;
      if (!document.getElementById('__iml_rec_style')) {
        var st = document.createElement('style'); st.id='__iml_rec_style';
        st.textContent='@keyframes __imlpulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}70%{box-shadow:0 0 0 7px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}#__iml_rec_bar button:hover{filter:brightness(1.08)}';
        (document.head||host).appendChild(st);
      }
      var bar = document.createElement('div'); bar.id='__iml_rec_bar';
      bar.style.cssText='position:fixed;top:14px;right:14px;z-index:2147483647;background:rgba(17,24,39,.96);color:#fff;padding:9px 10px 9px 13px;border-radius:12px;font:13px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;align-items:center;gap:11px;user-select:none;cursor:grab';
      bar.innerHTML='<span style="display:flex;align-items:center;gap:6px"><span style="width:9px;height:9px;border-radius:50%;background:#ef4444;animation:__imlpulse 1.4s infinite"></span>正在录制</span><span style="opacity:.85">已捕获 <b id="__iml_rec_count" style="color:#34d399">0</b> 步</span><button id="__iml_rec_stop" style="background:#10b981;color:#fff;border:0;border-radius:8px;padding:5px 12px;font-weight:600;cursor:pointer;font-size:13px">结束录制</button><button id="__iml_rec_cancel" style="background:transparent;color:#9ca3af;border:0;cursor:pointer;font-size:12px">取消</button>';
      host.appendChild(bar);
      var drag=false,ox=0,oy=0;
      bar.addEventListener('mousedown', function(e){ if(e.target && e.target.tagName==='BUTTON') return; drag=true; ox=e.clientX-bar.offsetLeft; oy=e.clientY-bar.offsetTop; bar.style.cursor='grabbing'; e.preventDefault(); }, true);
      window.addEventListener('mousemove', function(e){ if(!drag) return; bar.style.left=(e.clientX-ox)+'px'; bar.style.top=(e.clientY-oy)+'px'; bar.style.right='auto'; }, true);
      window.addEventListener('mouseup', function(){ drag=false; bar.style.cursor='grab'; }, true);
      bar.querySelector('#__iml_rec_stop').addEventListener('click', function(e){ e.stopPropagation(); try{ console.log('__REC_STOP__'); }catch(_e){} }, true);
      bar.querySelector('#__iml_rec_cancel').addEventListener('click', function(e){ e.stopPropagation(); try{ console.log('__REC_CANCEL__'); }catch(_e){} }, true);
    } catch(e){}
  }
  // 主进程每记一步会调它推真实累计步数（跨页导航也准）；顺带确保浮层还在（SPA 换 body 后重建）。
  window.__imlRecTick = function(n){ try { __imlEnsureBar(); if(n!=null){ var c=document.getElementById('__iml_rec_count'); if(c) c.textContent=String(n); } } catch(e){} };
  // 1s 轻量轮询自愈：SPA 换 body/首屏未就绪都会把浮层冲掉——每秒确保它还在（idempotent，有则秒返回）。
  // 只在顶层 frame 起一个计时器；录制窗关闭时随之销毁。
  if (__imlTop) { __imlEnsureBar(); try { setInterval(__imlEnsureBar, 1000); } catch(e){} }
})();`

// 注入到「系统连接」登录窗口的浮层：一句提示 + 「我已登录，检测」+ 「取消」。
// 登完在窗口里点检测（经 console 通道 __LOGIN_CHECK__ 通知主进程），检测通过就关窗，不用切回设置页。
// window.__imlLoginStatus(msg) 供主进程回写状态（如"似乎还没登录"）。
export const LOGIN_MONITOR_FN = `(function(){
  if (window.__imlLoginBar) return; window.__imlLoginBar = true;
  function mk(){
    try {
      if (document.getElementById('__iml_login_bar')) return;
      var host = document.body || document.documentElement; if(!host) return;
      var bar = document.createElement('div'); bar.id='__iml_login_bar';
      bar.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:2147483647;background:rgba(17,24,39,.97);color:#fff;padding:11px 12px 11px 15px;border-radius:12px;font:13px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4);display:flex;align-items:center;gap:12px';
      bar.innerHTML='<span id="__iml_login_msg" style="opacity:.92">请在此窗口完成登录，登录后点右侧</span><button id="__iml_login_ok" style="background:#10b981;color:#fff;border:0;border-radius:8px;padding:6px 14px;font-weight:600;cursor:pointer;font-size:13px">我已登录，检测</button><button id="__iml_login_cancel" style="background:transparent;color:#9ca3af;border:0;cursor:pointer;font-size:12px">取消</button>';
      host.appendChild(bar);
      bar.querySelector('#__iml_login_ok').addEventListener('click', function(e){ e.stopPropagation(); var m=document.getElementById('__iml_login_msg'); if(m) m.textContent='检测中…'; try{ console.log('__LOGIN_CHECK__'); }catch(_e){} });
      bar.querySelector('#__iml_login_cancel').addEventListener('click', function(e){ e.stopPropagation(); try{ console.log('__LOGIN_CANCEL__'); }catch(_e){} });
    } catch(e){}
  }
  window.__imlLoginStatus = function(msg){ try{ mk(); var el=document.getElementById('__iml_login_msg'); if(el) el.textContent=msg; }catch(e){} };
  mk();
})();`

export const REPLAY_STEP_FN = `function(step){
  return new Promise(function(resolve){
    var tries = 0;
    function setNativeValue(el, value){
      // 只有 input/textarea 有原生 value setter。拿 HTMLInputElement 的 setter 去 call 一个 <label>/<div>
      // 会抛 "TypeError: Illegal invocation"——曾因选择器丢失、退化成按文字找元素而找到 <label>，一填就炸。
      var tn = el && el.tagName;
      if (tn !== 'INPUT' && tn !== 'TEXTAREA') throw new Error('目标不是可填写的输入框（实际是 <' + String(tn||'?').toLowerCase() + '>）');
      var proto = tn === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // 定位到"真正能填的控件"：按文字找元素常常命中 <label>「目的地」而不是它后面的输入框。
    // 顺序：本身就是控件 → label[for] 指向的控件 → 自己内部的控件 → 所在表单项容器里的控件。
    function fillableOf(el){
      if (!el) return null;
      var tn = el.tagName;
      if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return el;
      if (tn === 'LABEL'){
        var f = el.getAttribute('for');
        if (f){ var byFor = document.getElementById(f); if (byFor) return byFor; }
        if (el.control) return el.control;
      }
      var inner = el.querySelector ? el.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select') : null;
      if (inner) return inner;
      var box = el.closest ? el.closest('.form-field, .ant-form-item, .el-form-item, .field, div, td, li') : null;
      var near = box && box.querySelector ? box.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select') : null;
      return near || null;
    }
    var RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li, .next-menu-item';
    function visible(n){ return n && n.offsetParent !== null; }
    var fuzzyPick = (${FUZZY_PICK_SRC});
    function findResult(value){
      var nodes = document.querySelectorAll(RESULT_SEL);
      var exact = null, partial = null, vis = [], visTexts = [];
      for (var i = 0; i < nodes.length; i++){
        var n = nodes[i]; if (!visible(n)) continue;
        var t = (n.innerText || n.textContent || '').trim();
        if (!t) continue;
        vis.push(n); visTexts.push(t);
        if (value && t === value){ exact = n; break; }
        if (!partial && value && t.indexOf(value) !== -1) partial = n;
      }
      if (exact || partial) return exact || partial;
      // 第三档·近似匹配：提炼值（"华东电网项目"）和系统正式名（"华东电网巡检平台二期"）几乎从不全等，
      // 前两档必然失手 → 以前直接判失败、退智能体读页面（多一轮模型调用）。有明显唯一赢家才选，并列不猜。
      var fi = fuzzyPick(value, visTexts);
      return fi >= 0 ? vis[fi] : null;
    }
    function doSearch(el){
      el.focus(); setNativeValue(el, step.value);
      var rtries = 0;
      (function pollResult(){
        rtries++;
        var hit = findResult(step.value);
        if (!hit && step.resultSelector){ try { var rs = document.querySelector(step.resultSelector); if (visible(rs)) hit = rs; } catch(e){} }
        if (hit){ try { hit.scrollIntoView({block:'center'}); hit.click(); resolve({ ok:true }); } catch(e){ resolve({ ok:false, error:String(e) }); } return; }
        if (rtries >= 24){ resolve({ ok:false, error:'检索结果未出现或未匹配到“' + step.value + '”' }); return; }
        setTimeout(pollResult, 300);
      })();
    }
    function doDropdown(el){
      var pre = findResult(step.value);
      if (pre){ try { pre.scrollIntoView({block:'center'}); pre.click(); resolve({ ok:true }); } catch(e){ resolve({ ok:false, error:String(e) }); } return; }
      if (el){ try { el.scrollIntoView({block:'center'}); el.click(); } catch(e){} }
      var dtries = 0;
      (function pollDD(){
        dtries++;
        var h = findResult(step.value);
        if (h){ try { h.scrollIntoView({block:'center'}); h.click(); resolve({ ok:true }); } catch(e){ resolve({ ok:false, error:String(e) }); } return; }
        if (dtries >= 24){ resolve({ ok:false, error:'下拉项未匹配到“' + step.value + '”' }); return; }
        setTimeout(pollDD, 300);
      })();
    }
    // 按 label 文本定位可点击元素（录制仅捕获到文本、无 selector 时的兜底）。
    function findByText(txt){
      txt = (txt || '').trim(); if (!txt) return null;
      var SEL = 'a, button, [role=button], [role=menuitem], [role=tab], .menu-i, .ant-menu-item, .el-menu-item, li, td, th, label, span, div, input[type=submit], input[type=button]';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(SEL));
      var own = null, fulls = [];
      for (var i = 0; i < nodes.length; i++){
        var n = nodes[i]; if (!visible(n)) continue;
        var o = ''; for (var k = 0; k < n.childNodes.length; k++){ if (n.childNodes[k].nodeType === 3) o += n.childNodes[k].textContent; }
        o = o.trim(); var f = (n.innerText || n.value || '').trim();
        if (o === txt){ own = n; break; } if (f === txt) fulls.push(n);
      }
      var el = own;
      if (!el && fulls.length){ fulls.sort(function(a,b){ return a.querySelectorAll('*').length - b.querySelectorAll('*').length; }); el = fulls[0]; }
      if (!el){ for (var j = 0; j < nodes.length; j++){ var m = nodes[j]; if (!visible(m)) continue; if ((m.innerText || '').trim().indexOf(txt) !== -1){ el = m; break; } } }
      return el;
    }
    function attempt(){
      tries++;
      var action = step.action || step.act || 'click';
      var el = null; try { if (step.selector) el = document.querySelector(step.selector); } catch(e){}
      if (step.kind === 'dropdown'){ doDropdown(el); return; }
      if (!el && step.label) el = findByText(step.label);
      if (!el){
        // optional 步（如「审批意见」——有的系统压根没有意见框）：找不到就跳过，不算失败。
        if (step.optional && tries >= 6){ resolve({ ok:true, skipped:true }); return; }
        if (tries >= 20){ resolve({ ok:false, error:'未找到元素（label=' + (step.label || '') + '）' }); return; }
        setTimeout(attempt, 250); return;
      }
      try {
        if (step.kind === 'search'){ doSearch(el); return; }
        if (action === 'fill' || action === 'select'){
          // 按文字找到的可能是 <label> 而非输入框——先解析成真正能填的控件，再动手。
          var ctl = fillableOf(el);
          if (!ctl){ resolve({ ok:false, error:'「' + (step.label||'') + '」附近没找到可填写的输入框' }); return; }
          if (ctl.tagName === 'SELECT'){
            var matched = false;
            for (var i=0;i<ctl.options.length;i++){ if(ctl.options[i].text===step.value||ctl.options[i].value===step.value){ ctl.selectedIndex=i; ctl.dispatchEvent(new Event('change',{bubbles:true})); matched = true; break; } }
            if (!matched){ resolve({ ok:false, error:'下拉「' + (step.label||'') + '」里没有选项“' + step.value + '”' }); return; }
          } else { ctl.focus(); setNativeValue(ctl, step.value); }
        }
        else { var ct = (el.closest ? (el.closest('a,button,[role=button],[role=menuitem],.menu-i') || el) : el); ct.scrollIntoView({block:'center'}); ct.click(); }
        resolve({ ok:true });
      } catch(err){ resolve({ ok:false, error:String(err) }); }
    }
    attempt();
  });
}`

export const HOVER_LOCATE_FN = `function(arg, sel){
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

export const SEMANTIC_FN = `function(step){
  return new Promise(function(resolve){
    var op=step.op, arg=step.arg, value=step.value;
    function norm(s){ return (s||'').replace(/[\\s*：:]/g,''); }
    function visible(n){ return n && n.offsetParent !== null; }
    function bySel(){ if(!step.sel) return null; try{ var e=document.querySelector(step.sel); return visible(e)?e:null; }catch(_e){ return null; } }
    function locOf(el){ try{ el.scrollIntoView({block:'center'}); }catch(e){} var b=el.getBoundingClientRect(); return {ok:true, found:true, x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2), w:Math.round(b.width), h:Math.round(b.height)}; }
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
      var sel = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select';
      // 优先 label[for] 直绑控件（最精确）：避免容器缺失时作用域退化到 <form> 后误取整表单第一个控件（字段错位根因）。
      if (lb.lab.htmlFor){ var byFor = document.getElementById(lb.lab.htmlFor); if (byFor) return byFor; }
      var scope = lb.box;
      if (scope && (scope.tagName === 'FORM' || scope.tagName === 'BODY')) scope = null;   // 作用域过宽，弃用
      var c = scope ? scope.querySelector(sel) : null;
      // 仍无：从 label 起按文档顺序找紧邻的下一个控件（兜底松散布局）
      if (!c){ var n = lb.lab.nextElementSibling; while (n){ if (n.matches && n.matches(sel)){ c = n; break; } var inner = n.querySelector ? n.querySelector(sel) : null; if (inner){ c = inner; break; } n = n.nextElementSibling; } }
      return c;
    }
    function labelTrigger(label){
      var lb = labelBox(label); if(!lb) return null;
      if (lb.lab.htmlFor){ var byFor = document.getElementById(lb.lab.htmlFor); if (byFor) return byFor; }
      var scope = lb.box;
      if (scope && (scope.tagName === 'FORM' || scope.tagName === 'BODY')) scope = null;
      return scope ? scope.querySelector('.ant-select-selector, .ant-select, [role=combobox], .el-select, .el-input__inner, input:not([type=hidden]), .form-control, .ant-picker') : null;
    }
    function attrControl(label){
      // label 定位兜底：按 placeholder / aria-label / name 匹配控件——应对无规范 label 的真实系统，
      // 以及 agent 直接用 observe 里的 placeholder 文本作 target 的情况（鲁棒性关键）。
      var t = norm(label);
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select'));
      for (var i=0;i<inputs.length;i++){ var el=inputs[i]; if(!visible(el)) continue;
        var hint = norm((el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.name||''));
        if (hint && hint.indexOf(t) !== -1) return el;
      }
      return null;
    }
    function inFloat(n){ var e=n,d=0; while(e&&d<12){ try{ var cs=getComputedStyle(e); if(cs.position==='fixed'||cs.position==='absolute') return true; }catch(_e){} e=e.parentElement; d++; } return false; }   // 12 层：讯飞弹窗结果项嵌套深（li 内还套 3 层 div），6 层够不着定位根
    function belowActive(b, anchorEl){
      // 「刚打完字的输入框正下方」= 候选下拉的普适几何特征（与 absolute/fixed 定位方式无关）。
      // 优先用**显式锚**（调用方传入刚填过的输入框——框架重渲染会把 activeElement 打回 body，锚更稳），缺省退 activeElement。
      try{
        var ae=anchorEl||document.activeElement; if(!ae||!ae.getBoundingClientRect) return false;
        if(!anchorEl && ae.tagName!=='INPUT' && ae.tagName!=='TEXTAREA') return false;
        var ab=ae.getBoundingClientRect(); if(ab.width<2) return false;
        if(b.top<ab.bottom-4||b.top>ab.bottom+320) return false;
        return Math.min(b.right,ab.right+220)-Math.max(b.left,ab.left-60) > 4;
      }catch(e){ return false; }
    }
    function floatSearchControl(){
      // 检索弹窗的搜索框通常**没有 label/placeholder**（label 链全部落空）——取浮层(absolute/fixed)内的空文本输入框。
      // 仅弹窗存在时才可能命中（inFloat 天然守门），作为 fill/searchSelect 的最后兜底。
      var inputs=document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio])');
      for (var i=0;i<inputs.length;i++){ var el=inputs[i]; if(!visible(el)) continue; if((el.value||'').trim()) continue; if(!inFloat(el)) continue; return el; }
      return null;
    }
    function geoControl(label){
      // 几何定位兜底（企业巨型表单：标签是 td/div 文本格、控件在同行右侧格，label/dt/th 那套全找不到）：
      // 找到文本恰好等于标签的可见格 → 同一行（纵向重叠过半）右侧最近的输入框；无则正下方最近。
      var C = norm(label); if(!C) return null;
      var hc=null, cand=document.querySelectorAll('th,td,div,span,label,dt');
      for (var i=0;i<cand.length;i++){ var n=cand[i]; if(!visible(n)) continue; var t=norm(n.innerText); if(!t) continue;
        if(t===C){ hc=n; break; } if(!hc && t.indexOf(C)!==-1 && t.length<=C.length+4) hc=n; }
      if(!hc) return null;
      var hr=hc.getBoundingClientRect(); if(hr.width<2) return null;
      var inputs=document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select');
      var best=null,bestD=1e9;
      for (var k=0;k<inputs.length;k++){ var el=inputs[k]; if(!visible(el)) continue; var b=el.getBoundingClientRect(); if(b.width<2||b.height<2) continue;
        var ov=Math.min(b.bottom,hr.bottom)-Math.max(b.top,hr.top);
        if(ov>Math.min(b.height,hr.height)*0.5 && b.left>=hr.right-4){ var d=b.left-hr.right; if(d<bestD){ bestD=d; best=el; } } }
      if(best) return best;
      for (var m=0;m<inputs.length;m++){ var el2=inputs[m]; if(!visible(el2)) continue; var b2=el2.getBoundingClientRect(); if(b2.width<2||b2.height<2) continue;
        if(b2.top<hr.bottom-4) continue; var cx=(b2.left+b2.right)/2; if(cx<hr.left-8||cx>hr.right+40) continue;
        var d2=b2.top-hr.bottom; if(d2<bestD){ bestD=d2; best=el2; } }
      return best;
    }
    function clickByText(text){
      // 空白归一后再比：门户图标 DOM 文本常是"5\\n考勤维护"（角标+换行+标签），observe 给 agent 的是
      // "5 考勤维护"（空格），不归一则 indexOf 永不命中（实测讯飞门户「考勤维护」图标点不中）。
      function squash(s){ return (s||'').replace(/\\s+/g,''); }
      var T = squash(text);
      // 含 i / [class*=icon] / svg / [onclick] / [class*=btn]：企业门户的删除/减号常是**图标元素**（如 <i>删除</i>、<i class="icon-del">），
      // 不加进来则图标按钮既点不到（实测讯飞OA考勤删除图标点不中 → 删除不生效）。p/dd/dt/label：门户图标的文字标签常是这些标签。
      var sel = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], .ant-btn, .ant-menu-item, .el-button, [onclick], [class*=btn], i, [class*=icon], svg, li, td, span, p, dd, dt, label, div';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      var ownMatch=null, fullMatches=[], partial=null;
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue;
        var own=''; for(var k=0;k<n.childNodes.length;k++){ if(n.childNodes[k].nodeType===3) own+=n.childNodes[k].textContent; }
        own=squash(own); var full=squash(n.innerText);
        if(T && own===T){ ownMatch=n; break; }             // 最佳：自身文本恰好等于目标
        if(T && full===T) fullMatches.push(n);              // 次之：整体文本相等（取最具体/最深的）
        if(!partial && T && full.indexOf(T)!==-1 && full.length < T.length+12) partial=n;
      }
      if (ownMatch) return ownMatch;
      if (fullMatches.length){ fullMatches.sort(function(a,b){ return a.querySelectorAll('*').length - b.querySelectorAll('*').length; }); return fullMatches[0]; }
      return partial;
    }
    var RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li';
    var fuzzyPick2 = (${FUZZY_PICK_SRC});
    function findOption(val, anchorEl){
      var nodes=document.querySelectorAll(RESULT_SEL); var exact=null,partial=null,vis=[],visTexts=[];
      for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue; var tx=(n.innerText||n.textContent||'').trim(); if(!tx) continue;
        vis.push(n); visTexts.push(tx);
        if(val && tx===val){ exact=n; break; } if(!partial && val && tx.indexOf(val)!==-1) partial=n; }
      if(exact||partial) return exact||partial;
      var fi=fuzzyPick2(val, visTexts);   /* 近似档：同上，唯一赢家才选 */
      if(fi>=0) return vis[fi];
      /* 通用浮层兜底：讯飞等自研组件的候选项不带常见类名（审批人弹窗=ul>li、类型弹窗=table tr>td，录制轨迹坐实）。
         精确匹配优先；再放宽为「包含」（审批人结果 li 显示的是部门长串、名字只是其中一段）——取文本最短的匹配（最具体）。
         inFloat 限定浮层内，普通正文里的同名文本（如刚填好的原因说明格）不会被误点。 */
      var vsq=(val||'').replace(/\s+/g,''); if(!vsq) return null;
      var all=document.querySelectorAll('li,td,div,span,a'); var contains=[];
      for(var k=0;k<all.length;k++){ var m=all[k]; if(!visible(m)) continue;
        var mt=(m.innerText||'').replace(/\s+/g,''); if(!mt) continue;
        var okPos = inFloat(m) || belowActive(m.getBoundingClientRect(), anchorEl);   // 浮层内 或 锚输入框正下方（双判据）
        if(!okPos) continue;
        if(mt===vsq) return m;
        if(mt.indexOf(vsq)!==-1 && mt.length<=vsq.length+60) contains.push({n:m,len:mt.length}); }
      if(contains.length){ contains.sort(function(a,b){ return a.len-b.len; }); return contains[0].n; }
      return null;
    }
    function findOptionExact(val, anchorEl){
      // 只认**精确匹配**的候选（fill 后的自动点选用）：宽松匹配交给 search/pollClickOption，
      // fill 的自动补点必须保守——点错候选比不点更糟。
      var vsq=(val||'').replace(/\s+/g,''); if(!vsq) return null;
      var nodes=document.querySelectorAll(RESULT_SEL);
      for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue; if(((n.innerText||'').replace(/\s+/g,''))===vsq) return n; }
      var all=document.querySelectorAll('li,td,div,span,a');
      for(var k=0;k<all.length;k++){ var m=all[k]; if(!visible(m)) continue; if(!(inFloat(m)||belowActive(m.getBoundingClientRect(), anchorEl))) continue; if(((m.innerText||'').replace(/\s+/g,''))===vsq) return m; }
      return null;
    }
    function popDiag(){
      // 候选匹配失败时的弹窗诊断：标准候选/浮层元素/空输入框各几个——把"弹窗到底开没开、里面有什么"暴露给执行日志
      try{
        var a=0,ns=document.querySelectorAll(RESULT_SEL); for(var i=0;i<ns.length;i++){ if(visible(ns[i])) a++; }
        var f=0,all=document.querySelectorAll('li,td,div'); var cap=Math.min(all.length,1500);
        for(var k=0;k<cap;k++){ var n=all[k]; if(!visible(n)) continue; if(inFloat(n) && (n.innerText||'').trim()) f++; }
        var ei=0,ips=document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio])');
        for(var m=0;m<ips.length;m++){ if(visible(ips[m]) && !(ips[m].value||'').trim()) ei++; }
        return '（诊断：标准候选'+a+'个/浮层内含文本元素'+f+'个/空输入框'+ei+'个）';
      }catch(e){ return ''; }
    }
    function clickOpt(h){
      // 选项点击用**完整指针事件序列**：自研下拉/自动补全常在 mousedown 上做选中（blur 前就得命中），
      // 只调 .click() 组件根本不认——看起来点了实际没选中（实测讯飞审批人下拉）。
      try{
        ['pointerdown','mousedown','mouseup','click'].forEach(function(tp){
          try{ h.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window})); }catch(e){}
        });
      }catch(e){ try{ h.click(); }catch(_e){} }
    }
    function pollClickOption(val, done, anchorEl){
      var tries=0; (function p(){ tries++; var h=findOption(val, anchorEl);
        if(h){ try{ h.scrollIntoView({block:'center'}); clickOpt(h); done({ok:true}); }catch(e){ done({ok:false,error:String(e)}); } return; }
        if(tries>=24){ done({ok:false,error:'未匹配到选项“'+val+'”'+popDiag()}); return; } setTimeout(p,300); })();
    }
    function withRetry(fn){ var tries=0; (function a(){ tries++; if(fn()) return; if(tries>=5){ resolve({ok:false,error:'未找到元素：'+(arg||op)}); return; } setTimeout(a,250); })(); }
    function dispatchHover(el){ ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(tp){ try{ el.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window})); }catch(e){} }); }

    try {
      if (op==='locateOption'){ /* 候选项定位（真手路线：主进程拿坐标后 sendInputEvent 真实点击） */
        var lt=0; (function lp(){ lt++; var h=findOption(value); if(h){ resolve(locOf(h)); return; } if(lt>=2){ resolve({ok:false,error:'未见候选'+popDiag()}); return; } setTimeout(lp,250); })(); return; }
      if (op==='wait'){ setTimeout(function(){ resolve({ok:true}); }, parseInt(value||'500',10)||500); return; }
      if (op==='waitText'){ var wt=0; (function w(){ wt++; if((document.body?document.body.innerText:'').indexOf(arg)!==-1){ resolve({ok:true}); return; } if(wt>=32){ resolve({ok:false,error:'未等到文本“'+arg+'”'}); return; } setTimeout(w,300); })(); return; }
      if (op==='hover'){ withRetry(function(){ var el=bySel()||clickByText(arg)||labelControl(arg); if(!el) return false; el.scrollIntoView({block:'center'}); dispatchHover(el); resolve({ok:true}); return true; }); return; }
      if (op==='click'){ withRetry(function(){ var el=bySel(); if(el && arg){ var et=norm(el.innerText||el.textContent||''); if(et && et.indexOf(norm(arg))===-1) el=null; } if(!el) el=clickByText(arg); if(!el) return false; if(step.locateOnly){ resolve(locOf(el)); return true; } el.scrollIntoView({block:'center'}); el.click(); resolve({ok:true}); return true; }); return; }
      if (op==='fill'){ withRetry(function(){ var c=bySel()||labelControl(arg)||attrControl(arg)||geoControl(arg)||floatSearchControl(); if(!c) return false; if(step.locateOnly){ resolve(locOf(c)); return true; } c.focus(); try{ c.click(); }catch(e){} setNativeValue(c,value);
        // 拾取/检索弹窗里"搜索后必须点结果才真正落值"（实测讯飞审批人/类型）：填完短轮询，
        // 出现**精确匹配**候选就自动点中；普通输入框无候选，1.5s 后原样完成，无副作用。
        var ft=0; (function fp(){ ft++; var h=findOptionExact(value, c); if(h){ try{ h.scrollIntoView({block:'center'}); clickOpt(h); }catch(e){} setTimeout(function(){ resolve({ok:true}); },300); return; } if(ft>=10){ resolve({ok:true}); return; } setTimeout(fp,400); })();
        return true; }); return; }
      if (op==='select'){ withRetry(function(){ var c=bySel()||labelControl(arg)||attrControl(arg)||geoControl(arg); if(step.locateOnly){ var t0=c||labelTrigger(arg); if(!t0) return false; resolve(locOf(t0)); return true; } if(c && c.tagName==='SELECT'){ for(var i=0;i<c.options.length;i++){ if(c.options[i].text===value||c.options[i].value===value){ c.selectedIndex=i; c.dispatchEvent(new Event('change',{bubbles:true})); break; } } resolve({ok:true}); return true; } var tg=(c||labelTrigger(arg)); if(tg){ tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve, tg); return true; } return false; }); return; }
      if (op==='dropdown'){ withRetry(function(){ var tg=bySel()||labelTrigger(arg)||labelControl(arg)||geoControl(arg); if(!tg) return false; if(step.locateOnly){ resolve(locOf(tg)); return true; } tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve, tg); return true; }); return; }
      if (op==='searchSelect'||op==='search'){ /* search=录制 IR 动词,兼容别名(存量技能可能带) */ withRetry(function(){ var c=bySel()||labelControl(arg)||attrControl(arg)||geoControl(arg)||floatSearchControl(); if(!c) return false; if(step.locateOnly){ resolve(locOf(c)); return true; } c.focus(); try{ c.click(); }catch(e){} setNativeValue(c,value); pollClickOption(value, resolve, c); return true; }); return; }
      if (op==='openPicker'){ /* 放大镜/拾取器控件：点开检索弹窗（值必须经弹窗搜索选中——行内输入框直接打字留不住的场景）。
        打开后由 agent 在弹窗里 fill 搜索框 → 点查询 → click 结果项 →（如有）click 确定。 */
        withRetry(function(){
          function sq2(s){ return (s||'').replace(/\s+/g,''); }
          var inp=null;
          if (step.col){
            var C=sq2(step.col), hc2=null, cand2=document.querySelectorAll('th,td,div,span,label');
            for(var i2=0;i2<cand2.length;i2++){ var n2=cand2[i2]; if(!visible(n2)) continue; var t2=sq2(n2.innerText); if(!t2) continue; if(t2===C){ hc2=n2; break; } if(!hc2&&t2.indexOf(C)!==-1&&t2.length<=C.length+4) hc2=n2; }
            if(!hc2) return false;
            var hr2=hc2.getBoundingClientRect();
            function xov2(b){ return Math.min(b.right,hr2.right)-Math.max(b.left,hr2.left); }
            var T2=sq2(arg);
            var rows2=Array.prototype.slice.call(document.querySelectorAll('tr,[role=row]')).filter(function(x){ return visible(x)&&(!T2||sq2(x.innerText).indexOf(T2)!==-1); });
            rows2.sort(function(a,b){ return a.getBoundingClientRect().height-b.getBoundingClientRect().height; });
            var INP2='input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea';
            for(var r2=0;r2<rows2.length&&!inp;r2++){ var rb2=rows2[r2].getBoundingClientRect(); var all2=document.querySelectorAll(INP2); var best2=null,bo2=0;
              for(var k2=0;k2<all2.length;k2++){ var e2=all2[k2]; if(!visible(e2)) continue; var b2=e2.getBoundingClientRect(); if(b2.width<2||b2.height<2) continue; var cy2=(b2.top+b2.bottom)/2; if(cy2<rb2.top-4||cy2>rb2.bottom+4) continue; var o2=xov2(b2); if(o2>4&&o2>bo2){ bo2=o2; best2=e2; } }
              inp=best2; }
          } else {
            inp=geoControl(arg)||labelControl(arg)||attrControl(arg);
          }
          if(!inp) return false;
          try{ inp.scrollIntoView({block:'center'}); }catch(e){}
          var b3=inp.getBoundingClientRect(); var cy3=(b3.top+b3.bottom)/2;
          // 首选：DOM 就近找放大镜按钮（录制轨迹坐实讯飞结构 #fieldXspan > div:2 > button，与输入框互为堂兄弟）
          // ——从输入框向上爬 3 层祖先，找可见的 button/图标，取"水平距输入框右缘最近"的那个点击。
          var anc=inp.parentElement, lvl=0;
          while(anc && lvl<3){
            var btns=anc.querySelectorAll('button, [class*=btn], i[class*=icon], [class*=search]');
            var pick3=null, pd3=1e9;
            for(var q3=0;q3<btns.length;q3++){ var bn=btns[q3]; if(!visible(bn)) continue; if(bn===inp||bn.contains(inp)) continue;
              var bb=bn.getBoundingClientRect(); if(bb.width<2||bb.height<2) continue;
              var vOv=Math.min(bb.bottom,b3.bottom)-Math.max(bb.top,b3.top); if(vOv<Math.min(bb.height,b3.height)*0.4) continue;
              var dx=Math.abs(bb.left-b3.right); if(dx<pd3){ pd3=dx; pick3=bn; } }
            if(pick3){ if(step.locateOnly){ resolve(locOf(pick3)); return true; } try{ pick3.click(); resolve({ok:true}); return true; }catch(e){} }
            anc=anc.parentElement; lvl++;
          }
          // 次选：从输入框右缘向外探点
          var pts=[[b3.right-8,cy3],[b3.right+12,cy3],[b3.right-20,cy3]];
          for(var p3=0;p3<pts.length;p3++){ var el3=document.elementFromPoint(pts[p3][0],pts[p3][1]); if(el3&&el3!==inp){ if(step.locateOnly){ resolve(locOf(el3)); return true; } try{ el3.click(); resolve({ok:true}); return true; }catch(e){} } }
          if(step.locateOnly){ resolve(locOf(inp)); return true; }
          try{ inp.click(); }catch(e){}
          resolve({ok:true}); return true;
        }); return; }
      if (op==='rowSet'){ /* 表格行内编辑：在「目标行」的「列」单元格里填值；检索型单元格填后若弹候选则点中匹配项。
        **纯几何定位**：企业流程表单常是一整张巨型 table（标题/部门/数据行混在一起，表头不在 thead 第一行）+ 大量 colspan，
        按"第一行=表头/子元素下标=列"定位必失败——改为「列头格的横向区间 × 目标行的纵向区间」取交叉处的输入框，
        对巨型表/冻结列拆分表/colspan/div 网格全部免疫。 */
        withRetry(function(){
          function sq(s){ return (s||'').replace(/\\s+/g,''); }
          var T=sq(arg), C=sq(step.col||'');
          if(!C){ resolve({ok:false,error:'rowset 需要 column（列头名）'}); return true; }
          // ① 列头格：优先自身文本恰好等于列名的可见格，其次"包含且不长太多"
          var hc=null, cand=document.querySelectorAll('th,td,div,span,label');
          for(var i=0;i<cand.length;i++){ var n=cand[i]; if(!visible(n)) continue; var t=sq(n.innerText); if(!t) continue;
            if(t===C){ hc=n; break; } if(!hc && t.indexOf(C)!==-1 && t.length<=C.length+4) hc=n; }
          if(!hc) return false;
          var hr=hc.getBoundingClientRect(); if(hr.width<2) return false;
          var INP='input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]';
          function fillIt(inp){
            // 两段式落值 + 核验（绝不假成功）：
            //  第一段 setNativeValue + 轮询候选（检索型格必须点选候选才算落值）→ blur 后核验；
            //  没留住 → 第二段**真实输入路径** execCommand('insertText')（等价真键盘输入，顽固前端框架
            //  不认 setNativeValue、失焦即清的场景——实测讯飞"原因说明"格）→ 再核验；两段都留不住才报失败。
            var isCE = inp.getAttribute && inp.getAttribute('contenteditable')==='true';
            var sqv=(value||'').replace(/\\s+/g,'');
            function readVal(){ try{ return ((isCE ? inp.innerText : inp.value)||'').replace(/\\s+/g,''); }catch(e){ return ''; } }
            function verified(){
              try{
                var cur=readVal();
                var cellTxt=((inp.closest && inp.closest('td') ? inp.closest('td').innerText : '')||'').replace(/\\s+/g,'');
                return !!((cur && (cur===sqv || cur.indexOf(sqv)!==-1 || sqv.indexOf(cur)!==-1)) || (cellTxt && cellTxt.indexOf(sqv)!==-1));
              }catch(e){ return false; }
            }
            try{ inp.scrollIntoView({block:'center'}); }catch(e){}
            inp.focus(); try{ inp.click(); }catch(e){}
            if(isCE){ try{ document.execCommand('selectAll',false,null); document.execCommand('insertText',false,value); }catch(e){} }
            else setNativeValue(inp, value);
            var picked=false, tries=0;
            (function poll(){
              tries++;
              if(!picked){ var h=findOption(value, inp); if(h){ picked=true; try{ h.scrollIntoView({block:'center'}); clickOpt(h); }catch(e){} setTimeout(finish1, 500); return; } }
              if(tries>=10){ finish1(); return; }   // ~4s 无候选 → 进入核验
              setTimeout(poll, 400);
            })();
            function finish1(){
              try{ inp.blur && inp.blur(); }catch(e){}
              setTimeout(function(){
                if(picked || verified()){ resolve({ok:true}); return; }
                // 第二段：真实输入路径
                inp.focus(); try{ inp.click(); }catch(e){}
                try{ if(inp.select) inp.select(); else if(inp.setSelectionRange) inp.setSelectionRange(0,(inp.value||'').length); else document.execCommand('selectAll',false,null); }catch(e){}
                try{ document.execCommand('insertText', false, value); }catch(e){}
                try{ inp.dispatchEvent(new Event('input',{bubbles:true})); inp.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
                var t2=0;
                (function p2(){
                  t2++;
                  var h=findOption(value, inp); if(h){ try{ clickOpt(h); }catch(e){} setTimeout(finish2, 400); return; }
                  if(t2>=4){ finish2(); return; }
                  setTimeout(p2, 300);
                })();
              }, 350);
            }
            function finish2(){
              try{ inp.blur && inp.blur(); }catch(e){}
              setTimeout(function(){
                if(verified()) resolve({ok:true});
                else resolve({ok:false,error:'值「'+value+'」两种输入方式都未能留在该格（组件可能需先点击激活编辑态，或必须从候选选择）——试试先 click 该格再 rowset，或用 search'});
              }, 350);
            }
          }
          // 横向判定用**区间重叠**而非"中心点在表头区间内"：末列数据格常被 colspan/剩余宽度拉宽，
          // 输入框中心会漂出表头横向区间（实测讯飞"原因说明"末列定位不到的根因之一）。
          function xOv(b){ return Math.min(b.right,hr.right)-Math.max(b.left,hr.left); }
          // ② 有行文本：收集**所有**含 T 的行，按"高度最小=最具体"排序逐个试——嵌套表里外层大 tr
          // （包住整个数据区、文本也含 T）会在文档序里抢先，第一个失败就放弃会永远够不到真正的数据行。
          if(T){
            var rowsAll=document.querySelectorAll('tr,[role=row]');
            var matches=[];
            for(var r=0;r<rowsAll.length;r++){ var row=rowsAll[r]; if(!visible(row)) continue;
              if(sq(row.innerText).indexOf(T)===-1) continue;
              var rb0=row.getBoundingClientRect(); if(rb0.height<2) continue;
              matches.push(rb0);
            }
            matches.sort(function(a,b){ return a.height-b.height; });
            function inputAt(rb){
              var best=null,bestOv=0,all=document.querySelectorAll(INP);
              for(var k=0;k<all.length;k++){ var inp=all[k]; if(!visible(inp)) continue; var b=inp.getBoundingClientRect();
                if(b.width<2||b.height<2) continue; var cy=(b.top+b.bottom)/2;
                if(cy<rb.top-4||cy>rb.bottom+4) continue;
                var ov=xOv(b); if(ov>4 && ov>bestOv){ bestOv=ov; best=inp; } }
              return best;
            }
            // 失败诊断：把表头/匹配行/行内输入框的真实几何吐出来——别再隔空猜 DOM
            function diagMsg(){
              var d='未定位到「'+(step.col||'')+'」列在目标行的输入框。表头x['+Math.round(hr.left)+'-'+Math.round(hr.right)+']';
              d+='；匹配行'+matches.length+'个(高:'+matches.slice(0,3).map(function(m){return Math.round(m.height);}).join('/')+')';
              if(matches.length){ var rb=matches[0]; var xs=[],all=document.querySelectorAll(INP);
                for(var k=0;k<all.length;k++){ var b=all[k].getBoundingClientRect(); if(b.width<2||b.height<2) continue;
                  var cy=(b.top+b.bottom)/2; if(cy>=rb.top-4&&cy<=rb.bottom+4) xs.push('x['+Math.round(b.left)+'-'+Math.round(b.right)+']'); }
                d+='；该行输入框'+xs.length+'个:'+xs.slice(0,5).join(','); }
              return d;
            }
            for(var mi=0;mi<matches.length;mi++){ var got=inputAt(matches[mi]); if(got){ if(step.locateOnly){ resolve(locOf(got)); return true; } fillIt(got); return true; } }
            // 点击激活兜底：e-form 常要先点格子才生成编辑框——点「最小匹配行 × 列头」交叉处的 td，稍候重扫
            if(matches.length){
              var rb1=matches[0], cellHit=null, tds=document.querySelectorAll('td');
              for(var c9=0;c9<tds.length;c9++){ var td9=tds[c9]; if(!visible(td9)) continue; var b9=td9.getBoundingClientRect();
                if(b9.width<2||b9.height<2) continue; var cy9=(b9.top+b9.bottom)/2;
                if(cy9<rb1.top-4||cy9>rb1.bottom+4) continue; if(xOv(b9)>4){ cellHit=td9; break; } }
              if(cellHit){
                try{ cellHit.scrollIntoView({block:'center'}); }catch(e){}
                try{ cellHit.click(); }catch(e){}
                setTimeout(function(){ var got2=inputAt(rb1); if(got2){ if(step.locateOnly){ resolve(locOf(got2)); } else { fillIt(got2); } } else { resolve({ok:false,error:diagMsg()+'（已尝试点击该格激活）'}); } }, 800);
                return true;
              }
            }
            resolve({ok:false,error:diagMsg()});
            return true;
          }
          // ③ 无行文本：列头正下方最近的、与列头横向有重叠的输入框
          var best2=null,bestD=1e9,inps2=document.querySelectorAll(INP);
          for(var m=0;m<inps2.length;m++){ var p=inps2[m]; if(!visible(p)) continue; var pb=p.getBoundingClientRect();
            if(pb.width<2||pb.height<2) continue; if(pb.top<hr.bottom-4) continue; if(xOv(pb)<=4) continue;
            var d=pb.top-hr.bottom; if(d<bestD){ bestD=d; best2=p; } }
          if(!best2) return false;
          fillIt(best2); return true;
        });
        return; }
      if (op==='press'){ /* 键盘手势(Enter/Escape)：录制器补上的"回车提交/关弹层"盲区 */
        withRetry(function(){ var c=bySel()||labelControl(arg)||document.activeElement; if(!c||c===document.body) return false; try{ c.focus&&c.focus(); }catch(e){}
          var key=value||'Enter'; var code=key==='Enter'?13:27;
          ['keydown','keypress','keyup'].forEach(function(tp){ try{ c.dispatchEvent(new KeyboardEvent(tp,{key:key,code:key,keyCode:code,which:code,bubbles:true,cancelable:true})); }catch(e){} });
          if(key==='Enter'&&c.form&&c.form.requestSubmit){ try{ c.form.requestSubmit(); }catch(e){} }
          resolve({ok:true}); return true; }); return; }
      if (op==='choose'){ /* radio/checkbox 组：按选项文本点 label（组语义录制产物），回退选择器/文本 */
        withRetry(function(){ var v=(value||'').replace(/\\(取消\\)$/,'');
          var labels=Array.prototype.slice.call(document.querySelectorAll('label'));
          for(var i=0;i<labels.length;i++){ var lb=labels[i]; if(!visible(lb)) continue; if(v&&norm(lb.innerText).indexOf(norm(v))!==-1){ lb.scrollIntoView({block:'center'}); lb.click(); resolve({ok:true}); return true; } }
          var el=bySel(); if(el){ el.scrollIntoView({block:'center'}); el.click(); resolve({ok:true}); return true; }
          var t=v?clickByText(v):null; if(t){ t.scrollIntoView({block:'center'}); t.click(); resolve({ok:true}); return true; }
          return false; }); return; }
      if (op==='checkRow'){ /* P1 动作原语：按「行文本」定位表格行，勾选/取消其复选框（考勤类"复选多行再删"）。value=uncheck 则取消，默认勾选。 */
        withRetry(function(){ var t=norm(arg); if(!t) return false; var wantUncheck=(value==='uncheck'||value==='取消');
          // 最小行优先（血泪：嵌套 e-form 的外层大 tr 文本也含目标、文档序在前，其内部第一个 checkbox 是**表头全选框**——点下去=整表全选）
          var trs=Array.prototype.slice.call(document.querySelectorAll('tr, [role=row]')).filter(function(x){ return visible(x) && norm(x.innerText).indexOf(t)!==-1; });
          trs.sort(function(a,b){ return a.getBoundingClientRect().height-b.getBoundingClientRect().height; });
          for(var i=0;i<trs.length;i++){ var tr=trs[i];
            var cb=tr.querySelector('input[type=checkbox], [role=checkbox]');
            if(cb){ cb.scrollIntoView({block:'center'}); var isChecked=(cb.checked===true||cb.getAttribute('aria-checked')==='true'); if(isChecked!==(!wantUncheck)) cb.click(); resolve({ok:true}); return true; }
            var w=tr.querySelector('.ant-checkbox, .el-checkbox, .ant-checkbox-wrapper, label'); if(w){ w.scrollIntoView({block:'center'}); var on=/checked/.test((w.className||'')+''); if(on!==(!wantUncheck)) w.click(); resolve({ok:true}); return true; }
          }
          return false; }); return; }
      if (op==='rowAction'){ /* P1 动作原语：按「行文本」定位表格行，点该行的操作按钮（value=按钮文本如"删除"/"编辑"；空则取删除类）。 */
        withRetry(function(){ var t=norm(arg); if(!t) return false; var want=norm(value);
          var trs=Array.prototype.slice.call(document.querySelectorAll('tr, [role=row]')).filter(function(x){ return visible(x) && norm(x.innerText).indexOf(t)!==-1; });
          trs.sort(function(a,b){ return a.getBoundingClientRect().height-b.getBoundingClientRect().height; });   // 最小行=真数据行，外层容器行排后
          for(var i=0;i<trs.length;i++){ var tr=trs[i];
            var btns=Array.prototype.slice.call(tr.querySelectorAll('button,a,[role=button],[class*=btn],i,[class*=icon],[onclick],[aria-label],[title]')); var pick=null;
            for(var j=0;j<btns.length;j++){ var b=btns[j]; if(!visible(b)) continue;
              var lbl=norm(b.innerText||(b.getAttribute&&(b.getAttribute('aria-label')||b.getAttribute('title')))||''); var cls=((b.className||'')+'').toLowerCase();
              if(want){ if(lbl.indexOf(want)!==-1){ pick=b; break; } }
              else if(lbl.indexOf('删除')!==-1||/del|minus|remove|trash|reduce/.test(cls)){ pick=b; break; }
            }
            if(pick){ pick.scrollIntoView({block:'center'}); pick.click(); resolve({ok:true}); return true; }
          }
          return false; }); return; }
      if (op==='checkAll'){ /* P1 动作原语：表格表头「全选」复选框（value=uncheck 则全不选）。 */
        withRetry(function(){ var wantUncheck=(value==='uncheck'||value==='取消');
          var cb=document.querySelector('thead input[type=checkbox], thead [role=checkbox], .ant-table-thead input[type=checkbox]');
          if(cb){ cb.scrollIntoView({block:'center'}); var on=(cb.checked===true||cb.getAttribute('aria-checked')==='true'); if(on!==(!wantUncheck)) cb.click(); resolve({ok:true}); return true; }
          var w=document.querySelector('thead .ant-checkbox, thead .el-checkbox, .ant-table-thead .ant-checkbox'); if(w){ w.scrollIntoView({block:'center'}); w.click(); resolve({ok:true}); return true; }
          return false; }); return; }
      resolve({ok:false, error:'未知动作：'+op});
    } catch(err){ resolve({ok:false, error:String(err)}); }
  });
}`

export const SNAPSHOT_FN = `function(){
  function vis(n){ try{ var r=n.getBoundingClientRect(); return n.offsetParent!==null && r.width>1 && r.height>1; }catch(e){ return false; } }
  function sel(el){
    try{ if(el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id); }catch(e){}
    var attrs=['data-id','data-testid','data-name','name','aria-label'];
    for(var i=0;i<attrs.length;i++){ var v=el.getAttribute&&el.getAttribute(attrs[i]); if(v){ var s='['+attrs[i]+'=\"'+String(v).replace(/\"/g,'')+'\"]'; try{ if(document.querySelectorAll(s).length===1) return s; }catch(e){} } }
    var parts=[], e=el;
    while(e && e.nodeType===1 && e.tagName!=='HTML' && parts.length<7){ var t=e.tagName.toLowerCase(); var p=e.parentElement; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===e.tagName;}); if(sib.length>1) t+=':nth-of-type('+(sib.indexOf(e)+1)+')'; } parts.unshift(t); e=p; }
    return parts.join(' > ');
  }
  var nodes=Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=menuitem],[role=tab],[role=option],[onclick],.ant-btn,.ant-menu-item,li[role],[class*=btn],i,[class*=icon],svg[onclick],.ant-modal-close,.ant-modal-footer button,[class*=menu] li,[class*=nav] li,[class*=sider] li,[class*=tab] li,[aria-label],[title]'));
  function labelFor(el){
    try{
      if(el.id){ var l=document.querySelector('label[for=\"'+(window.CSS&&CSS.escape?CSS.escape(el.id):el.id)+'\"]'); if(l&&(l.innerText||'').trim()) return l.innerText.trim(); }
      var box=el.closest&&el.closest('.form-item,.form-group,.ant-form-item,.el-form-item,tr,li,p,.field');
      if(box){ var lab=box.querySelector('label,.ant-form-item-label,.el-form-item__label,dt,th'); if(lab&&(lab.innerText||'').trim()) return lab.innerText.trim(); }
    }catch(e){}
    return '';
  }
  var out=[], seen={};
  for(var i=0;i<nodes.length && out.length<70;i++){ var n=nodes[i]; if(!vis(n)) continue;
    var tag=n.tagName.toLowerCase();
    // 表单控件：**优先用关联 label**——与 SEMANTIC_FN fill 的 label 定位一致，agent 照抄 observe 文本即可命中，不再 placeholder↔label 试错
    var text = (tag==='input'||tag==='textarea'||tag==='select')
      ? (labelFor(n)||(n.getAttribute&&(n.getAttribute('placeholder')||n.getAttribute('aria-label')||n.getAttribute('title')))||n.value||'')
      : (n.innerText||n.value||(n.getAttribute&&(n.getAttribute('placeholder')||n.getAttribute('aria-label')||n.getAttribute('title')||n.getAttribute('alt')))||'');
    text=(text+'').replace(/\\s+/g,' ').trim().slice(0,40);
    if(!text && tag!=='input' && tag!=='textarea' && tag!=='select') continue;
    var s=sel(n); if(seen[s]) continue; seen[s]=1;
    out.push({ tag:tag, role:(n.getAttribute&&n.getAttribute('role'))||'', text:text, sel:s });
  }
  return out;
}`

/**
 * 结构化感知（P0）：把页面读成**结构模型**而非扁平元素清单——B/S 系统真正难的表格/表单交给结构，
 * 上层不用让 LLM 从几十条元素里猜。产出：
 *   tables[{ headers, rows[{cells, hasCheckbox, actions[]}], selectAll }] —— 解「表格勾选+删行」类任务
 *   forms[{ label, type(text/textarea/select/dropdown), required, options[] }] —— 解「按字段填/选、下拉候选、autocomplete」
 * 与 SNAPSHOT_FN 互补：SNAPSHOT 给"能点什么"，STRUCT 给"页面是什么结构"。跨 frame 由调用方逐帧聚合。
 */
export const STRUCT_FN = `function(){
  function vis(n){ try{ var r=n.getBoundingClientRect(); return n.offsetParent!==null && r.width>1 && r.height>1; }catch(e){ return false; } }
  function txt(n){ return ((n&&(n.innerText||n.textContent))||'').replace(/\\s+/g,' ').trim(); }
  // 行内操作按钮：捕获 button/a/图标 的可辨识文本（"-"/删除/编辑/新增），图标无文本时按 class 猜
  function rowActions(scope){
    var acts=[], seen={};
    var nodes=scope.querySelectorAll('button,a,[role=button],[class*=btn],i,[class*=icon],[onclick],[aria-label],[title]');
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!vis(n)) continue;
      var lbl=txt(n)||(n.getAttribute&&(n.getAttribute('aria-label')||n.getAttribute('title')))||'';
      if(!lbl){ var c=((n.className||'')+'').toLowerCase(); if(/del|minus|remove|trash|reduce|jian/.test(c)) lbl='删除'; else if(/edit|pencil|xiugai/.test(c)) lbl='编辑'; else if(/plus|add|zeng/.test(c)) lbl='新增'; }
      lbl=(lbl+'').trim().slice(0,12); if(!lbl||seen[lbl]||lbl.length>10) continue; seen[lbl]=1; acts.push(lbl);
    }
    return acts;
  }
  var out={tables:[], forms:[]};
  // ===== 表格（原生 table + 常见组件表格）=====
  var tbls=Array.prototype.slice.call(document.querySelectorAll('table, [role=grid]'));
  var tseen=[];
  for(var t=0;t<tbls.length && out.tables.length<6;t++){ var tb=tbls[t]; if(!vis(tb)) continue; if(tseen.indexOf(tb)!==-1) continue; tseen.push(tb);
    var heads=[]; var ths=tb.querySelectorAll('thead th, thead td'); if(!ths.length) ths=tb.querySelectorAll('tr:first-child th');
    for(var h=0;h<ths.length;h++){ var ht=txt(ths[h]); heads.push(ht.slice(0,16)); }
    var rows=[]; var trs=tb.querySelectorAll('tbody tr'); if(!trs.length) trs=tb.querySelectorAll('tr');
    for(var r=0;r<trs.length && rows.length<20;r++){ var tr=trs[r]; if(!vis(tr)) continue;
      if(tr.querySelector('th') && !tr.querySelector('td')) continue;   // 纯表头行
      var tds=tr.querySelectorAll('td'); if(!tds.length) continue;
      var cells=[]; for(var c=0;c<tds.length && cells.length<12;c++){ cells.push(txt(tds[c]).slice(0,24)); }   // 12 列：讯飞考勤的类型/原因说明在第9-10列，截8列会让 agent 以为这些列不存在
      var cb=tr.querySelector('input[type=checkbox], [role=checkbox], .ant-checkbox-input, .el-checkbox');
      rows.push({ cells:cells, hasCheckbox:!!cb, actions:rowActions(tr) });
    }
    if(!rows.length && !heads.length) continue;
    var selAll=tb.querySelector('thead input[type=checkbox], thead [role=checkbox]');
    // 可编辑列：数据行单元格里带输入框/文本域的列（讯飞"类型/原因说明"这类行内编辑格）——
    // 不暴露的话 agent "看不见"这些字段（它们没有表单 label），会误判"页面没有可设置的字段"。
    var editCols=[];
    for(var c2=0;c2<heads.length;c2++){
      for(var r2=0;r2<trs.length && r2<8;r2++){ var tr2=trs[r2]; if(!vis(tr2)) continue;
        var tds2=tr2.querySelectorAll('td');
        if(c2<tds2.length && tds2[c2].querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea')){ if(heads[c2]) editCols.push(heads[c2]); break; }
      }
    }
    out.tables.push({ headers:heads, rows:rows, selectAll:!!selAll, editCols:editCols });
  }
  // ===== 表单字段（label + 类型 + 下拉候选 + 必填）=====
  var groups=Array.prototype.slice.call(document.querySelectorAll('.ant-form-item, .el-form-item, .form-item, .form-group, .field'));
  var gseen={};
  for(var g=0;g<groups.length && out.forms.length<40;g++){ var box=groups[g]; if(!vis(box)) continue;
    var lab=box.querySelector('label,.ant-form-item-label,.el-form-item__label'); var label=lab?txt(lab):'';
    if(!label||gseen[label]) continue; gseen[label]=1;
    var ctrl=box.querySelector('input:not([type=hidden]),textarea,select,.ant-select,[role=combobox],.ant-picker');
    var type='text', options=[];
    if(ctrl){ var tn=ctrl.tagName.toLowerCase(); var cls=((ctrl.className||'')+'').toLowerCase(); var role=(ctrl.getAttribute&&ctrl.getAttribute('role'))||'';
      if(tn==='select'){ type='select'; for(var o=0;o<ctrl.options.length && options.length<12;o++){ var ot=(ctrl.options[o].text||'').trim(); if(ot) options.push(ot.slice(0,20)); } }
      else if(/select|combobox|picker|cascader/.test(cls)||role==='combobox'){ type='dropdown'; }
      else if(tn==='textarea'){ type='textarea'; }
    }
    var req=!!(box.querySelector('.ant-form-item-required, .required, [required]')) || /[*＊]/.test(label);
    out.forms.push({ label:label.replace(/[*＊：:]/g,'').trim().slice(0,20), type:type, required:req, options:options });
  }
  return out;
}`

export const PAGE_SETTLE_FN = `function(maxMs){
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

/**
 * 读取「单据详情页」的键值对：审批前把单据内容摆给人看（只读），人才敢签字。
 * 不绑定任何具体系统的 DOM——按常见的四类结构提取：
 *   ① 键值网格：`.k`/`.key`/`.label` 后面紧跟的兄弟节点（Mock OA 的 .kv 就是这种）
 *   ② 定义列表：dt/dd
 *   ③ 两列表格：th → 同行 td
 *   ④ 表单标签：label[for] → 对应控件的值
 * 只读**真实渲染出来的文本**，读不到就少给几项，绝不编。
 */
export const READ_DETAIL_FN = `function(){
  var out = [], seen = {};
  function push(k, v){
    k = (k||'').replace(/\\s+/g,' ').trim().replace(/[：:]\\s*$/, '');
    v = (v||'').replace(/\\s+/g,' ').trim();
    if (!k || !v || k.length > 20 || v.length > 200) return;
    if (seen[k]) return; seen[k] = 1;
    out.push({ label: k, value: v });
  }
  // ① 键值网格
  var ks = document.querySelectorAll('.k, .key, .kv-k, .field-label, .ant-descriptions-item-label, .el-descriptions-item__label');
  for (var i=0;i<ks.length;i++){
    var n = ks[i], sib = n.nextElementSibling;
    if (sib) push(n.innerText, sib.innerText);
  }
  // ② 定义列表
  var dts = document.querySelectorAll('dt');
  for (var i=0;i<dts.length;i++){ var dd = dts[i].nextElementSibling; if (dd && dd.tagName === 'DD') push(dts[i].innerText, dd.innerText); }
  // ③ 两列表格（表头在行首）
  var trs = document.querySelectorAll('tr');
  for (var i=0;i<trs.length;i++){
    var th = trs[i].querySelector('th'), td = trs[i].querySelector('td');
    if (th && td && trs[i].querySelectorAll('td').length === 1) push(th.innerText, td.innerText);
  }
  // ④ 表单标签 → 控件值（已填的只读态表单）
  var labs = document.querySelectorAll('label[for]');
  for (var i=0;i<labs.length;i++){
    var c = document.getElementById(labs[i].getAttribute('for'));
    if (c && (c.tagName === 'INPUT' || c.tagName === 'TEXTAREA') && c.value) push(labs[i].innerText, c.value);
  }
  return out.slice(0, 20);
}`
