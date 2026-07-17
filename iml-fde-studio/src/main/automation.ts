// =====================================================================
// iML 自动化引擎（Playwright 驱动真实 Chrome）
//   录制：RECORDER_JS 注入页面，捕获操作 + 元素指纹 → 步骤
//   执行：runAgentic(page, steps, fieldValues, sop, hooks)
//     每个 SOP 节点：先在 DOM 代码树里按指纹/文本定位控件，再用 Playwright 真实操作
//     (locator.click/hover/fill/selectOption，自动等待可点)；定位不到才让大模型读页面决策
// =====================================================================

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 下拉选项近似匹配 —— 与客户端 iml-work-client/src/main/select-match-core.ts 的 fuzzyPickIndex
// **同构**（跨仓库无法共包，改这里必须同步改那边）。为什么需要：字段值是模型从口语里提炼的
// （"华东电网项目"），选项是系统正式名（"华东电网巡检平台二期"）——几乎从不全等，
// 只有「精确/包含」两档时必然失手，退到智能体读页面重试（多一轮模型调用）。
// 安全闸：写操作路径，必须有明显唯一赢家（分够高且甩开第二名）才选，并列/都不像返回 -1。
function fuzzyPickIndex(value, texts) {
  var v = String(value || '').replace(/\s+/g, '')
  if (v.length < 2 || !texts || !texts.length) return -1
  var grams = []
  for (var i = 0; i + 2 <= v.length; i++) grams.push(v.slice(i, i + 2))
  var best = -1, bestS = 0, second = 0
  for (var j = 0; j < texts.length; j++) {
    var t = String(texts[j] || '').replace(/\s+/g, '')
    if (!t) continue
    var hit = 0
    for (var k = 0; k < grams.length; k++) if (t.indexOf(grams[k]) !== -1) hit++
    var s = grams.length ? hit / grams.length : 0
    if (t.length >= 2 && v.indexOf(t) !== -1) s = s > 0.9 ? s : 0.9
    if (s > bestS) { second = bestS; bestS = s; best = j } else if (s > second) { second = s }
  }
  if (bestS >= 0.5 && bestS - second >= 0.2) return best
  return -1
}

// 近似档点选：收集当前可见选项文本 → fuzzyPickIndex 选唯一赢家 → 点它。选不出返回 ok:false。
async function fuzzyClickOption(page, resultSel, value) {
  try {
    const items = await page.locator(resultSel).evaluateAll(
      (ns) => ns.map((n, i) => ({ i, t: ((n.innerText || n.textContent || '') + '').trim(), v: !!n.offsetParent })))
    const vis = items.filter(x => x.v && x.t)
    const fi = fuzzyPickIndex(String(value || ''), vis.map(x => x.t))
    if (fi >= 0) {
      await page.locator(resultSel).nth(vis[fi].i).click({ timeout: 5000 })
      return { ok: true, note: '近似匹配「' + vis[fi].t + '」' }
    }
  } catch (_) { /* 近似档失手不致命，交上层兜底 */ }
  return { ok: false }
}

// 录制脚本（Playwright addInitScript 注入；每步 console.log('__IMLREC__'+json)）
export const RECORDER_JS = `(function(){
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
  function trimLabel(s){ return clean(s).replace(/^[*\\s]+/,'').replace(/[:：*\\s]+$/,'').slice(0,24); }
  function fieldLabel(el){
    // ① label[for]
    if(el.id){ var l=document.querySelector('label[for=\"'+esc(el.id)+'\"]'); if(l&&clean(l.innerText)) return trimLabel(l.innerText); }
    // ② 已知框架的表单项标签（antd/element/纷享/泛微 e-cology 新版 wea-*）
    var box=el.closest&&el.closest('.ant-form-item,.el-form-item,.form-item,.form-group,.wea-new-form-item,.field-tools,[class*=form-item],[class*=field]');
    if(box){ var lab=box.querySelector('label,.ant-form-item-label,.el-form-item__label,.wea-new-form-item-label,.field-tools-label,[class*=item-label],[class*=field-name],[class*=fieldName],[class*=label],dt,th'); if(lab&&clean(lab.innerText)) return trimLabel(lab.innerText); }
    // ③ 泛微/传统 table 布局：字段在 td，标签在同行更靠前的单元格（泛微 .fieldNameTitle 等）
    var td=el.closest&&el.closest('td'); if(td&&td.parentElement){ var cells=td.parentElement.children; for(var i=0;i<cells.length;i++){ if(cells[i]===td) break; var ct=clean(cells[i].innerText); if(ct&&ct.length<=16) return trimLabel(ct); } }
    // ④ 通用兜底：向上 3 层，取最近的一段"像标签"的短文本（对各家 OA 自有组件更鲁棒）
    var cur=el; for(var d=0;d<3;d++){ cur=cur&&cur.parentElement; if(!cur) break; var kids=cur.children||[]; for(var j=0;j<kids.length;j++){ var k=kids[j]; if(k===el||(k.contains&&k.contains(el))) continue; var t=clean(k.innerText||k.textContent); if(t&&t.length>=2&&t.length<=14) return trimLabel(t); } }
    return trimLabel((el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('title')||el.placeholder))||'');
  }
  // 图标/图片按钮兜底名：企业门户首页多是图标卡片、图片链接，无 ownText/aria-label
  // → clickLabel 返回空 → 空标签 click 被 CRM 下拉合并逻辑误吞、审阅区也看不见（"元素没获取到"）。
  // 从 img alt / 图片文件名 / svg use 图标名 / 有意义 class 兜底出一个可读、可辨识的名字。
  function iconName(el){
    var img=el.querySelector&&el.querySelector('img'); if(img){ var al=clean(img.getAttribute('alt')||img.getAttribute('title')||''); if(al) return al; var src=img.getAttribute('src')||img.getAttribute('data-src')||''; var m=src.match(/([^/?#]+)\\.(png|jpe?g|svg|gif|webp)/i); if(m) return decodeURIComponent(m[1]); }
    var use=el.querySelector&&el.querySelector('use'); if(use){ var h=use.getAttribute('xlink:href')||use.getAttribute('href')||''; var m2=h.match(/#?([a-zA-Z][\\w-]{2,})$/); if(m2) return m2[1]; }
    var dt=el.getAttribute&&(el.getAttribute('data-title')||el.getAttribute('data-name')||el.getAttribute('data-tooltip')||el.getAttribute('alt')); if(dt) return clean(dt);
    var cls=((el.getAttribute&&el.getAttribute('class'))||'').split(/\\s+/).filter(function(x){ return /^(icon|ic|btn|menu|nav|app|tool|card|entry|module|wea)[-_]?[a-zA-Z]/.test(x) && x.length<=24 && !/^css-|[0-9]{4,}/.test(x); })[0]; if(cls) return cls;
    return '';
  }
  function clickLabel(el){
    var base=clean(ownText(el)||(el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('title')))||'');
    if(base) return base.slice(0,40);
    var inner=clean(el.innerText||''); if(inner) return inner.slice(0,40);
    return iconName(el).slice(0,40);
  }
  // 纷享字段信息：从所在 .f-g-item 取真实标签 + 控件类型
  function fxInfo(el){ var item=el.closest&&el.closest('.f-g-item'); if(!item){ var wrap=el.closest&&el.closest('[class*=f-item-wrap]'); item=wrap?wrap.parentElement:null; } if(!item||!item.querySelector) return null; var tit=item.querySelector('.f-g-item-tit,.f-item-tit,[class*=item-tit]'); var label=tit?clean(tit.textContent).replace(/^[*\\s]+/,'').replace(/[?？*\\s]+$/,''):''; if(!label) return null; var inner=item.querySelector('.f-item-inner.j-comp-wrap,[data-type]'); var dt=inner&&inner.getAttribute?(inner.getAttribute('data-type')||''):''; if(!dt){ if(item.querySelector('.crm-action-field-lookup,.j-search-ipt')) dt='object_reference'; else if(item.querySelector('.select-tit,.j-select-input,.crm-a-field-selectone')) dt='select_one'; else if(item.querySelector('textarea')) dt='long_text'; } return {fxLabel:label, fxKind:dt}; }
  // frameUrl：本步来自哪个文档。门户内容常嵌 iframe（各子系统一个 frame）——带上它才能
  // 诊断"操作分散在几个 frame"，回放也能先切到对应 frame 再定位。window===top 即主文档。
  function emit(s){ try{ s.frameUrl=location.href; s.inIframe=(window.top!==window.self); console.log('__IMLREC__'+JSON.stringify(s)); }catch(e){} }
  function menuSig(){ var ms; try{ ms=document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden),.ant-menu-submenu-popup,[role=menu],[role=listbox],.ant-select-dropdown:not(.ant-select-dropdown-hidden),.ant-popover:not(.ant-popover-hidden),[class*=submenu],[class*=sub-menu],[class*=dropdown-menu],[class*=popover],[class*=flyout],[class*=secondary-menu],[class*=expand]'); }catch(e){ return 0; } var c=0; for(var i=0;i<ms.length;i++){ if(ms[i].offsetParent!==null) c++; } return c; }
  var OPT='.ant-select-item-option,.el-select-dropdown__item,[role=option],.ant-cascader-menu-item,li[role=option],.dropdown-item';
  // 哈希路由 SPA：取被点链接的哈希路由（#... 且非 javascript:），回放时可直接跳转，绕过折叠菜单/悬停
  function navHash(el){
    var a=el.closest&&el.closest('a[href],a[data-href]'); if(!a) return '';
    var cands=[a.getAttribute('href')||'', a.getAttribute('data-href')||''];
    for(var i=0;i<cands.length;i++){ var h=cands[i];
      if(h && h.indexOf('javascript')<0 && h.indexOf('#')>=0){
        var hash=h.slice(h.indexOf('#'));
        var body=hash.charAt(0)==='#'?hash.slice(1):hash; if(body.charAt(0)==='/') body=body.slice(1);
        // 仅真实路由：含字母、长度>=3、非纯数字/占位(#/000、#、#!)
        if(body.length>=3 && /[a-zA-Z]/.test(body) && !/^[0-9_/-]+$/.test(body)) return hash;
      }
    }
    return '';
  }
  function inMenu(el){ return !!(el.closest&&el.closest('.crm-aside,[class*=aside],[class*=sider],[class*=menu],[class*=nav],nav,aside')); }
  document.addEventListener('click', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return; window.__lastHover=null;
    // 纷享：点中下拉选项/检索结果 → 结构化字段值（带当时下拉的全部可选项）
    var fxopt=el.closest('.j-search-item,.j-search-list li,[action-type],.crm-w-select li,[class*=select-list] li,[role=option]');
    if(fxopt && window.__fxOpen){ var v=clean(fxopt.innerText||fxopt.textContent); if(v && v!=='请选择'){ var os=[]; try{ var pop=fxopt.closest('ul,[class*=dropdown],[class*=select-list],[class*=options],.crm-w-select'); if(pop){ pop.querySelectorAll('li,[action-type],[role=option]').forEach(function(o){ var ot=clean(o.innerText); if(ot&&ot!=='请选择'&&os.indexOf(ot)<0&&ot.length<24) os.push(ot); }); } }catch(_e){} emit({ act:'fxPick', label:window.__fxOpen.fxLabel, kind:window.__fxOpen.fxKind, value:v, options:os, fp:fp(fxopt) }); } window.__fxOpen=null; return; }
    // 纷享：点开下拉/聚焦检索框 → 记住当前字段，抑制这次"开"的噪声点击
    var fxo=el.closest('.select-tit,.j-select-input,.select-icon,.ipt-target,.j-search-ipt,.crm-comp-serchbox,.ipt-wrap');
    if(fxo){ var fi=fxInfo(fxo); if(fi){ window.__fxOpen=fi; return; } }
    var opt=el.closest(OPT);
    if(opt){ emit({ act:'pickOption', label:clickLabel(opt), value:clean(opt.innerText), fp:fp(opt) }); return; }
    var t=el.closest('button,a,[role=button],[role=menuitem],[role=tab],.ant-btn,.ant-menu-item,li,td,span,div')||el;
    var tag=(t.tagName||'').toLowerCase(); if(tag==='body'||tag==='html') return;
    emit({ act:'click', label:clickLabel(t), value:'', nav:navHash(t), menu:inMenu(t), fp:fp(t) });
  }, true);
  document.addEventListener('change', function(e){
    var el=e.target; if(!el||el.nodeType!==1) return; var tag=(el.tagName||'').toLowerCase();
    if(tag==='select'){ var opts=[]; if(el.options){ for(var i=0;i<el.options.length;i++){ var ot=clean(el.options[i].text); if(ot&&el.options[i].value!=='') opts.push(ot); } } emit({ act:'select', label:fieldLabel(el), value:el.options&&el.selectedIndex>=0?clean(el.options[el.selectedIndex].text):el.value, options:opts, fp:fp(el) }); }
    else if(tag==='input'||tag==='textarea'){ if(el.type==='checkbox'||el.type==='radio') return; if(el.closest&&el.closest('.j-search-ipt,.j-select-input,.crm-comp-serchbox,.select-tit')) return; var fi=fxInfo(el); emit({ act:'fill', label:(fi&&fi.fxLabel)||fieldLabel(el), value:el.value||'', fp:fp(el) }); }
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
  // 捕获"点击后实际发生的跳转"：href 可能是占位(#/000)，真正路由由 JS 设置 location.hash。
  // 取变化后的真实哈希路由 → 合并到前一个 click 步骤，回放时可直接跳转，覆盖 href 抓不到的菜单。
  function realRoute(){
    var h=location.hash||'';
    var body=h.charAt(0)==='#'?h.slice(1):h; if(body.charAt(0)==='/') body=body.slice(1);
    if(body.length>=3 && /[a-zA-Z]/.test(body) && !/^[0-9_/-]+$/.test(body)) return h;
    return '';
  }
  var __lastUrl=location.href;
  function onNavChange(){
    if(location.href===__lastUrl) return; __lastUrl=location.href;
    var r=realRoute(); if(r) emit({ act:'navResult', nav:r });
  }
  window.addEventListener('hashchange', onNavChange, false);
  window.addEventListener('popstate', onNavChange, false);
  // 兜底：点击后稍等再查一次（应对延迟设置 hash 的框架路由）
  document.addEventListener('click', function(){ setTimeout(onNavChange, 800); }, true);
})();`

// 页面可交互元素清单（给自愈 agent 看）；通过 page.evaluate('('+SNAPSHOT_FN+')()') 调用
export const SNAPSHOT_FN = `function(){
  function vis(n){ try{ var r=n.getBoundingClientRect(); return n && n.offsetParent!==null && r.width>1 && r.height>1; }catch(e){ return false; } }
  function gen(el){
    try{ if(el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id); }catch(e){}
    var a=['data-id','data-testid','data-name','name','aria-label']; for(var i=0;i<a.length;i++){ var v=el.getAttribute&&el.getAttribute(a[i]); if(v){ var s='['+a[i]+'=\"'+String(v).replace(/\"/g,'')+'\"]'; try{ if(document.querySelectorAll(s).length===1) return s; }catch(e){} } }
    var parts=[],e=el; while(e&&e.nodeType===1&&e.tagName!=='HTML'&&parts.length<8){ var tag=e.tagName.toLowerCase(),p=e.parentElement; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===e.tagName;}); if(sib.length>1) tag+=':nth-of-type('+(sib.indexOf(e)+1)+')'; } parts.unshift(tag); e=p; } return parts.join(' > ');
  }
  function inRail(n){ return !!(n.closest&&n.closest('.crm-aside,[class*=aside],[class*=sider],[class*=side-menu]')); }
  function railLabel(n){ var t=(n.getAttribute&&(n.getAttribute('aria-label')||n.getAttribute('title')))||''; if(t) return t; var c=((n.getAttribute&&n.getAttribute('class'))||'').split(/\\s+/).filter(function(x){return /icon|crm|module|menu|nav/i.test(x)&&x.length<24;})[0]; return '侧栏图标'+(c?'·'+c:''); }
  var nodes=document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=menuitem],[role=tab],[role=option],[onclick],.ant-btn,.ant-menu-item,li[role],[class*=btn],.ant-modal-close,.ant-modal-footer button,[class*=menu] li,[class*=nav] li,[class*=sider] li,[class*=aside] li,[class*=aside] a,[aria-label],[title]');
  var out=[],seen={}; for(var i=0;i<nodes.length&&out.length<80;i++){ var n=nodes[i]; if(!vis(n)) continue; var text=((n.innerText||n.value||(n.getAttribute&&(n.getAttribute('placeholder')||n.getAttribute('aria-label')||n.getAttribute('title')))||'')+'').replace(/\\s+/g,' ').trim().slice(0,40); var tag=n.tagName.toLowerCase(); if(!text){ if(inRail(n)){ text='〔'+railLabel(n)+'〕'; } else if(tag!=='input'&&tag!=='textarea'&&tag!=='select'){ continue; } } var s=gen(n); if(seen[s]) continue; seen[s]=1; out.push({tag:tag, role:(n.getAttribute&&n.getAttribute('role'))||'', text:text, sel:s}); }
  return out;
}`

function norm(s) { return String(s || '').replace(/[\s*：:]/g, '') }
export function stepsToReadable(steps) {
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
export async function runAgentic(page, steps, fieldValues, sop, hooks) {
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
    catch (e) { /* 精确/包含档失手 → 近似档 */ }
    const fz = await fuzzyClickOption(page, RESULT_SEL, value)
    if (fz.ok) return fz
    return { ok: false, error: '未匹配到选项「' + value + '」' }
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
    // 哈希路由 SPA：导航类点击直接改 hash 跳转（绕过折叠菜单 + 悬停展开）
    if (step.act === 'click' && step.nav) {
      if (log) log(`[${i + 1}/${steps.length}] 跳转 ${step.nav}`)
      let navOk = true
      try { await page.evaluate((h) => { if (location.hash !== h) location.hash = h }, step.nav) } catch (_) { navOk = false }
      if (navOk) { await settle(); done++; prevAct = 'click'; await sleep(200); continue }
      if (log) log('hash 跳转失败 → 回退点击/智能体')
    }
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

// ============ 实验引擎：SOP 驱动 + 原生 tool calling（DeepSeek 等）============
// 不回放任何录制选择器：每轮抓真实页面快照 → 模型用 browser_action 工具决策 → Playwright 执行。
// hooks.chat(messages, tools) 必须返回模型的 message 对象（含 tool_calls）。
const TOOLS_SOP = [{
  type: 'function',
  function: {
    name: 'browser_action',
    description: '在当前网页执行一个操作。每次只做一步。完成整个 SOP 后用 action="finish"；确实无法继续（未登录/无权限/目标不存在）用 action="stop"。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'fill', 'select', 'search', 'hover', 'finish', 'stop'], description: '动作类型' },
        index: { type: 'integer', description: '要操作的元素编号（来自“当前页面可交互元素清单”）；finish/stop 时填 -1' },
        value: { type: 'string', description: 'fill/select/search 时要填入或选择的值' },
        reason: { type: 'string', description: '这一步在做什么（简述）' }
      },
      required: ['action', 'index']
    }
  }
}]

export async function runAgenticSop(page, opts, hooks) {
  const { chat, log } = hooks || {}
  const RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .j-search-item, .el-autocomplete-suggestion li'
  const ACTIONABLE = ['button', 'textbox', 'searchbox', 'combobox', 'menuitem', 'menuitemcheckbox', 'link', 'checkbox', 'radio', 'option', 'tab', 'switch']
  const FIELD_ROLES = ['textbox', 'searchbox', 'combobox']
  async function settle(maxMs = 8000) {
    try { await page.waitForLoadState('domcontentloaded', { timeout: maxMs }) } catch (_) {}
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      const loading = await page.evaluate(`(function(){try{ if(document.querySelector('.ant-spin-spinning,.ant-spin-dot,.el-loading-mask,[class*=loading]:not([class*=loaded])')) return true; var t=document.body?document.body.innerText:''; return t.indexOf('努力加载中')!==-1||t.indexOf('加载中...')!==-1; }catch(e){ return false; }})()`).catch(() => false)
      if (!loading) break
      await sleep(300)
    }
    await sleep(250)
  }
  async function pageCtx() { try { return await page.evaluate(`(function(){ return { u: location.href, t: (document.title||'').slice(0,60) }; })()`) } catch (_) { return { u: '', t: '' } } }
  // 新建表单可能在 iframe 里 → 找到含纷享字段的那个 frame，所有操作都在它上面做
  async function getFormFrame() {
    for (const f of page.frames()) {
      try { if (await f.locator('.f-item-inner.j-comp-wrap, .crm-a-field-selectone, .crm-action-field-lookup, .crm-widget').count()) return f } catch (_) {}
    }
    return page.mainFrame()
  }
  // 找当前激活的表单容器（讯飞表单不叫 dialog/modal）→ 结构识别：
  // 从"提交/保存草稿/确定"这类表单底栏按钮往上找到含≥2 输入框的容器，就是表单。打标后返回 locator。
  async function activeDialog() {
    let sel = null
    try {
      sel = await page.evaluate(() => {
        const vis = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 220 && r.height > 140 } catch (e) { return false } }
        document.querySelectorAll('[data-iml-dialog]').forEach(e => e.removeAttribute('data-iml-dialog'))
        // ① 优先：含纷享表单字段(.f-item-inner.j-comp-wrap)最多的可见容器 —— 这才是真业务表单，避免被待办/通知弹窗误困
        const fxCells = Array.from(document.querySelectorAll('.f-item-inner.j-comp-wrap')).filter(vis)
        if (fxCells.length >= 2) {
          let best = null, bestN = 0
          for (const c of fxCells) {
            let e = c.parentElement
            for (let up = 0; up < 12 && e; up++) {
              const cnt = e.querySelectorAll ? e.querySelectorAll('.f-item-inner.j-comp-wrap').length : 0
              if (cnt > bestN && vis(e) && cnt >= 2) { bestN = cnt; best = e }
              e = e.parentElement
            }
          }
          if (best) { best.setAttribute('data-iml-dialog', '1'); return '[data-iml-dialog="1"]' }
        }
        // ② 兜底：从"提交/保存草稿"底栏按钮往上找含≥2 输入框的容器
        const cands = Array.from(document.querySelectorAll('button,[class*=btn],[role=button],span,a'))
          .filter((b: any) => { const t = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim(); return /^(提交|保存草稿|提交并新建)$/.test(t) })
        for (const b of cands) {
          let e = b
          for (let up = 0; up < 14 && e; up++) {
            if (e.querySelectorAll && e.querySelectorAll('input:not([type=hidden]),textarea,[role=textbox],[role=combobox]').length >= 2 && vis(e)) {
              e.setAttribute('data-iml-dialog', '1'); return '[data-iml-dialog="1"]'
            }
            e = e.parentElement
          }
        }
        return null
      })
    } catch (_) { sel = null }
    if (!sel) return null
    try { const dlg = page.locator(sel).first(); if (await dlg.count()) return dlg } catch (_) {}
    return null
  }
  // 扫描"按钮样式的无 role span/div"（讯飞 新建/提交=<span class=crm-btn>，AX 看不到）。真函数，自包含。
  const SCAN_CLICKABLE = (root) => {
    root = root || document
    const vis = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
    const sel = 'button,[role=button],[class*=btn],[class*=Btn],[class*=button],[onclick],[class*=menu-item],[class*=menuItem],[class*=tab-item],[class*=action-item],[class*=crm-btn]'
    const nodes = root.querySelectorAll(sel), out = [], seen = {}
    for (let i = 0; i < nodes.length && out.length < 40; i++) {
      const n = nodes[i]; if (!vis(n)) continue
      const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 16) continue
      if (seen[t]) continue; seen[t] = 1; out.push(t)
    }
    return out
  }
  // 语义感知：AX 树（缩到弹窗若有，管表单字段）+ DOM 按钮扫描（管无 role 的 span 假按钮）
  async function perceive() {
    const dlg = await activeDialog()
    let root; if (dlg) { try { root = await dlg.elementHandle() } catch (_) {} }
    let ax = null
    try { ax = await page.accessibility.snapshot({ interestingOnly: root ? false : true, root: root || undefined }) } catch (_) {}
    if (!ax && root) { try { ax = await page.accessibility.snapshot({ interestingOnly: true }) } catch (_) {} }
    const flat = []
    ;(function w(n) { if (!n) return; flat.push({ role: n.role, name: (n.name || '').trim() }); (n.children || []).forEach(w) })(ax || {})
    const out = [], seen = new Set()
    for (let i = 0; i < flat.length; i++) {
      const n = flat[i]
      if (!ACTIONABLE.includes(n.role)) continue
      let name = n.name
      // 只给无名输入借真正的表单标签 LabelText（不借随机文字，免造假字段）
      if (!name && FIELD_ROLES.includes(n.role)) {
        for (let j = Math.max(0, i - 3); j < Math.min(flat.length, i + 4); j++) {
          if (flat[j].role === 'LabelText' && flat[j].name) { name = flat[j].name; break }
        }
      }
      if (!name) continue
      const k = n.role + '|' + name; if (seen.has(k)) continue; seen.add(k)
      out.push({ role: n.role, name })
    }
    // 合并 DOM 扫描到的 span 假按钮（AX 漏的），role 标为 button，去重
    let clickables = []
    try { clickables = root ? await root.evaluate(SCAN_CLICKABLE) : await page.evaluate(SCAN_CLICKABLE) } catch (_) {}
    for (const t of clickables) {
      if (seen.has('button|' + t) || seen.has('link|' + t) || seen.has('menuitem|' + t) || seen.has('tab|' + t)) continue
      seen.add('button|' + t); out.push({ role: 'button', name: t })
    }
    // 打开的下拉/级联浮层常挂在 body（脱离表单作用域）→ 把可见选项并入清单，模型才能选
    let popupOpts = []
    try {
      popupOpts = await page.evaluate(() => {
        const vis = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
        const POP = '.ant-select-dropdown:not(.ant-select-dropdown-hidden),.ant-cascader-menus,[role=listbox],[class*=select-dropdown],[class*=cascader],[class*=dropdown-menu],[class*=picker-panel],[class*=options-wrap],.j-search-list,[class*=suggest]'
        const out = [], seen = {}
        document.querySelectorAll(POP).forEach((pop) => {
          if (!vis(pop)) return
          pop.querySelectorAll('li,[role=option],[class*=item],[class*=option],a,dd').forEach((n: any) => {
            if (!vis(n) || n.querySelector('li,[role=option]')) return
            const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim()
            if (!t || t.length > 24 || seen[t]) return
            seen[t] = 1; out.push(t)
          })
        })
        return out.slice(0, 30)
      })
    } catch (_) {}
    for (const t of popupOpts) { const k = 'option|' + t; if (!seen.has(k) && !seen.has('button|' + t) && !seen.has('menuitem|' + t)) { seen.add(k); out.push({ role: 'option', name: t }) } }
    // 纷享销客表单：按 data-type/data-apiname + .f-g-item-tit 真标签枚举字段（在表单所在 frame 里）
    let fxFields = []
    const ff = await getFormFrame()
    try {
      fxFields = await ff.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
        const out = []
        // 体检验证过的遍历：从 .f-g-item / .f-item-wrap 容器取真实标签 + 控件类型
        document.querySelectorAll('.f-g-item, [class*=f-item-wrap]').forEach((w) => {
          const titEl = w.querySelector('.f-g-item-tit, .f-item-tit, [class*=item-tit]')
          const label = norm(titEl ? titEl.textContent : '').replace(/^[*\s]+/, '').replace(/[?？*\s]+$/, '')
          if (!label || label.length > 20) return
          const inner = w.querySelector('.f-item-inner.j-comp-wrap, .crm-a-field-selectone, .crm-action-field-lookup, [data-type]')
          if (!inner || !vis(inner)) return
          let dtype = (inner.getAttribute && inner.getAttribute('data-type')) || ''
          if (!dtype) {
            const c = (inner.className || '') + ''
            dtype = c.indexOf('selectone') >= 0 ? 'select_one' : c.indexOf('lookup') >= 0 ? 'object_reference'
              : w.querySelector('.select-tit, .j-select-input') ? 'select_one'
              : w.querySelector('.j-search-ipt') ? 'object_reference'
              : w.querySelector('textarea') ? 'long_text' : 'text'
          }
          const apiname = (inner.getAttribute && inner.getAttribute('data-apiname')) || ''
          if (!out.find(o => o.label === label)) out.push({ label, dtype, apiname })
        })
        return out
      })
    } catch (_) {}
    const isNoise = (n) => !n || /^(紧凑|舒适|宽敞|默认|展开|收起)$/.test(n) || (n.indexOf('提交') >= 0 && n.indexOf('取消') >= 0)
    let items = out
    if (fxFields.length) {
      const roleOf = (dt) => dt === 'select_one' ? 'combobox' : dt === 'object_reference' ? 'search' : 'textbox'
      const fxItems = fxFields.map(f => ({ role: roleOf(f.dtype), name: f.label, fx: true, dtype: f.dtype, apiname: f.apiname }))
      // 纷享字段为准，去掉 AX 那些占位名不准的字段类项
      items = [...fxItems, ...out.filter(it => !['textbox', 'searchbox', 'combobox'].includes(it.role))]
    }
    return { items: items.filter(it => !isNoise(it.name)), scoped: !!dlg, dialog: dlg, fxCount: fxFields.length, frames: page.frames().length, formFrameMain: ff === page.mainFrame() }
  }
  // 语义定位（按 role+name，不用脆选择器）。scope=弹窗 locator 或 page
  function locate(node, scope) {
    const s = scope || page, n = node.name
    try {
      if (node.role === 'button') return s.getByRole('button', { name: n }).or(s.getByText(n, { exact: true })).first()
      if (node.role === 'link') return s.getByRole('link', { name: n }).or(s.getByText(n, { exact: true })).first()
      if (node.role === 'textbox' || node.role === 'searchbox') return s.getByRole('textbox', { name: n }).or(s.getByLabel(n)).or(s.getByPlaceholder(n)).first()
      if (node.role === 'combobox') return s.getByRole('combobox', { name: n }).or(s.getByLabel(n)).first()
      if (/^(menuitem|option|tab|checkbox|radio|switch)$/.test(node.role)) return s.getByRole(node.role, { name: n }).or(s.getByText(n, { exact: true })).first()
    } catch (_) {}
    return s.getByText(n, { exact: true }).first()
  }
  // 字段定位：按"标签/占位文字 → 邻近真正可交互控件(.ant-select/input/…)"在页面内打标，返回稳定 locator。
  // 讯飞自定义下拉的占位文字不是可点控件，必须找到外层真正能点开下拉的元素。
  async function tagFieldByLabel(label) {
    let ok = false
    try {
      ok = await page.evaluate((lab) => {
        document.querySelectorAll('[data-iml-target]').forEach(e => e.removeAttribute('data-iml-target'))
        const visN = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
        const CTRL = 'input:not([type=hidden]),textarea,[contenteditable=true],[role=textbox],[role=combobox],.ant-select,.el-select,[class*=select],[class*=picker],[class*=ipt-wrap],[class*=fx-input]'
        // ① 直接命中：placeholder / aria-label / 自身就是占位元素的可点控件
        let direct = null
        const inputs = Array.from(document.querySelectorAll('input,textarea,[role=textbox],[role=combobox]'))
        for (const i of inputs) { const ph = (i.getAttribute('placeholder') || i.getAttribute('aria-label') || '').trim(); if (ph === lab && visN(i)) { direct = i; break } }
        // ② 找到承载该文字的元素（占位 span / 标签），再向上找真正可交互控件
        let anchor = direct
        if (!anchor) {
          const all = Array.from(document.querySelectorAll('label,span,div,dt,th,p,legend,[class*=placeholder]'))
          let node = null
          for (const e of all) { const t = (e.textContent || '').replace(/\s+/g, ' ').trim(); if (t === lab && visN(e)) { node = e; break } }
          if (!node) for (const e of all) { const t = (e.textContent || '').replace(/\s+/g, ' ').trim(); if (t.indexOf(lab) >= 0 && t.length < lab.length + 6 && visN(e)) { node = e; break } }
          if (!node) return false
          // 先在其表单项容器里找真正控件
          let box = node.closest('.ant-form-item,.el-form-item,.form-item,.form-group,tr,li,[class*=field],[class*=form-row],[class*=formItem],[class*=form_item]') || node.parentElement
          let ctrl = null
          for (let up = 0; up < 4 && box && !ctrl; up++) { ctrl = box.querySelector(CTRL); if (!ctrl) box = box.parentElement }
          anchor = ctrl || node.closest(CTRL) || node
        }
        if (!anchor || !visN(anchor)) return false
        anchor.setAttribute('data-iml-target', '1'); return true
      }, label)
    } catch (_) {}
    return ok
  }
  // 字段类优先用"邻近真实控件"定位（占位文字点不开下拉）；按钮/链接用语义定位
  async function resolveLocator(node, scope) {
    if (FIELD_ROLES.includes(node.role) && await tagFieldByLabel(node.name)) return page.locator('[data-iml-target="1"]').first()
    const sem = locate(node, scope)
    try { if (await sem.count() > 0) return sem } catch (_) {}
    if (FIELD_ROLES.includes(node.role) && await tagFieldByLabel(node.name)) return page.locator('[data-iml-target="1"]').first()
    return sem
  }
  async function pickResult(value) {
    try { const opt = page.locator(RESULT_SEL).filter({ hasText: value }).first(); if (await opt.count()) { await opt.click({ timeout: 5000 }); return { ok: true } } } catch (_) {}
    try { const opt = page.getByText(value, { exact: false }).first(); if (await opt.count()) { await opt.click({ timeout: 4000 }); return { ok: true } } } catch (_) {}
    const fz = await fuzzyClickOption(page, RESULT_SEL, value)   // 近似档：唯一赢家才选，并列交智能体兜底
    if (fz.ok) return fz
    return { ok: false, error: '未匹配到结果「' + value + '」' }
  }
  async function act(loc, action, value) {
    try {
      if (action === 'hover') { await loc.hover({ timeout: 5000 }); return { ok: true } }
      if (action === 'click') { await loc.click({ timeout: 7000 }); return { ok: true } }
      if (action === 'fill') { try { await loc.fill(String(value || ''), { timeout: 5000 }); return { ok: true } } catch (e) { await loc.click({ timeout: 4000 }).catch(() => {}); await sleep(600); const pr = await pickResult(value); if (pr.ok) return pr; return { ok: false, error: '该控件不是文本框（可能是下拉），已点开但未匹配到「' + value + '」选项' } } }
      if (action === 'select') { await loc.click({ timeout: 5000 }); await sleep(600); return pickResult(value) }
      if (action === 'search') { await loc.click({ timeout: 4000 }).catch(() => {}); try { await loc.fill(String(value || ''), { timeout: 4000 }) } catch (_) { await page.keyboard.type(String(value || '')) } await sleep(1100); return pickResult(value) }
      return { ok: false, error: '未知动作 ' + action }
    } catch (e) { return { ok: false, error: e.message } }
  }
  // 纷享销客字段操作：按 data-type 用真实控件结构操作
  //  select_one → 点 .select-tit 展开，选项 li 按文字点（支持 星火军团→销售五部 级联）
  //  object_reference → .j-search-ipt 输入，.j-search-list 结果 li 点选
  //  其它 → fill 文本框/textarea
  async function fxFieldOp(node, value) {
    const ff = await getFormFrame()
    let root = node.apiname ? ff.locator(`.f-item-inner.j-comp-wrap[data-apiname="${node.apiname}"]`).first() : null
    if (!root || !(await root.count())) {
      const ok = await ff.evaluate((lab) => {
        document.querySelectorAll('[data-iml-fx]').forEach(e => e.removeAttribute('data-iml-fx'))
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        for (const w of Array.from(document.querySelectorAll('.f-g-item, [class*=f-item-wrap]'))) {
          const t = w.querySelector('.f-g-item-tit,.f-item-tit,[class*=item-tit],label')
          if (t && norm(t.textContent).replace(/^[*\s]+/, '').indexOf(lab) >= 0) { const inner = w.querySelector('.f-item-inner.j-comp-wrap') || w; inner.setAttribute('data-iml-fx', '1'); return true }
        }
        return false
      }, node.name)
      if (!ok) return { ok: false, error: '未定位到字段「' + node.name + '」' }
      root = ff.locator('[data-iml-fx="1"]').first()
    }
    // 选项浮层可能在表单 frame，也可能挂到主文档 → 两处都找
    const pickIn = async (sel, text) => {
      for (const scope of [root, ff, page]) {
        try { const o = scope.locator(sel).filter({ hasText: text }).first(); if (await o.count()) { await o.click({ timeout: 5000 }); return true } } catch (_) {}
      }
      return false
    }
    try {
      if (node.dtype === 'select_one') {
        await root.locator('.select-tit, .j-select-input, .ipt-target, .select-icon, .tit-con').first().click({ timeout: 5000 })
        await sleep(900)
        if (!value) return { ok: true }
        const parts = String(value).split(/→|->|\/|、|，|,/).map(s => s.trim()).filter(Boolean)
        let okAll = true
        for (const part of (parts.length ? parts : [String(value)])) {
          let got = await pickIn('.j-search-item, .crm-w-select li, [class*=select-list] li, [class*=options] li, li[class*=item], [role=option], .crm-w-select-dropdown li, dd, li', part)
          if (!got) { // 兜底：整页/frame 按可见文本精确找选项点击
            for (const scope of [ff, page]) { try { const o = scope.getByText(part, { exact: true }).first(); if (await o.count() && await o.isVisible().catch(() => false)) { await o.click({ timeout: 4000 }); got = true; break } } catch (_) {} }
          }
          if (got) await sleep(600); else okAll = false
        }
        return okAll ? { ok: true } : { ok: false, error: '下拉里没匹配到「' + value + '」（选项文字可能与给定值不一致）' }
      }
      if (node.dtype === 'object_reference') {
        const ipt = root.locator('.j-search-ipt, input.search-ipt, input[type=text], input').first()
        await ipt.click({ timeout: 4000 }).catch(() => {})
        if (!value) return { ok: true }
        await ipt.fill(String(value), { timeout: 4000 })
        await sleep(1300)
        const got = await pickIn('.j-search-list li, .result-wrap li, li[class*=search-item], li', value)
        return got ? { ok: true } : { ok: false, error: '检索「' + value + '」无匹配结果' }
      }
      const ta = root.locator('textarea, input[type=text], [contenteditable=true], input').first()
      await ta.fill(String(value || ''), { timeout: 5000 })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }
  // 读取提交后弹出的遮罩/提示/校验信息（toast、弹窗、必填红字），用于直接返回处理结果
  async function readResultMsg() {
    try {
      return await page.evaluate(() => {
        const vis = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
        const sels = '.ant-message, .ant-message-notice, .ant-notification, [class*=toast], [class*=message-content], [class*=tip-content], [class*=crm-tip], [class*=notify], [class*=error-tip], [class*=err-tip], [class*=f-error], [class*=form-error], [class*=field-error], [class*=validate], [class*=required-tip], [role=alert], .ant-modal-confirm-body, [class*=dialog-tip], [class*=result-msg]'
        const out = []
        document.querySelectorAll(sels).forEach((n: any) => { if (vis(n)) { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 160 && out.indexOf(t) < 0) out.push(t) } })
        return out.slice(0, 6).join(' ｜ ')
      })
    } catch (_) { return '' }
  }
  // 抓取页面实际内容（取文本最多的 frame，覆盖 iframe 列表/详情）
  async function scrapeContent() {
    let best = ''
    for (const f of page.frames()) {
      try { const t = await f.evaluate(() => (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim()); if (t && t.length > best.length) best = t } catch (_) {}
    }
    return best.slice(0, 4000)
  }
  // navHash 直达：整页 goto(基址 + #路由) 强制 SPA 加载到目标路由，校验未到位则重试
  if (opts.navHash) {
    if (log) log('直达 ' + opts.navHash)
    const want = opts.navHash.replace(/^#/, '')
    const arrived = async () => { const u = (await pageCtx()).u || ''; return u.indexOf(want) >= 0 }
    for (let tryN = 1; tryN <= 3; tryN++) {
      try {
        const base = ((await pageCtx()).u || '').split('#')[0]
        if (tryN === 1) await page.goto(base + opts.navHash, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        else await page.evaluate((h) => { location.hash = h }, opts.navHash).catch(() => {})
        await settle(); await sleep(800)
      } catch (_) {}
      if (await arrived()) break
      if (tryN < 3 && log) log(`直达未到位，重试(${tryN + 1})…`)
      await sleep(1200)
    }
    if (!(await arrived())) { if (log) log('⚠️ 直达未生效：当前未停在目标路由。可能门户与 CRM 非同一上下文，或 navHash 失效。') }
    else {
      const t = (await pageCtx()).t; if (log) log('已直达：' + (t || '目标页'))
      // 等列表工具栏渲染出来（新建按钮真出现）再感知，避免过早读页导致模型找不到入口乱跳
      let ready = false
      for (let w = 0; w < 14; w++) {
        ready = await page.evaluate(() => { try { return Array.from(document.querySelectorAll('button,[class*=btn],span,a,[role=button]')).some((e: any) => /^新建$/.test((e.innerText || e.textContent || '').trim()) && e.offsetParent !== null) } catch (e) { return false } }).catch(() => false)
        if (ready) break
        await sleep(700)
      }
      if (log) log(ready ? '列表已就绪（找到「新建」入口）' : '⚠️ 等了一会儿仍没出现「新建」入口，可能列表加载慢')
    }
  }
  const fieldLines = Object.entries(opts.fieldValues || {}).map(([k, v]) => `- ${k} = ${v}`).join('\n')
  const sys = `你是企业业务系统（讯飞/纷享CRM 等网页）的浏览器自动化执行器。严格按 SOP 一步步操作，每轮只调用一次 browser_action 完成一步。
系统每轮给你“当前可操作元素清单（带编号、含无障碍角色 role 和名称 name）”，你按 index 选要操作的元素。元素都是真实可操作控件（button/textbox/combobox/link 等），按 SOP 语义对应选择。
规则：
- 表单弹窗打开后，清单会自动缩到弹窗内字段，优先在其中找目标。
- **只操作 SOP 当前步要求的字段。绝不要点 SOP 没提到的字段（尤其"点击选择日期"这类日期框）。** 若清单里出现日历相关项（如"前一年/后一年/2026 年/2020 年-2029 年"），那是误触的日历浮层——直接忽略它们，回到 SOP 要求的字段继续，不要去点它们试图关闭。
- 文本框用 action="fill"；下拉/检索类（combobox，或 SOP 要求“检索并选择/选择”）用 action="search"（会自动输入并选中匹配项）。
- 填值只用下面“已确认字段值”里给的，绝不编造。
- 每步结果会告诉你是否已聚焦弹窗、页面是否变化；别重复点同一个已完成的元素。
- 全部 SOP 完成 → action="finish"；确实无法继续（未登录/无权限/目标不存在）→ action="stop"。

## SOP
${opts.sop || '（无 SOP，按常识完成当前表单录入）'}

## 已确认字段值（只填这些）
${fieldLines || '（无）'}`
  const messages: any[] = [{ role: 'system', content: sys }]
  const maxTurns = opts.maxTurns || 30
  let did = 0, repeatKey = '', repeatN = 0, noProgress = 0, prevCount = 0
  const filledFields = new Set(), failCount = {}, skipped = new Set()
  const FIELD_ACT = /^(fill|search|select)$/
  const summary = () => `已填 ${filledFields.size} 个字段[${[...filledFields].join('、') || '无'}]` + (skipped.size ? `；哑火 ${skipped.size} 个[${[...skipped].join('、')}]` : '')
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (log) log(`· 第 ${turn} 轮：读取页面元素…`)
    let perc
    try { perc = await perceive() } catch (e) { if (log) log('感知页面出错：' + e.message); return { ok: did > 0, done: did, reason: '感知页面出错：' + e.message } }
    const { items, scoped, dialog } = perc
    const ctx = await pageCtx()
    if (log) log(`  感知到 ${items.length} 个可操作元素${scoped ? '（已聚焦弹窗表单）' : '（整页）'}；纷享字段 ${perc.fxCount}｜frame数 ${perc.frames}｜表单在${perc.formFrameMain ? '主框架' : 'iframe'}`)
    if (!items.length) { if (log) log('  ⚠️ 未感知到可操作元素，等待后重试…'); await settle(); if (turn >= 3) return { ok: did > 0, done: did, reason: '连续读不到页面可操作元素' }; continue }
    const list = items.map((e, i) => `${i}. ${e.role} 「${e.name}」`).join('\n')
    messages.push({ role: 'user', content: `当前页面：「${ctx.t || ''}」${scoped ? ' · 已聚焦弹窗表单' : ''}\n可操作元素清单（${items.length}）：\n${list}\n\n请执行 SOP 的下一步。` })
    let msg
    try { msg = await chat(messages, TOOLS_SOP) } catch (e) { if (log) log('模型调用失败：' + e.message); return { ok: false, done: did, reason: '模型调用失败：' + e.message } }
    const tc = msg && msg.tool_calls && msg.tool_calls[0]
    if (!tc) { if (log) log('模型未给出工具调用，停止'); return { ok: did > 0, done: did, reason: '模型未给出工具调用' } }
    let args: any = {}; try { args = JSON.parse(tc.function.arguments || '{}') } catch (_) {}
    messages.push({ role: 'assistant', content: null, tool_calls: [tc] })
    if (args.action === 'finish') {
      if (log) log(`✅ 完成（共 ${did} 步操作）`)
      // 抓取页面实际内容并按 SOP 汇总，作为"实际结果"返回（读取类技能尤其需要）
      let result = ''
      try {
        if (log) log('  正在读取页面实际内容并汇总…')
        const content = await scrapeContent()
        if (content && content.length > 20) {
          const sm = await chat([
            { role: 'system', content: '你是业务助手。根据"页面抓取内容"，按 SOP 的反馈要求，简洁汇总本次操作的【实际结果】给用户：列表就给要点+总数，记录就复述关键字段；只依据抓取内容，不编造。' },
            { role: 'user', content: `SOP：\n${(opts.sop || '').slice(0, 1200)}\n\n页面抓取内容：\n"""${content.slice(0, 3000)}"""\n\n请汇总【实际结果】：` }
          ], undefined)
          result = (sm && sm.content) ? String(sm.content).trim() : ''
        }
      } catch (_) {}
      const baseReason = skipped.size ? ('完成可填字段，但这些控件没成功：' + [...skipped].join('、') + '（' + summary() + '）') : '完成'
      return { ok: skipped.size === 0, done: did, reason: baseReason, result, filled: [...filledFields], skipped: [...skipped] }
    }
    if (args.action === 'stop') { if (log) log('⛔ 停止：' + (args.reason || '')); return { ok: false, done: did, reason: (args.reason || '模型判定无法继续') + '｜' + summary(), filled: [...filledFields], skipped: [...skipped] } }
    const node = items[args.index]
    if (log) log(`[${turn}] ${args.action} ${node ? (node.role + '「' + node.name + '」') : ('#' + args.index)}${args.value ? ' = ' + args.value : ''}${args.reason ? ' · ' + args.reason : ''}`)
    // 已多次失败的字段 → 拦截，逼模型跳过，别死磕一个控件
    if (node && skipped.has(node.name) && FIELD_ACT.test(args.action)) {
      if (log) log('  ⏭ 跳过已哑火字段：' + node.name)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: '「' + node.name + '」之前已多次尝试失败，已标记跳过。不要再操作它。请继续完成 SOP 里其它还没填的字段；若其它都填完了就 finish。' })
      continue
    }
    // 拦截"放弃表单"类按钮：取消/返回/关闭会丢进度，绝不允许
    if (node && /^(取消|返回|关闭|cancel|×|✕|x|关闭弹窗)$/i.test(node.name)) {
      if (log) log('  ⛔ 拦截放弃类按钮：' + node.name)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: '⛔ 已拦截「' + node.name + '」：不要点取消/返回/关闭，会放弃整个表单、丢失进度。请按 SOP 在当前表单里填写字段；若有必填项挡路（如“请先选择销售平台归属”），先把它选好，其余字段才会出现。' })
      continue
    }
    let result
    if (!node) { result = '编号 ' + args.index + ' 无效，请重新选择' }
    else {
      const scope = scoped && dialog ? dialog : page
      let r
      if (node.fx && /^(fill|search|select|click)$/.test(args.action)) r = await fxFieldOp(node, args.value)
      else { const loc = await resolveLocator(node, scope); r = await act(loc, args.action, args.value) }
      await settle()
      // 提交/保存类点击后：读弹出的处理结果/校验信息，有就直接返回结果，不再瞎点
      if (r.ok && args.action === 'click' && /(提交|保存草稿|确定|提交并新建|保存)/.test(node.name)) {
        await sleep(1500)
        const msg = await readResultMsg()
        if (msg) {
          const ok = /(成功|已提交|已保存|创建成功|新增成功|操作成功|提交成功)/.test(msg) && !/(失败|错误|不能为空|必填|请填写|请选择|不允许|未填)/.test(msg)
          if (log) log((ok ? '✅ 处理结果：' : '⚠️ 系统反馈：') + msg)
          return { ok, done: did, reason: msg, filled: [...filledFields], skipped: [...skipped] }
        }
      }
      const after = await pageCtx()
      const changed = after.u !== ctx.u
      const isField = FIELD_ACT.test(args.action) && node.name
      if (r.ok) {
        did++; result = '已执行。' + (changed ? '页面已跳转。' : '')
        if (isField) { filledFields.add(node.name); failCount[node.name] = 0; skipped.delete(node.name) }
      } else {
        result = '操作失败：' + (r.error || '')
        if (isField) {
          failCount[node.name] = (failCount[node.name] || 0) + 1
          if (failCount[node.name] >= 2) { skipped.add(node.name); result += `。「${node.name}」已失败 ${failCount[node.name]} 次，标记跳过——请不要再操作它，去填 SOP 里其它字段，全部能填的填完就 finish。` }
          else result += '（可换一种动作；仍不行就跳过它做别的）'
        }
      }
      const key = node.name
      if (key === repeatKey) repeatN++; else { repeatKey = key; repeatN = 0 }
      if (repeatN >= 3 && node.name && !skipped.has(node.name)) { skipped.add(node.name); result += ` ⚠️ 已连续操作「${node.name}」多次，标记跳过，请做别的字段。` }
      // 无进展熔断：连续多步既没成功录入、表单也没变化 → 收尾（按已填情况判定，不再耗步数）
      const grew = items.length > prevCount + 1
      if ((r.ok && isField) || changed || grew) noProgress = 0; else noProgress++
      prevCount = items.length
      if (noProgress >= 7) {
        const msg = await readResultMsg()
        if (log) log('⛔ 连续多步无进展，收尾' + (msg ? '；系统反馈：' + msg : ''))
        return { ok: false, done: did, reason: (msg ? '系统反馈：' + msg + '。' : '') + summary() + (msg ? '（多为提交校验未过，请把缺的必填项补进 SOP）' : '。未成功的多为特殊下拉控件，可单独诊断或录制。'), filled: [...filledFields], skipped: [...skipped] }
      }
    }
    messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
  }
  return { ok: false, done: did, reason: '达到最大步数。' + summary(), filled: [...filledFields], skipped: [...skipped] }
}


