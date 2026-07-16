// 员工版技能智能创建向导：指令 → （必要时）追问选项卡 → 草稿预览 → 校验 → 保存为私有技能。
// 引擎在后端（skill-creator 方法论），保存成功即本地落盘、当场可对话触发。
import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'

interface Question { id: string; question: string; options: string[]; allowCustom: boolean }

const PLACEHOLDER = `例：创建一个文档格式化技能，按我们公司的公文规范排版
· 标题与各级标题：字体、字号、对齐方式
· 正文：字体、字号、缩进与行距
· 版面：页边距、纸型、页眉页脚
规则写得越细越准；缺关键信息时会先向你追问。`

export default function SkillCreatorModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [instruction, setInstruction] = useState('')
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<any>(null)
  const [report, setReport] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedName, setSavedName] = useState('')

  const generate = async () => {
    if (!instruction.trim()) { setError('请先描述要创建的技能'); return }
    setBusy(true); setError('')
    const r = await window.api.invoke('skillauth:draft', { instruction, answers: questions ? answers : undefined })
    setBusy(false)
    if (!r?.success) { setError(r?.error || '生成失败'); return }
    if (r.questions?.length) { setQuestions(r.questions); setDraft(null) }
    else if (r.draft) { setDraft(r.draft); setReport(null) }
    else setError('模型返回内容异常，请重试')
  }

  const validate = async () => {
    setBusy(true); setError('')
    const r = await window.api.invoke('skillauth:validate', draft)
    setBusy(false)
    if (!r?.success) { setError(r?.error || '校验失败'); return }
    setReport(r)
  }

  const save = async () => {
    setBusy(true); setError('')
    const r = await window.api.invoke('skillauth:save', draft)
    setBusy(false)
    if (!r?.success) { setError(r?.error || '保存失败'); return }
    setSavedName(r.skill?.name || draft.name)
    onSaved()
  }

  return (
    <div className="rec-overlay" onClick={() => !busy && onClose()}>
      <div className="rec-modal" onClick={e => e.stopPropagation()}>
        <div className="rec-head">
          <div style={{ fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={15} />创建我的技能
          </div>
          <button className="aut-ico" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="rec-body">

        {savedName ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>✅ 「{savedName}」已创建并生效</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>这是你的私有技能，直接在对话里说出需求即可触发；换电脑登录也会自动带过来。</div>
            <button className="btn-primary" style={{ marginTop: 14 }} onClick={onClose}>完成</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <textarea className="form-textarea" rows={5} value={instruction} disabled={busy || !!draft}
              onChange={e => setInstruction(e.target.value)} placeholder={PLACEHOLDER} style={{ resize: 'vertical', fontSize: 12 }} />

            {questions && !draft && questions.map(q => (
              <div key={q.id}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{q.question}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {q.options.map(op => (
                    <button key={op} className={answers[q.id] === op ? 'btn-primary' : 'btn-secondary'}
                      style={{ padding: '4px 12px', fontSize: 12 }}
                      onClick={() => setAnswers({ ...answers, [q.id]: op })}>{op}</button>
                  ))}
                  {q.allowCustom && (
                    <input className="form-input" style={{ width: 150, padding: '4px 10px', fontSize: 12 }} placeholder="自定义…"
                      value={q.options.includes(answers[q.id]) ? '' : (answers[q.id] || '')}
                      onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  )}
                </div>
              </div>
            ))}

            {draft && (
              <div style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <b style={{ fontSize: 13 }}>{draft.name}</b>
                  <span className="svc-kw">{draft.type === 'python-sandbox' ? 'Python 数据处理' : '知识/指南型'}</span>
                  {(draft.scripts || []).length > 0 && <span className="svc-kw">{draft.scripts.length} 个脚本</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{draft.description}</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {(draft.triggerKeywords || []).map((k: string) => <span key={k} className="svc-kw">{k}</span>)}
                </div>
                <pre style={{ fontSize: 11, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--bg-subtle)', padding: 8, borderRadius: 6 }}>{draft.sopContent}</pre>
                {draft.riskNotes && <div style={{ fontSize: 11, color: 'var(--accent-yellow, #b8860b)' }}>⚠ {draft.riskNotes}</div>}
                {report && (
                  <div style={{ fontSize: 12 }}>
                    <b>校验 · {report.pass ? '✅ 通过' : '❌ 未通过'}</b>
                    {(report.items || []).map((it: any) => (
                      <div key={it.item} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                        <span style={{ width: 72, color: 'var(--text-muted)' }}>{it.item}</span>
                        <span>{it.ok ? '✅' : '❌'}</span>
                        <span style={{ flex: 1, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && <div style={{ fontSize: 12, color: '#d64545' }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {!draft && (
                <button className="btn-primary" onClick={generate} disabled={busy}>
                  {busy ? '生成中…（含脚本约 30-60s）' : questions ? '按所选继续生成' : '生成草稿'}
                </button>
              )}
              {draft && (
                <>
                  <button className="btn-secondary" onClick={() => { setDraft(null); setQuestions(null); setAnswers({}); setReport(null) }} disabled={busy}>重新来</button>
                  <button className="btn-secondary" onClick={validate} disabled={busy}>{busy ? '处理中…' : '校验'}</button>
                  <button className="btn-primary" onClick={save} disabled={busy}>保存并启用</button>
                </>
              )}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
