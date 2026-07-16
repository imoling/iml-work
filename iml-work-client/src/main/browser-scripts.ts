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
    var box = el.closest && el.closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li');
    if (box){ var lab = box.querySelector('label, .ant-form-item-label, .el-form-item__label, dt, th'); if(lab) return (lab.innerText||'').trim(); }
    return (el.getAttribute && (el.getAttribute('aria-label')||el.placeholder)) || (el.innerText||'').trim().slice(0,30);
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
      // 记下 DOM 的 input type（date/number/email…）——确认卡据此渲染同款控件（日期给日期选择器，
      // 而不是让人手敲 2026-07-13）。只记 tag 的话，日期框会被一律降级成纯文本框。
      emit({ action:'fill', selector: robust(el), value: el.value || '', label: labelOf(el), tag: tag, inputType: (tag==='input' ? (el.type||'text') : 'textarea'), url: location.href });
    }
  }, true);
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
    function clickByText(text){
      var t = (text||'').trim();
      var sel = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], .ant-btn, .ant-menu-item, .el-button, li, td, span, div';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      var ownMatch=null, fullMatches=[], partial=null;
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue;
        var own=''; for(var k=0;k<n.childNodes.length;k++){ if(n.childNodes[k].nodeType===3) own+=n.childNodes[k].textContent; }
        own=own.trim(); var full=(n.innerText||'').trim();
        if(own===t){ ownMatch=n; break; }                 // 最佳：自身文本恰好等于目标
        if(full===t) fullMatches.push(n);                  // 次之：整体文本相等（取最具体/最深的）
        if(!partial && t && full.indexOf(t)!==-1 && full.length < t.length+12) partial=n;
      }
      if (ownMatch) return ownMatch;
      if (fullMatches.length){ fullMatches.sort(function(a,b){ return a.querySelectorAll('*').length - b.querySelectorAll('*').length; }); return fullMatches[0]; }
      return partial;
    }
    var RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li';
    var fuzzyPick2 = (${FUZZY_PICK_SRC});
    function findOption(val){
      var nodes=document.querySelectorAll(RESULT_SEL); var exact=null,partial=null,vis=[],visTexts=[];
      for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue; var tx=(n.innerText||n.textContent||'').trim(); if(!tx) continue;
        vis.push(n); visTexts.push(tx);
        if(val && tx===val){ exact=n; break; } if(!partial && val && tx.indexOf(val)!==-1) partial=n; }
      if(exact||partial) return exact||partial;
      var fi=fuzzyPick2(val, visTexts);   /* 近似档：同上，唯一赢家才选 */
      return fi>=0 ? vis[fi] : null;
    }
    function pollClickOption(val, done){
      var tries=0; (function p(){ tries++; var h=findOption(val);
        if(h){ try{ h.scrollIntoView({block:'center'}); h.click(); done({ok:true}); }catch(e){ done({ok:false,error:String(e)}); } return; }
        if(tries>=24){ done({ok:false,error:'未匹配到选项“'+val+'”'}); return; } setTimeout(p,300); })();
    }
    function withRetry(fn){ var tries=0; (function a(){ tries++; if(fn()) return; if(tries>=5){ resolve({ok:false,error:'未找到元素：'+(arg||op)}); return; } setTimeout(a,250); })(); }
    function dispatchHover(el){ ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(tp){ try{ el.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window})); }catch(e){} }); }

    try {
      if (op==='wait'){ setTimeout(function(){ resolve({ok:true}); }, parseInt(value||'500',10)||500); return; }
      if (op==='waitText'){ var wt=0; (function w(){ wt++; if((document.body?document.body.innerText:'').indexOf(arg)!==-1){ resolve({ok:true}); return; } if(wt>=32){ resolve({ok:false,error:'未等到文本“'+arg+'”'}); return; } setTimeout(w,300); })(); return; }
      if (op==='hover'){ withRetry(function(){ var el=bySel()||clickByText(arg)||labelControl(arg); if(!el) return false; el.scrollIntoView({block:'center'}); dispatchHover(el); resolve({ok:true}); return true; }); return; }
      if (op==='click'){ withRetry(function(){ var el=bySel(); if(el && arg){ var et=norm(el.innerText||el.textContent||''); if(et && et.indexOf(norm(arg))===-1) el=null; } if(!el) el=clickByText(arg); if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); resolve({ok:true}); return true; }); return; }
      if (op==='fill'){ withRetry(function(){ var c=bySel()||labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); resolve({ok:true}); return true; }); return; }
      if (op==='select'){ withRetry(function(){ var c=bySel()||labelControl(arg); if(c && c.tagName==='SELECT'){ for(var i=0;i<c.options.length;i++){ if(c.options[i].text===value||c.options[i].value===value){ c.selectedIndex=i; c.dispatchEvent(new Event('change',{bubbles:true})); break; } } resolve({ok:true}); return true; } var tg=(c||labelTrigger(arg)); if(tg){ tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; } return false; }); return; }
      if (op==='dropdown'){ withRetry(function(){ var tg=bySel()||labelTrigger(arg)||labelControl(arg); if(!tg) return false; tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; }); return; }
      if (op==='searchSelect'){ withRetry(function(){ var c=bySel()||labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); pollClickOption(value, resolve); return true; }); return; }
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
  var nodes=Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=menuitem],[role=tab],[role=option],[onclick],.ant-btn,.ant-menu-item,li[role],[class*=btn],.ant-modal-close,.ant-modal-footer button,[class*=menu] li,[class*=nav] li,[class*=sider] li,[class*=tab] li,[aria-label],[title]'));
  var out=[], seen={};
  for(var i=0;i<nodes.length && out.length<70;i++){ var n=nodes[i]; if(!vis(n)) continue;
    var text=((n.innerText||n.value||(n.getAttribute&&(n.getAttribute('placeholder')||n.getAttribute('aria-label')||n.getAttribute('title')||n.getAttribute('alt')))||'')+'').replace(/\\s+/g,' ').trim().slice(0,40);
    var tag=n.tagName.toLowerCase();
    if(!text && tag!=='input' && tag!=='textarea' && tag!=='select') continue;
    var s=sel(n); if(seen[s]) continue; seen[s]=1;
    out.push({ tag:tag, role:(n.getAttribute&&n.getAttribute('role'))||'', text:text, sel:s });
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
