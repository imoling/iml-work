import { useEffect, useState } from 'react'
import { useUserStore } from '../../stores/userStore'

// 工作空间页：工作目录（以主进程 workspace:* 为唯一真值，与「文件」页同源）、
// 启动项与界面偏好开关。样式沿用 SettingsPanel 的全局 <style>。

export default function FolderTab() {
  const { startupRestoreLast, setStartupRestoreLast, showExecLivefeed, setShowExecLivefeed, recentConvCount, setRecentConvCount } = useUserStore()

  const [workDir, setWorkDir] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [showFloatBall, setShowFloatBall] = useState(false)
  const [turnEngine, setTurnEngine] = useState(false)
  const [wsAccess, setWsAccess] = useState(true)
  useEffect(() => {
    window.api.invoke('workspace:files').then((r: any) => { if (r?.dir) setWorkDir(r.dir) }).catch(() => {})
    // 真实系统状态：开机自启读系统登录项，悬浮球读持久化配置
    window.api.invoke('app:autostart-get').then((v: any) => setAutoStart(!!v)).catch(() => {})
    window.api.invoke('app:floatball-get').then((v: any) => setShowFloatBall(!!v)).catch(() => {})
    window.api.invoke('turn:enabled').then((v: any) => setTurnEngine(!!v)).catch(() => {})
    window.api.invoke('turn:workspace-access').then((v: any) => setWsAccess(!!v)).catch(() => {})
  }, [])
  const toggleWsAccess = async (on: boolean) => {
    setWsAccess(on)
    await window.api.invoke('turn:set-workspace-access', on).catch(() => setWsAccess(!on))
  }
  const toggleTurnEngine = async (on: boolean) => {
    setTurnEngine(on)
    await window.api.invoke('turn:set-enabled', on).catch(() => setTurnEngine(!on))
  }
  const pickWorkDir = async () => {
    const r: any = await window.api.invoke('workspace:pick-dir')
    if (r && !r.canceled && r.dir) setWorkDir(r.dir)
  }
  const toggleAutoStart = async (on: boolean) => {
    setAutoStart(on)
    const applied = await window.api.invoke('app:autostart-set', on).catch(() => !on)
    setAutoStart(!!applied)
  }
  const toggleFloatBall = async (on: boolean) => {
    setShowFloatBall(on)
    const applied = await window.api.invoke('app:floatball-set', on).catch(() => !on)
    setShowFloatBall(!!applied)
  }

  return (
    <div className="settings-tab-content">
      <h2 className="tab-title">工作空间</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div className="setting-row">
          <div className="setting-info" style={{ flex: 1 }}>
            <div className="setting-label">工作目录</div>
            <div className="setting-desc">
              分身读取和生成文件的本地目录，放入的文档会自动收录进个人知识库（与「文件」页一致）。
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', padding: '8px 12px', borderRadius: '6px', color: 'var(--text-secondary)', fontFamily: 'monospace', marginTop: '10px' }}>
              📂 {workDir || '默认 documents 目录'}
            </div>
          </div>
          <button type="button" className="robot-btn" onClick={pickWorkDir} style={{ height: 'fit-content' }}>
            修改目录
          </button>
        </div>

        {/* 新执行内核开关：与旧管线并存，逐阶段验证后再切默认（见 docs/执行链路重构方案）。 */}
        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">新执行内核（实验）</div>
            <div className="setting-desc">
              开启后，任务改由「一个循环 + 一张工具表」执行：分身会自己列出执行计划、边做边报进度，
              对话框里能看到每一步调用了什么工具。多轮追问也更准（完整保留工具调用轨迹）。
              关闭则走原有执行链路。上游模型不支持工具调用时会自动降级。
            </div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={turnEngine} onChange={(e) => toggleTurnEngine(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">允许分身读取工作空间</div>
            <div className="setting-desc">
              关闭后，分身完全看不到工作空间里的文件（连文件名都不知道）。
              开启时也只在任务确实与文件有关（带了附件、点名了某个文件、或明确在问文档资料）才会去读——
              不会拿工作空间里的材料来回答无关问题。
            </div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={wsAccess} onChange={(e) => toggleWsAccess(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">开机自动启动</div>
            <div className="setting-desc">登录操作系统后，自动后台静默打开 iML Work 工作分身</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={autoStart} onChange={(e) => toggleAutoStart(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">显示悬浮球</div>
            <div className="setting-desc">在桌面显示置顶悬浮球（可拖拽），点击快速唤起 iML Work</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={showFloatBall} onChange={(e) => toggleFloatBall(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">侧栏最近会话显示数量</div>
            <div className="setting-desc">左侧导航栏「最近会话」区展示的条数（3-15）。完整历史仍在会话页左侧列表。</div>
          </div>
          <div className="setting-control">
            <select className="form-input" style={{ width: 90 }} value={recentConvCount}
              onChange={(e) => setRecentConvCount(parseInt(e.target.value, 10))}>
              {[3, 5, 8, 10, 15].map(n => <option key={n} value={n}>{n} 条</option>)}
            </select>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">进入时恢复上次对话</div>
            <div className="setting-desc">开启（默认）后，每次进入自动打开最近一次对话，接着上次继续；关闭则每次进入都是新对话。</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={startupRestoreLast} onChange={(e) => setStartupRestoreLast(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">执行进度前台显示</div>
            <div className="setting-desc">开启（默认）后，分身执行任务时在对话气泡区常驻滚动最近几步进度，长任务不再白屏；关闭则只在展开「执行详情」时查看，界面更安静。</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={showExecLivefeed} onChange={(e) => setShowExecLivefeed(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
