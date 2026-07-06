import { useEffect, useState } from 'react'
import { useUserStore } from '../../stores/userStore'

// 工作空间页：工作目录（以主进程 workspace:* 为唯一真值，与「文件」页同源）、
// 启动项与界面偏好开关。样式沿用 SettingsPanel 的全局 <style>。

export default function FolderTab() {
  const { historyRailPinned, setHistoryRailPinned, startupRestoreLast, setStartupRestoreLast } = useUserStore()

  const [workDir, setWorkDir] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [showFloatBall, setShowFloatBall] = useState(false)
  useEffect(() => {
    window.api.invoke('workspace:files').then((r: any) => { if (r?.dir) setWorkDir(r.dir) }).catch(() => {})
  }, [])
  const pickWorkDir = async () => {
    const r: any = await window.api.invoke('workspace:pick-dir')
    if (r && !r.canceled && r.dir) setWorkDir(r.dir)
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

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">开机自动启动</div>
            <div className="setting-desc">登录操作系统后，自动后台静默打开 iML Work 工作分身</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">显示悬浮球</div>
            <div className="setting-desc">在桌面边缘显示快捷截图、快速提问和日志查看悬浮球</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={showFloatBall} onChange={(e) => setShowFloatBall(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">历史会话常驻</div>
            <div className="setting-desc">开启后，会话页左侧的历史会话列表始终展示；关闭时（默认）界面更清爽，点左上角按钮可随时展开。</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={historyRailPinned} onChange={(e) => setHistoryRailPinned(e.target.checked)} />
              <span className="slider" />
            </label>
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
      </div>
    </div>
  )
}
