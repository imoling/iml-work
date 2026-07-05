import { useState } from 'react'
import { Boxes, Cpu, Circle } from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import SkillRecorder from './SkillRecorder'
import { SKILL_TYPE_META } from './skillTypeMeta'

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
            <div className="wb-hero-title" style={{ fontSize: 22 }}>技能</div>
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
          {skills.map(sk => {
            const meta = SKILL_TYPE_META[sk.type] || { label: '自定义技能', icon: <Boxes size={18} /> }
            const kws = (sk.triggerKeywords || []).filter(Boolean)
            return (
            <div key={sk.id} className="svc-card">
              <div className="svc-head">
                <div className="svc-ic">{meta.icon}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="svc-name">{sk.name}</div>
                  <div className="svc-type">{meta.label}{sk.category ? ` · ${sk.category}` : ''}</div>
                </div>
              </div>
              <div className="svc-meta" title={sk.description || ''}>
                {sk.description ? sk.description.replace(/\s+/g, ' ').slice(0, 90) + (sk.description.length > 90 ? '…' : '') : '暂无描述'}
              </div>
              {kws.length > 0 && (
                <div className="svc-kws">
                  {kws.slice(0, 4).map((k, i) => <span key={i} className="svc-kw">{k}</span>)}
                  {kws.length > 4 && <span className="svc-kw more">+{kws.length - 4}</span>}
                </div>
              )}
              <div className="svc-actions">
                <span className="pill pill-mint"><span className="pill-dot" />可调用</span>
              </div>
            </div>
          )})}
          {skills.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 36, color: 'var(--text-muted)' }}>
              <Cpu size={26} style={{ marginBottom: 8, opacity: 0.5 }} />
              <div>当前分身暂未装载技能</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
