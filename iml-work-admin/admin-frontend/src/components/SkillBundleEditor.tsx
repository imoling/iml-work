import { useMemo, useState } from 'react'

// 技能包目录编辑器（与 FDE 工作台同构）：bundle 是 {相对路径: 文本内容} 的 JSON。
// 左侧按目录分组的文件树（大目录默认折叠），右侧编辑当前文件；新增/删除文件。
// 知识/脚本执行型技能用它替代旧「技能代码」样板箱——那玩意与真实执行链路（bundle+SOP）无关。
//
// SKILL.md 单一来源约定：bundle 里没有独立 SKILL.md 时（智能创建的无脚本知识技能都是这样），
// 手册=「技能信息」里的 SOP 字段——这里展示一个由 名称/描述/SOP 实时渲染的**虚拟只读 SKILL.md**，
// 免得目录空空如也像坏了；有独立文件时以文件为准（导入的 Anthropic 包等）。
const VIRTUAL_MD = 'SKILL.md'

export default function SkillBundleEditor({ bundle, typeLabel, name, description, sop, onChange }: {
  bundle: string
  typeLabel: string
  name?: string
  description?: string
  sop?: string
  onChange: (nextJson: string) => void
}) {
  const files = useMemo<Record<string, string>>(() => {
    try { const o = JSON.parse(bundle || '{}'); return o && typeof o === 'object' ? o : {} } catch { return {} }
  }, [bundle])
  const hasRealMd = files[VIRTUAL_MD] != null
  const virtualMd = useMemo(() =>
    `---\nname: ${name || ''}\ndescription: ${description || ''}\n---\n\n${sop || ''}`,
  [name, description, sop])
  const [active, setActive] = useState<string>(() => (Object.keys(files)[0] || VIRTUAL_MD))
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const isVirtual = active === VIRTUAL_MD && !hasRealMd

  const patch = (next: Record<string, string>) => onChange(Object.keys(next).length ? JSON.stringify(next) : '')

  const addFile = () => {
    const p = prompt('新文件相对路径（如 SKILL.md 或 scripts/run.py）')
    if (!p || !p.trim()) return
    const path = p.trim()
    if (path.includes('..') || path.startsWith('/')) { alert('路径不能越权（../ 或绝对路径）'); return }
    if (files[path] != null) { alert('该文件已存在'); return }
    patch({ ...files, [path]: '' }); setActive(path)
  }
  const delFile = (p: string) => {
    if (!confirm(`删除 ${p}？`)) return
    const next = { ...files }; delete next[p]; patch(next)
    if (active === p) setActive('')
  }

  // 按目录分组；根文件在前；大目录（>6 个文件，如字体/素材）默认折叠
  const groups = useMemo(() => {
    const g: Record<string, string[]> = {}
    for (const p of Object.keys(files)) {
      const i = p.lastIndexOf('/')
      const dir = i >= 0 ? p.slice(0, i) : ''
      ;(g[dir] = g[dir] || []).push(p)
    }
    return g
  }, [files])

  const row = (p: string, base: string, indent: boolean) => (
    <div key={p} onClick={() => setActive(p)}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', paddingLeft: indent ? 22 : 8, cursor: 'pointer', fontSize: 12,
        background: p === active ? 'var(--bg-active)' : 'transparent',
        borderLeft: p === active ? '3px solid var(--brand-primary)' : '3px solid transparent',
        borderBottom: '1px solid var(--border-light)' }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{base}</span>
      <button type="button" className="icon-btn" style={{ width: 18, height: 18, fontSize: 11 }} title="删除文件"
        onClick={e => { e.stopPropagation(); delFile(p) }}>×</button>
    </div>
  )

  return (
    <div className="form-group">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label className="form-label" style={{ margin: 0 }}>脚本目录编辑（{typeLabel} 技能 · SKILL.md + scripts）</label>
        {/* 计数含同源渲染的虚拟 SKILL.md——树里看得见的就要数得上，不然"0 个文件"像坏了 */}
        <span className="badge badge-gray">{Object.keys(files).length + (hasRealMd ? 0 : 1)} 个文件</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-secondary" style={{ padding: '3px 10px', fontSize: 12 }} onClick={addFile}>＋新增文件</button>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <div style={{ width: 220, flexShrink: 0, border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'auto', maxHeight: 360 }}>
          {!hasRealMd && (
            <div onClick={() => setActive(VIRTUAL_MD)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', cursor: 'pointer', fontSize: 12,
                background: active === VIRTUAL_MD ? 'var(--bg-active)' : 'transparent',
                borderLeft: active === VIRTUAL_MD ? '3px solid var(--brand-primary)' : '3px solid transparent',
                borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>SKILL.md</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>同源·SOP</span>
            </div>
          )}
          {(groups[''] || []).sort().map(p => row(p, p, false))}
          {Object.keys(groups).filter(d => d).sort().map(dir => {
            const list = groups[dir].sort()
            const coll = collapsed[dir] ?? (list.length > 6)
            return (
              <div key={dir}>
                <div onClick={() => setCollapsed(prev => ({ ...prev, [dir]: !coll }))}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-light)' }}>
                  <span style={{ fontSize: 10 }}>{coll ? '▶' : '▼'}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir}>{dir}/</span>
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{list.length}</span>
                </div>
                {!coll && list.map(p => row(p, p.slice(dir.length + 1), true))}
              </div>
            )
          })}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isVirtual ? (
            <>
              <div style={{ fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--text-secondary)', marginBottom: 4 }}>
                📄 SKILL.md <span style={{ fontFamily: 'inherit', fontSize: 11, color: 'var(--text-muted)' }}>· 内容随上方技能信息自动生成，无需单独编辑</span>
              </div>
              <textarea className="code-editor" spellCheck={false} readOnly style={{ height: 320, opacity: 0.85 }} value={virtualMd} />
            </>
          ) : active && files[active] != null ? (
            <>
              <div style={{ fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--text-secondary)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={active}>📄 {active}</div>
              <textarea className="code-editor" spellCheck={false} style={{ height: 320 }}
                value={files[active]} onChange={e => patch({ ...files, [active]: e.target.value })} />
            </>
          ) : (
            <div style={{ padding: 20, fontSize: 13, color: 'var(--text-muted)' }}>
              选左侧文件编辑。SKILL.md 是执行引擎读的技能手册，scripts/ 下是可执行脚本；保存时经安全扫描，HIGH 风险会被拒。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
