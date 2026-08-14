import { useEffect, useState } from 'react'
import { Boxes, Cpu, Circle, Sparkles, Upload, Pencil, Trash2 } from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import SkillRecorder, { type EditSkill } from './SkillRecorder'
import SkillCreatorModal from './SkillCreatorModal'
import { SKILL_TYPE_META } from './skillTypeMeta'
import { swallow } from '../utils'
import { isWebMode, bufToBase64 } from '../lib/ui-util'

interface MineSkill { id: string; name: string; description: string; status: string; type: string; triggerKeywords: string[]; reviewNote?: string; actionScript?: string; sopContent?: string; skillKind?: string; targetSystemId?: string }

export default function SkillsView() {
  const { claimedExpertId, expertList, getCurrentExpertName } = useUserStore()
  const expert = expertList.find(e => e.id === claimedExpertId)
  const skills = expert?.skills || []
  const [recording, setRecording] = useState(false)
  const [editSkill, setEditSkill] = useState<EditSkill | null>(null)   // 非空=编辑既有录制技能
  const [creating, setCreating] = useState(false)
  const [perms, setPerms] = useState<{ canCreate: boolean; canUpload: boolean }>({ canCreate: false, canUpload: false })
  const [mine, setMine] = useState<MineSkill[]>([])
  const [uploadMsg, setUploadMsg] = useState('')
  const [busyId, setBusyId] = useState('')

  const startEdit = (sk: MineSkill) => setEditSkill({ id: sk.id, name: sk.name, triggerKeywords: sk.triggerKeywords || [], targetSystemId: sk.targetSystemId || '', actionScript: sk.actionScript || '', sopContent: sk.sopContent || '', skillKind: sk.skillKind || '', description: sk.description || '' })
  const removeSkill = async (sk: MineSkill) => {
    if (!window.confirm(`确定删除技能「${sk.name}」？此操作不可撤销。`)) return
    setBusyId(sk.id)
    const r = await window.api.invoke('skill:delete-recorded', { id: sk.id })
    setBusyId('')
    if (!r?.ok) { setUploadMsg(`❌ 删除失败：${r?.error || '未知错误'}`); return }
    loadMine()
  }

  const loadMine = () => { window.api.invoke('skillauth:mine').then((r: any) => { if (r?.success) setMine(r.skills) }).catch(e => swallow(e, 'skillauth-mine')) }
  useEffect(() => {
    window.api.invoke('skillauth:perms').then((p: any) => p && setPerms(p)).catch(e => swallow(e, 'skillauth-perms'))
    loadMine()
    // 技能集变化就重拉：对话里刚装的技能、心跳同步下来的岗位技能，都该立刻出现在这里，
    // 而不是等用户关掉页面再打开（本页原先只在挂载时拉一次）。
    return window.api.on('skills:changed', () => loadMine())
  }, [])

  const applyUploadResult = (r: any) => {
    if (r?.cancelled) { setUploadMsg(''); return }
    if (!r?.success) { setUploadMsg(`❌ ${r?.error || '上传失败'}`); return }
    // 扫描结论随回执展示（与对话安装同一套后端扫描）：让上传者当场知道自己的包被判了什么档
    const risk = Array.isArray(r?.skills) && r.skills[0]?.security ? String(r.skills[0].security) : ''
    setUploadMsg(`✅ ${r.message || '已提交待审核'}${risk ? `（安全扫描：${risk}，管理员审核时可见完整报告）` : ''}`)
    loadMine()
  }

  // Web 形态没有系统文件框（主进程 dialog 缺席）：浏览器原生选文件 → base64 经宿主走同一条提交链路
  const uploadPackageWeb = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,.md'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      if (f.size > 50 * 1024 * 1024) { setUploadMsg('❌ 技能包过大（上限 50MB）'); return }
      setUploadMsg('⏳ 正在上传并扫描…')
      const r = await window.api.invoke('skillauth:upload-buffer', { name: f.name, dataBase64: bufToBase64(await f.arrayBuffer()) })
        .catch((e: any) => ({ success: false, error: e?.message || String(e) }))
      applyUploadResult(r)
    }
    input.click()
  }

  const uploadPackage = async () => {
    setUploadMsg('')
    if (isWebMode()) { uploadPackageWeb(); return }
    applyUploadResult(await window.api.invoke('skillauth:upload'))
  }

  const MINE_STATUS: Record<string, { label: string; cls: string }> = {
    PUBLISHED: { label: '已生效', cls: 'pill-mint' },
    PENDING_REVIEW: { label: '待管理员审核', cls: '' },
    DRAFT: { label: '草稿·待上架', cls: '' },   // 对话里装入企业目录的技能：已记归属，等管理台上架
    REJECTED: { label: '已退回', cls: '' },
    DISABLED: { label: '已下架', cls: '' }
  }

  return (
    <div className="wb">
      <div className="wb-inner">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="wb-hero-title" style={{ fontSize: 22 }}>技能</div>
            <div className="wb-hero-sub">「{getCurrentExpertName()}」领用的自动化技能，运行在安全沙箱中。</div>
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
            {/* 录制依赖桌面端浏览器窗口（决策 D3）：Web 形态隐藏入口 */}
            {!isWebMode() && (
              <button className="btn-primary" onClick={() => setRecording(true)}>
                <Circle size={13} /><span>实操录制技能</span>
              </button>
            )}
          </div>
        </div>
        {uploadMsg && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>{uploadMsg}</div>}

        {recording && (
          <SkillRecorder
            onClose={() => setRecording(false)}
            onSaved={() => { setRecording(false); loadMine() }}
          />
        )}
        {editSkill && (
          <SkillRecorder
            editSkill={editSkill}
            onClose={() => setEditSkill(null)}
            onSaved={() => { setEditSkill(null); loadMine() }}
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
                    <div className="svc-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`pill ${st.cls}`}><span className="pill-dot" />{st.label}</span>
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                        {sk.actionScript && <button className="icon-btn" title="编辑技能" disabled={busyId === sk.id} onClick={() => startEdit(sk)}><Pencil size={13} /></button>}
                        <button className="icon-btn danger" title="删除技能" disabled={busyId === sk.id} onClick={() => removeSkill(sk)}><Trash2 size={13} /></button>
                      </div>
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
