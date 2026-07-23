import { useEffect, useState } from 'react'
import { Boxes, Cpu, Circle, Sparkles, Upload } from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import SkillRecorder from './SkillRecorder'
import SkillCreatorModal from './SkillCreatorModal'
import { SKILL_TYPE_META } from './skillTypeMeta'

interface MineSkill { id: string; name: string; description: string; status: string; type: string; triggerKeywords: string[]; reviewNote?: string }

export default function SkillsView() {
  const { claimedExpertId, expertList, getCurrentExpertName } = useUserStore()
  const expert = expertList.find(e => e.id === claimedExpertId)
  const skills = expert?.skills || []
  const [recording, setRecording] = useState(false)
  const [creating, setCreating] = useState(false)
  const [perms, setPerms] = useState<{ canCreate: boolean; canUpload: boolean }>({ canCreate: false, canUpload: false })
  const [mine, setMine] = useState<MineSkill[]>([])
  const [uploadMsg, setUploadMsg] = useState('')

  const loadMine = () => { window.api.invoke('skillauth:mine').then((r: any) => { if (r?.success) setMine(r.skills) }).catch(() => {}) }
  useEffect(() => {
    window.api.invoke('skillauth:perms').then((p: any) => p && setPerms(p)).catch(() => {})
    loadMine()
  }, [])

  const uploadPackage = async () => {
    setUploadMsg('')
    const r = await window.api.invoke('skillauth:upload')
    if (r?.cancelled) return
    if (!r?.success) { setUploadMsg(`❌ ${r?.error || '上传失败'}`); return }
    setUploadMsg(`✅ ${r.message || '已提交待审核'}`)
    loadMine()
  }

  const MINE_STATUS: Record<string, { label: string; cls: string }> = {
    PUBLISHED: { label: '已生效', cls: 'pill-mint' },
    PENDING_REVIEW: { label: '待管理员审核', cls: '' },
    REJECTED: { label: '已退回', cls: '' },
    DISABLED: { label: '已下架', cls: '' }
  }

  return (
    <div className="wb">
      <div className="wb-inner">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="wb-hero-title" style={{ fontSize: 22 }}>技能</div>
            <div className="wb-hero-sub">「{getCurrentExpertName()}」领用的自动化技能，运行在本地安全环境中。</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {perms.canCreate && (
              <button className="btn-secondary" onClick={() => setCreating(true)}>
                <Sparkles size={13} /><span>创建技能</span>
              </button>
            )}
            {perms.canUpload && (
              <button className="btn-secondary" onClick={uploadPackage}>
                <Upload size={13} /><span>上传技能包</span>
              </button>
            )}
            <button className="btn-primary" onClick={() => setRecording(true)}>
              <Circle size={13} /><span>实操录制技能</span>
            </button>
          </div>
        </div>
        {uploadMsg && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>{uploadMsg}</div>}

        {recording && (
          <SkillRecorder
            onClose={() => setRecording(false)}
            onSaved={() => { setRecording(false); loadMine() }}
          />
        )}
        {creating && (
          <SkillCreatorModal onClose={() => setCreating(false)} onSaved={loadMine} />
        )}

        {mine.length > 0 && (
          <>
            <div className="wb-section-title">我的技能（{mine.length}）</div>
            <div className="svc-grid">
              {mine.map(sk => {
                const st = MINE_STATUS[sk.status] || { label: sk.status, cls: '' }
                return (
                  <div key={sk.id} className="svc-card">
                    <div className="svc-head">
                      <div className="svc-ic"><Sparkles size={18} /></div>
                      <div style={{ minWidth: 0 }}>
                        <div className="svc-name">{sk.name}</div>
                        <div className="svc-type">{sk.type === 'python-sandbox' ? 'Python 数据处理' : '知识/指南型'} · 私有</div>
                      </div>
                    </div>
                    <div className="svc-meta" title={sk.description}>
                      {sk.description ? sk.description.replace(/\s+/g, ' ').slice(0, 90) : '暂无描述'}
                    </div>
                    <div className="svc-actions">
                      <span className={`pill ${st.cls}`}><span className="pill-dot" />{st.label}</span>
                    </div>
                    {sk.status === 'REJECTED' && sk.reviewNote && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }} title={sk.reviewNote}>
                        {sk.reviewNote.replace(/^.*退回原因[:：]/, '退回原因：').slice(0, 60)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
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
