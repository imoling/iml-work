// 桌面桌宠「召唤小影」：置顶无边框小窗里的工作分身桌宠（果冻质感、会呼吸眨眼、可拖拽），
// 点击召唤/聚焦主窗口。开关持久化在本地 config（沿用旧键 float-ball 保持兼容），随应用启动恢复。
// 小影 = 方案 C「影分身」具象化，定稿 SVG 源与生成脚本见 docs/logo-proposals-2026-08-14。
//
// 状态联动：agent 管线（ipc/agent-core.ts）在任务起止时调 ballTaskStarted/Finished，
// 日志流经 ballLogHint 粗分动作——检索/浏览类 → reading（举放大镜细读），其余 → working（分身环+冒汗）。
// 窗口默认鼠标穿透（气泡区不挡桌面点击），指针悬到小影身上才接管事件。
import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { configGet, configSet } from './db'
import { getMainWindow } from './window-ref'
import { swallow } from './util'

let ball: BrowserWindow | null = null

const WIN_W = 192
const WIN_H = 172

// 动效全在页面侧：呼吸/呆毛摆动/随机眨眼常驻；QQ 弹（悬停/松手 boing、抓起压扁）；
// working=虚线分身环+太阳穴汗滴、reading=举放大镜扫读、done=眯眼笑+开口+跳起；
// 语言气泡偶发（闲聊 50~140s 一句、状态切换各说一句），配合招手。
const BALL_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none;-webkit-user-select:none}
  body{width:${WIN_W}px;height:${WIN_H}px;position:relative;font-family:-apple-system,'PingFang SC',sans-serif}
  #bubble{position:absolute;bottom:108px;right:6px;max-width:168px;background:#FFFFFF;color:#17222B;
    font-size:12px;line-height:1.5;padding:7px 11px;border-radius:12px;
    box-shadow:0 4px 14px rgba(15,23,32,.18);opacity:0;transform:scale(.7);transform-origin:78% 100%;
    transition:all .25s cubic-bezier(.34,1.56,.64,1);pointer-events:none}
  #bubble.show{opacity:1;transform:scale(1)}
  #bubble::after{content:'';position:absolute;right:34px;bottom:-4px;width:10px;height:10px;background:#FFFFFF;
    transform:rotate(45deg);border-radius:2px}
  #hit{position:absolute;right:4px;bottom:2px;width:104px;height:124px;cursor:grab;transform-origin:50% 92%}
  #hit.grab{cursor:grabbing}
  #hit.boing{animation:boing .6s cubic-bezier(.34,1.56,.64,1)}
  @keyframes boing{0%{transform:scale(1.14,.84)}32%{transform:scale(.9,1.08)}58%{transform:scale(1.06,.95)}80%{transform:scale(.97,1.02)}100%{transform:scale(1,1)}}
  #jelly{transform-origin:120px 206px;transition:transform .18s cubic-bezier(.34,1.56,.64,1);animation:breath 3.4s ease-in-out infinite}
  #hit.grab #jelly{transform:scale(1.08,.9)}
  @keyframes breath{0%,100%{transform:scale(1,1)}50%{transform:scale(1.02,.965)}}
  #antenna{transform-origin:122px 46px;animation:sway 4.2s ease-in-out infinite}
  @keyframes sway{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(7deg)}}
  .eye{transform-box:fill-box;transform-origin:center}
  .blink .eye{animation:blink .16s ease-in-out}
  @keyframes blink{50%{transform:scaleY(.08)}}
  #echo,#sweat,#mag,#eyesH,#mouthO,#armsUp,#feetStand{opacity:0}
  body.working #echo,body.reading #echo{opacity:1;animation:echoPulse 1.8s ease-in-out infinite}
  @keyframes echoPulse{0%,100%{opacity:.6}50%{opacity:.28}}
  body.working #sweat{opacity:1;animation:drip 1.8s ease-in-out infinite}
  @keyframes drip{0%{transform:translateY(0);opacity:1}60%{opacity:1}100%{transform:translateY(11px);opacity:0}}
  body.reading #mag{opacity:1;animation:scan 2.6s ease-in-out infinite;transform-origin:178px 166px}
  @keyframes scan{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(7deg)}}
  body.reading #armR,body.reading #sweat{opacity:0}
  body.done #eyesN,body.done #smile,body.done #armL,body.done #armR,body.done #feetSit{opacity:0}
  body.done #eyesH,body.done #mouthO,body.done #armsUp,body.done #feetStand{opacity:1}
  body.done #jelly{animation:jump .85s cubic-bezier(.34,1.56,.64,1) 2}
  @keyframes jump{0%,100%{transform:translateY(0)}30%{transform:translateY(-16px) scale(1.03,.97)}55%{transform:translateY(0) scale(1.01,.99)}72%{transform:translateY(-7px)}}
  body.done #shadow{transform-origin:120px 218px;animation:shsq .85s cubic-bezier(.34,1.56,.64,1) 2}
  @keyframes shsq{0%,100%{transform:scale(1)}30%{transform:scale(.68);opacity:.6}55%{transform:scale(1)}72%{transform:scale(.82)}}
  body.waving #armR{animation:wave 1.3s ease-in-out;transform-origin:180px 162px}
  @keyframes wave{0%,100%{transform:rotate(0)}25%{transform:rotate(-72deg)}45%{transform:rotate(-38deg)}65%{transform:rotate(-72deg)}}
  body.cast #armL{animation:castL .6s ease-out;transform-origin:60px 162px}
  @keyframes castL{0%,100%{transform:rotate(0)}30%,70%{transform:rotate(64deg)}}
  body.cast #armR{animation:castR .6s ease-out;transform-origin:180px 162px}
  @keyframes castR{0%,100%{transform:rotate(0)}30%,70%{transform:rotate(-64deg)}}
  body.cast #echo{opacity:.7;transform-origin:120px 120px;animation:burst .6s ease-out forwards}
  @keyframes burst{0%{transform:translate(-18px,-16px) scale(.98);opacity:.7}100%{transform:translate(-34px,-44px) scale(1.18);opacity:0}}
</style></head>
<body>
<div id="bubble"></div>
<div id="hit">
<svg id="m" viewBox="0 0 240 240" width="104" height="124" preserveAspectRatio="xMidYMax meet" fill="none">
 <defs>
  <radialGradient id="rgb" cx="0.35" cy="0.25" r="0.95"><stop offset="0" stop-color="#A5E4FB"/><stop offset="0.5" stop-color="#3BBDF5"/><stop offset="1" stop-color="#1466C8"/></radialGradient>
  <radialGradient id="rgl" cx="0.35" cy="0.3" r="1"><stop offset="0" stop-color="#46C2F5"/><stop offset="1" stop-color="#1257B8"/></radialGradient>
  <radialGradient id="rgf" cx="0.4" cy="0.3" r="1"><stop offset="0" stop-color="#2A8FE0"/><stop offset="1" stop-color="#0F4699"/></radialGradient>
  <radialGradient id="rgw"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  <radialGradient id="rgs"><stop offset="0" stop-color="#17222B" stop-opacity="0.32"/><stop offset="1" stop-color="#17222B" stop-opacity="0"/></radialGradient>
 </defs>
 <ellipse id="shadow" cx="120" cy="218" rx="58" ry="11" fill="url(#rgs)"/>
 <g id="jelly">
  <path id="echo" d="M120 44C158 44 186 58 188 96C190 128 190 158 184 176C176 200 152 206 120 206C88 206 64 200 56 176C50 158 50 128 52 96C54 58 82 44 120 44Z" transform="translate(-18 -16)" stroke="#ED1C24" stroke-width="8" stroke-linecap="round" stroke-dasharray="16 18"/>
  <g id="antenna"><path d="M122 46Q120 30 130 22" stroke="#1466C8" stroke-width="6" stroke-linecap="round"/><circle cx="133" cy="19" r="8" fill="#ED1C24"/><circle cx="130.5" cy="16.5" r="2.5" fill="#FFFFFF"/></g>
  <g id="feetStand"><ellipse cx="96" cy="212" rx="15" ry="10" fill="url(#rgf)"/><ellipse cx="144" cy="212" rx="15" ry="10" fill="url(#rgf)"/></g>
  <path d="M120 44C158 44 186 58 188 96C190 128 190 158 184 176C176 200 152 206 120 206C88 206 64 200 56 176C50 158 50 128 52 96C54 58 82 44 120 44Z" fill="url(#rgb)"/>
  <ellipse cx="94" cy="78" rx="44" ry="26" fill="url(#rgw)" transform="rotate(-16 94 78)"/>
  <circle cx="152" cy="66" r="6" fill="#FFFFFF" opacity="0.7"/>
  <g id="armL"><ellipse cx="60" cy="178" rx="14" ry="18" transform="rotate(26 60 178)" fill="url(#rgl)"/></g>
  <g id="armR"><ellipse cx="180" cy="178" rx="14" ry="18" transform="rotate(-26 180 178)" fill="url(#rgl)"/></g>
  <g id="armsUp"><ellipse cx="42" cy="96" rx="13" ry="21" transform="rotate(40 42 96)" fill="url(#rgl)"/><ellipse cx="198" cy="96" rx="13" ry="21" transform="rotate(-40 198 96)" fill="url(#rgl)"/></g>
  <g id="mag"><ellipse cx="182" cy="152" rx="13" ry="18" transform="rotate(-40 182 152)" fill="url(#rgl)"/>
    <path d="M184 136L176 148" stroke="#1D2A35" stroke-width="7" stroke-linecap="round"/>
    <circle cx="192" cy="122" r="17" fill="#CFF7E8" fill-opacity="0.5" stroke="#1D2A35" stroke-width="6"/></g>
  <g id="feetSit"><ellipse cx="90" cy="202" rx="19" ry="12" transform="rotate(14 90 202)" fill="url(#rgf)"/>
  <ellipse cx="150" cy="202" rx="19" ry="12" transform="rotate(-14 150 202)" fill="url(#rgf)"/></g>
  <g id="sweat"><path d="M176 72C184 84 184 96 176 99C168 96 168 84 176 72Z" fill="#ED1C24"/></g>
  <g id="eyesN">
   <g class="eye"><circle cx="92" cy="118" r="13" fill="#1D2A35"/><circle cx="87" cy="113" r="4.5" fill="#FFFFFF"/><circle cx="96" cy="122" r="2" fill="#FFFFFF" opacity="0.8"/></g>
   <g class="eye"><circle cx="148" cy="118" r="13" fill="#1D2A35"/><circle cx="143" cy="113" r="4.5" fill="#FFFFFF"/><circle cx="152" cy="122" r="2" fill="#FFFFFF" opacity="0.8"/></g>
  </g>
  <g id="eyesH"><path d="M80 118Q92 106 104 118" stroke="#1D2A35" stroke-width="9" stroke-linecap="round"/><path d="M136 118Q148 106 160 118" stroke="#1D2A35" stroke-width="9" stroke-linecap="round"/></g>
  <ellipse cx="72" cy="142" rx="10" ry="6" fill="#FFE3B8" opacity="0.55"/>
  <ellipse cx="168" cy="142" rx="10" ry="6" fill="#FFE3B8" opacity="0.55"/>
  <path id="smile" d="M104 148Q120 162 136 148" stroke="#14202B" stroke-width="9" stroke-linecap="round"/>
  <g id="mouthO"><path d="M102 144A18 14 0 0 0 138 144Z" fill="#14202B"/><ellipse cx="120" cy="150" rx="7" ry="3.5" fill="#FF9D7E"/></g>
 </g>
</svg></div>
<script>
(function(){
  var api=window.api, body=document.body
  var hit=document.getElementById('hit'), m=document.getElementById('m'), bubble=document.getElementById('bubble')
  var IDLE=['今天也要元气满满','有活随时喊我','摸完这条鱼就开卷','我是小影，你的工作分身','喊我一声，活我来干']
  var CLICK=['嗯？','双击我，变！','再点一下召唤工作台','别挠痒痒啦']
  var WORK=['分身出动！','搬砖进行中…','交给我，你去喝口水']
  var READ=['上网细读中，放大镜伺候','让我仔细康康…','逐字逐句读着呢']
  var DONE=['搞定！','任务完成，求表扬','收工，下一单']
  var LONG=['还在努力完成任务中…','这活有点大，我在啃','进展中，快了快了','仍在全力处理，放心去忙别的']
  function pick(a){ return a[Math.floor(Math.random()*a.length)] }
  var sayT=0
  function say(t){ bubble.textContent=t; bubble.classList.add('show')
    clearTimeout(sayT); sayT=setTimeout(function(){ bubble.classList.remove('show') },4200) }
  function boing(){ hit.classList.remove('boing'); void hit.offsetWidth; hit.classList.add('boing') }
  function wave(){ body.classList.remove('waving'); void body.offsetWidth; body.classList.add('waving')
    setTimeout(function(){ body.classList.remove('waving') },1400) }
  function cast(){ body.classList.remove('cast'); void body.offsetWidth; body.classList.add('cast')
    setTimeout(function(){ body.classList.remove('cast') },650) }
  ;(function blink(){ setTimeout(function(){ m.classList.add('blink')
    setTimeout(function(){ m.classList.remove('blink') },180); blink() }, 2400+Math.random()*3200) })()
  // 偶发闲聊：仅空闲时说话，说话时一半概率顺手招个手
  ;(function chatter(){ setTimeout(function(){
    if(!/working|reading|done/.test(body.className)){ say(pick(IDLE)); if(Math.random()<0.5) wave() }
    chatter() }, 50000+Math.random()*90000) })()
  setTimeout(function(){ say('嗨，我是小影'); wave() }, 700)
  // 状态机：working（分身环+汗）/ reading（放大镜）/ done（站起来跳 2.6s 后回位）/ idle
  // 任务跑久了周期性冒一句「还在努力」（首次 ~45s，之后 45~70s 一句），收尾即停
  var doneT=0, longT=0
  function startLong(){ if(longT) return
    longT=setInterval(function(){ if(/working|reading/.test(body.className)) say(pick(LONG)) }, 45000+Math.random()*25000) }
  function stopLong(){ if(longT){ clearInterval(longT); longT=0 } }
  function setState(s){
    if(s==='done'){ stopLong(); body.classList.remove('working','reading'); body.classList.add('done')
      say(pick(DONE)); clearTimeout(doneT); doneT=setTimeout(function(){ body.classList.remove('done') },2600) }
    else if(s==='working'){ body.classList.remove('done','reading'); startLong()
      if(!body.classList.contains('working')){ body.classList.add('working'); say(pick(WORK)) } }
    else if(s==='reading'){ body.classList.remove('done','working'); startLong()
      if(!body.classList.contains('reading')){ body.classList.add('reading'); say(pick(READ)) } }
    else { stopLong(); body.classList.remove('working','reading','done') }
  }
  if(api&&api.on) api.on('floatball:state', function(p){ setState(p&&p.state) })
  // 鼠标穿透：默认整窗穿透（气泡区不挡桌面），指到小影身上才接管
  function ignore(on){ if(api) api.invoke('floatball:ignore-mouse', on) }
  hit.addEventListener('mouseenter', function(){ ignore(false); if(!drag) boing() })
  hit.addEventListener('mouseleave', function(){ if(!drag) ignore(true) })
  // 拖拽：指针捕获 + IPC 移窗；位移 <5px 视为点击 = 召唤主窗口
  var drag=false,moved=false,px=0,py=0,wx=null,wy=0,nx=0,ny=0,raf=0
  hit.addEventListener('pointerdown',function(e){ if(!api)return
    hit.setPointerCapture(e.pointerId); drag=true; moved=false; wx=null; px=e.screenX; py=e.screenY
    api.invoke('floatball:drag-start').then(function(p){ wx=p[0]; wy=p[1] })
    hit.classList.add('grab') })
  hit.addEventListener('pointermove',function(e){ if(!drag||wx===null)return
    var dx=e.screenX-px, dy=e.screenY-py
    if(Math.abs(dx)+Math.abs(dy)>4) moved=true
    nx=wx+dx; ny=wy+dy
    if(!raf) raf=requestAnimationFrame(function(){ raf=0; api.invoke('floatball:move',{x:nx,y:ny}) }) })
  // 单击 = 动作反馈（boing + 招手/搭话）；双击 = 召唤动作（双臂上举+分身环飞出）再唤起主窗口
  var lastUp=0, clickT=0
  hit.addEventListener('pointerup',function(){ if(!drag)return
    drag=false; hit.classList.remove('grab'); boing()
    if(moved) return
    var now=Date.now()
    if(now-lastUp<320){
      lastUp=0; clearTimeout(clickT)
      cast(); say('召唤～变！')
      setTimeout(function(){ api.invoke('window:show-main') },240)
    } else {
      lastUp=now
      clickT=setTimeout(function(){ if(Math.random()<0.4) wave(); else say(pick(CLICK)) },330)
    }})
})()
</script>
</body></html>`)

export function isFloatBallOn(): boolean {
  return configGet('float-ball') === '1'
}

export function showFloatBall(): void {
  if (ball && !ball.isDestroyed()) { ball.show(); return }
  try {
    const { workArea } = screen.getPrimaryDisplay()
    ball = new BrowserWindow({
      width: WIN_W, height: WIN_H,
      x: workArea.x + workArea.width - WIN_W - 12, y: workArea.y + Math.round(workArea.height * 0.6),
      frame: false, transparent: true, resizable: false, alwaysOnTop: true,
      skipTaskbar: true, hasShadow: false, focusable: true, acceptFirstMouse: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
    })
    ball.setAlwaysOnTop(true, 'floating')
    // 默认穿透 + forward：气泡/空白区不挡桌面点击，悬到小影身上时页面会请求接管
    ball.setIgnoreMouseEvents(true, { forward: true })
    ball.loadURL(BALL_HTML).catch(e => swallow(e, 'floatball-load'))
    // 创建时如已有任务在跑，立刻同步状态（否则球醒来还是一脸闲）
    ball.webContents.once('did-finish-load', () => {
      if (activeRuns.size > 0) sendBall({ state: lastHint || 'working' })
    })
    ball.on('closed', () => { ball = null })
  } catch (e) { swallow(e, 'floatball') }
}

export function hideFloatBall(): void {
  try { if (ball && !ball.isDestroyed()) { ball.close(); ball = null } } catch (e) { swallow(e, 'hide-float-ball') }
}

/** 开关落地：持久化 + 立即生效。 */
export function setFloatBall(on: boolean): boolean {
  configSet('float-ball', on ? '1' : '0')
  if (on) showFloatBall(); else hideFloatBall()
  return on
}

/** 应用启动时按持久化配置召唤小影。 */
export function initFloatBall(): void {
  if (isFloatBallOn()) showFloatBall()
}

/** 双击小影召唤主窗口：不可见时淡入登场（与小影的召唤动作衔接），已可见只聚焦。 */
export function showMainFromBall(): void {
  const w = getMainWindow()
  if (!w || w.isDestroyed()) return
  const wasVisible = w.isVisible() && !w.isMinimized()
  if (w.isMinimized()) w.restore()
  if (wasVisible) { w.show(); w.focus(); return }
  try {
    w.setOpacity(0)
    w.show(); w.focus()
    let t = 0
    const timer = setInterval(() => {
      t++
      try { w.setOpacity(Math.min(1, t / 8)) } catch (err) { clearInterval(timer); swallow(err, 'summon-fade') }
      if (t >= 8) clearInterval(timer)
    }, 16)
  } catch (e) { swallow(e, 'summon-show'); w.show(); w.focus() }
}

/** 拖拽起点：返回小影窗口当前位置（渲染侧以此为基准做相对位移）。 */
export function ballDragStart(): number[] {
  if (!ball || ball.isDestroyed()) return [0, 0]
  return ball.getPosition()
}

/** 拖拽移动：夹取在最近显示器工作区内，避免被拖出屏幕找不回来。 */
export function ballMoveTo(x: number, y: number): boolean {
  if (!ball || ball.isDestroyed()) return false
  const rx = Math.round(x); const ry = Math.round(y)
  const { workArea } = screen.getDisplayNearestPoint({ x: rx, y: ry })
  const cx = Math.min(Math.max(rx, workArea.x - 20), workArea.x + workArea.width - WIN_W + 20)
  const cy = Math.min(Math.max(ry, workArea.y), workArea.y + workArea.height - WIN_H + 24)
  ball.setPosition(cx, cy)
  return true
}

/** 鼠标穿透开关（页面按指针是否悬在小影身上请求）。 */
export function ballSetIgnoreMouse(on: boolean): boolean {
  if (!ball || ball.isDestroyed()) return false
  ball.setIgnoreMouseEvents(!!on, { forward: true })
  return true
}

// ── agent 状态联动（agent-core / agent-control 调用）──
// 按 runId 记台账而非裸计数：终止路径与正常收尾会双双到场，Set.delete 幂等保证只结算一次，
// 也避免被中止的 run 迟迟不落地时小影永远「在干活」。
const activeRuns = new Set<string>()
let readingUntil = 0
let lastHint = ''

function sendBall(payload: { state: string }): void {
  if (ball && !ball.isDestroyed()) ball.webContents.send('floatball:state', payload)
}

/** 任务开跑：分身环出动。 */
export function ballTaskStarted(runId: string): void {
  activeRuns.add(runId)
  lastHint = 'working'
  sendBall({ state: 'working' })
}

/** 任务收尾：全部结束才庆祝/回位（失败不跳，安静回 idle）；已结算过的 runId 忽略。 */
export function ballTaskFinished(runId: string, ok: boolean): void {
  if (!activeRuns.delete(runId)) return
  if (activeRuns.size === 0) {
    lastHint = ''
    readingUntil = 0
    sendBall({ state: ok ? 'done' : 'idle' })
  }
}

/** 用户点「停止」：立即回位（不庆祝）；不带 runId 的全量中止直接清空台账。 */
export function ballTaskAborted(runId?: string): void {
  if (runId) { ballTaskFinished(runId, false); return }
  activeRuns.clear()
  lastHint = ''
  readingUntil = 0
  sendBall({ state: 'idle' })
}

// 检索/浏览类日志 → 举放大镜细读；20s 无新命中回落 working
const READ_RE = /检索|搜索|浏览|网页|细读|深读|调研|打开.{0,8}(页|链接|网址)|research|browse|search|crawl|fetch/i

/** 日志驱动的细分状态（轻量正则，勿在此做重逻辑）。 */
export function ballLogHint(text: string): void {
  if (activeRuns.size === 0 || !text) return
  const now = Date.now()
  if (READ_RE.test(text)) readingUntil = now + 20_000
  const kind = now < readingUntil ? 'reading' : 'working'
  if (kind !== lastHint) { lastHint = kind; sendBall({ state: kind }) }
}
