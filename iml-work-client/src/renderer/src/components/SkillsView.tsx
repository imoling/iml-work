import { useState } from 'react'
import { Boxes, Camera, CloudSun, FolderSearch, Cpu, Circle } from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import SkillRecorder from './SkillRecorder'

const ICONS: Record<string, React.ReactNode> = {
  'web-screenshot': <Camera size={18} />,
  'weather-check': <CloudSun size={18} />,
  'workspace-analyzer': <FolderSearch size={18} />,
}

const DESCS: Record<string, string> = {
  'web-screenshot': '网页离屏截图与保存，捕获页面视图。',
  'weather-check': '查询实时天气并校验出差差旅标准。',
  'workspace-analyzer': '扫描本地工作空间文件并生成同步报告。',
}

export default function SkillsView() {
  const { claimedExpertId, expertList, getCurrentExpertName, fetchExperts } = useUserStore()
  const expert = expertList.find(e => e.id === claimedExpertId)
  const skills = expert?.skills || []
  const [recording, setRecording] = useState(false)

  return (
    <div className="wb">
      <div className="wb-inner">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="wb-hero-title" style={{ fontSize: 22 }}>业务技能</div>
            <div className="wb-hero-sub">「{getCurrentExpertName()}」领用的自动化技能，运行在本地安全环境中。</div>
          </div>
          <button className="btn-primary" style={{ flexShrink: 0 }} onClick={() => setRecording(true)}>
            <Circle size={13} /><span>实操录制技能</span>
          </button>
        </div>

        {recording && (
          <SkillRecorder
            onClose={() => setRecording(false)}
            onSaved={() => { setRecording(false); fetchExperts() }}
          />
        )}

        <div className="wb-section-title">已装载技能（{skills.length}）</div>
        <div className="svc-grid">
          {skills.map(sk => (
            <div key={sk.id} className="svc-card">
              <div className="svc-head">
                <div className="svc-ic">{ICONS[sk.id] || <Boxes size={18} />}</div>
                <div>
                  <div className="svc-name">{sk.name}</div>
                  <div className="svc-type">{sk.type}</div>
                </div>
              </div>
              <div className="svc-meta">{DESCS[sk.id] || '本地自定义业务技能流程。'}</div>
              <div className="svc-actions">
                <span className="pill pill-mint"><span className="pill-dot" />可调用</span>
              </div>
            </div>
          ))}
          {skills.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 36, color: 'var(--text-muted)' }}>
              <Cpu size={26} style={{ marginBottom: 8, opacity: 0.5 }} />
              <div>当前分身暂未装载业务技能</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
