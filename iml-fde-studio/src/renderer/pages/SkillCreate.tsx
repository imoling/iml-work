// 指令创建技能：一句话 → （必要时）追问选项卡 → 草稿 → 校验 → 保存到企业技能中心。
// 引擎在后端（/api/v1/skills/creator/*，方法论=Anthropic skill-creator），与管理端/客户端共用。
import { useState } from 'react'
import { PageHeader, Field, Tag } from '../components/ui'
import { Creator, SkillCenter } from '../services/api'

interface Question { id: string; question: string; options: string[]; allowCustom: boolean }

const EXAMPLE = `例：创建一个文档格式化技能，按客户的公文规范排版
· 标题与各级标题：字体、字号、对齐方式
· 正文：字体、字号、缩进与行距
· 版面：页边距、纸型、页眉页脚
规则写得越细越准；缺关键信息时会先追问。`

export default function SkillCreate() {
  const [instruction, setInstruction] = useState('')
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<any>(null)
  const [report, setReport] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedId, setSavedId] = useState('')

  const reset = () => { setQuestions(null); setAnswers({}); setDraft(null); setReport(null); setError(''); setSavedId('') }

  const generate = async () => {
    if (!instruction.trim()) { setError('请先描述要创建的技能'); return }
    setBusy(true); setError('')
    try {
      const d = await Creator.draft(instruction, questions ? answers : undefined)
      if (d.questions && d.questions.length) { setQuestions(d.questions); setDraft(null) }
      else if (d.draft) { setDraft(d.draft); setReport(null) }
      else throw new Error('模型返回内容异常，请重试')
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  const validate = async () => {
    if (!draft) return
    setBusy(true); setError('')
    try { setReport(await Creator.validate(draft)) }
    catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  /** 保存到技能中心（脚本目录 → bundle，与导入包同构）。publish=true 直接上架。 */
  const save = async (publish: boolean) => {
    if (!draft) return
    setBusy(true); setError('')
    try {
      let bundle = ''
      const scripts: { path: string; content: string }[] = Array.isArray(draft.scripts) ? draft.scripts : []
      if (scripts.length) {
        const files: Record<string, string> = {}
        scripts.forEach(s => { if (s?.path && s?.content) files[s.path] = s.content })
        files['SKILL.md'] = `---\nname: ${draft.name || ''}\ndescription: ${draft.description || ''}\n---\n\n${draft.sopContent || ''}`
        bundle = JSON.stringify(files)
      }
      const saved = await SkillCenter.create({
        name: draft.name, description: draft.description,
        type: draft.type === 'python-sandbox' ? 'python-sandbox' : 'knowledge',
        category: draft.category || '办公自动化', status: publish ? 'PUBLISHED' : 'DRAFT',
        triggerKeywords: draft.triggerKeywords || [], sopContent: draft.sopContent || '', bundle
      })
      setSavedId(saved?.id || '(已保存)')
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader title="指令创建技能" desc="一句话描述需求，AI 按 skill-creator 方法论生成技能（必要时先追问关键细节）" />

      <div className="card grid" style={{ gap: 12 }}>
        <Field label="技能指令（格式规范、操作规则写得越细越好）">
          <textarea rows={6} value={instruction} disabled={busy || !!draft}
            onChange={e => setInstruction(e.target.value)} placeholder={EXAMPLE} style={{ resize: 'vertical' }} />
        </Field>

        {questions && !draft && questions.map(q => (
          <Field key={q.id} label={q.question}>
            <div className="fl" style={{ flexWrap: 'wrap', gap: 6 }}>
              {q.options.map(op => (
                <button key={op} className={answers[q.id] === op ? 'primary' : 'ghost'} onClick={() => setAnswers({ ...answers, [q.id]: op })}>{op}</button>
              ))}
              {q.allowCustom && (
                <input style={{ width: 180 }} placeholder="自定义…"
                  value={q.options.includes(answers[q.id]) ? '' : (answers[q.id] || '')}
                  onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />
              )}
            </div>
          </Field>
        ))}

        {draft && (
          <div className="sec" style={{ display: 'grid', gap: 8 }}>
            <div className="fl" style={{ gap: 8, alignItems: 'center' }}>
              <b>{draft.name}</b>
              <Tag kind="blue">{draft.type === 'python-sandbox' ? 'Python 数据处理' : '知识/指南型'}</Tag>
              {(draft.scripts || []).length > 0 && <Tag kind="gray">{draft.scripts.length} 个脚本</Tag>}
            </div>
            <div className="hint">{draft.description}</div>
            <div className="fl" style={{ flexWrap: 'wrap', gap: 5 }}>
              {(draft.triggerKeywords || []).map((k: string) => <Tag key={k} kind="gray">{k}</Tag>)}
            </div>
            <pre style={{ fontSize: 12, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{draft.sopContent}</pre>
            {(draft.scripts || []).map((s: any) => (
              <details key={s.path}>
                <summary style={{ fontSize: 12, cursor: 'pointer' }}>{s.path}</summary>
                <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>{s.content}</pre>
              </details>
            ))}
            {draft.riskNotes && <div className="hint">⚠ {draft.riskNotes}</div>}
          </div>
        )}

        {report && (
          <div className="sec">
            <b style={{ fontSize: 13 }}>校验报告 · {report.pass ? '✅ 通过' : '❌ 未通过'}</b>
            {(report.items || []).map((it: any) => (
              <div key={it.item} className="fl" style={{ gap: 8, fontSize: 12, padding: '3px 0' }}>
                <span style={{ width: 80, opacity: 0.7 }}>{it.item}</span>
                <span>{it.ok ? '✅' : '❌'}</span>
                <span style={{ flex: 1, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.detail}</span>
              </div>
            ))}
          </div>
        )}

        {error && <div className="hint" style={{ color: '#d64545' }}>{error}</div>}
        {savedId && <div className="hint">✅ 已保存到企业技能中心（{savedId}）。绑定到岗位后员工即可使用；可到「④ 技能测试」验证。</div>}

        <div className="fl" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {!draft && <button className="primary" onClick={generate} disabled={busy}>{busy ? '生成中…（含脚本约 30-60s）' : questions ? '按所选继续生成' : '生成草稿'}</button>}
          {draft && !savedId && (
            <>
              <button className="ghost" onClick={reset} disabled={busy}>重新来</button>
              <button className="ghost" onClick={validate} disabled={busy}>{busy ? '处理中…' : '校验'}</button>
              <button className="ghost" onClick={() => save(false)} disabled={busy}>保存为草稿</button>
              <button className="primary" onClick={() => save(true)} disabled={busy}>保存并上架</button>
            </>
          )}
          {savedId && <button className="ghost" onClick={() => { reset(); setInstruction('') }}>再建一个</button>}
        </div>
      </div>
    </div>
  )
}
