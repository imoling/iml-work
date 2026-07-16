import { useState, useEffect, useCallback } from 'react'
import { BookMarked, Plus, Trash2, RefreshCw, ToggleLeft, ToggleRight, Pencil, Check, X } from 'lucide-react'

// 数据字典管理：系统内各类"分类/枚举"的单一事实来源（企业知识分类/本体业务域/业务系统类型…）。
// 改分类不再动代码：各端下拉实时读 /api/v1/dicts/{type}。删除项不影响历史数据里已写入的分类字符串。

interface DictItem { id: number; type: string; label: string; sortOrder: number; enabled: boolean }
interface ManageView { types: Record<string, DictItem[]>; typeLabels: Record<string, string> }

export default function DictManager() {
  const [view, setView] = useState<ManageView>({ types: {}, typeLabels: {} })
  const [activeType, setActiveType] = useState('')
  const [err, setErr] = useState('')
  // 新增项 / 新增类型
  const [newLabel, setNewLabel] = useState('')
  const [newTypeCode, setNewTypeCode] = useState('')
  const [newTypeFirstLabel, setNewTypeFirstLabel] = useState('')
  // 行内编辑
  const [editId, setEditId] = useState<number | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/dicts')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d: ManageView = await r.json()
      setView(d)
      setErr('')
      const types = Object.keys(d.types)
      setActiveType(prev => (prev && types.includes(prev)) ? prev : (types[0] || ''))
    } catch (e: any) { setErr(e.message || String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const call = async (method: string, url: string, body?: any): Promise<boolean> => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    if (!r.ok) {
      let msg = `HTTP ${r.status}`
      try { const d = await r.json(); if (d?.error) msg = d.error } catch { /* 非 JSON */ }
      alert(`操作失败：${msg}`)
      return false
    }
    return true
  }

  const items = view.types[activeType] || []
  const typeName = (t: string) => view.typeLabels[t] || t

  const addItem = async () => {
    if (!newLabel.trim() || !activeType) return
    const maxSort = items.reduce((m, it) => Math.max(m, it.sortOrder), 0)
    if (await call('POST', '/api/v1/dicts', { type: activeType, label: newLabel.trim(), sortOrder: maxSort + 1 })) { setNewLabel(''); load() }
  }
  const addType = async () => {
    if (!newTypeCode.trim() || !newTypeFirstLabel.trim()) return
    if (await call('POST', '/api/v1/dicts', { type: newTypeCode.trim(), label: newTypeFirstLabel.trim(), sortOrder: 1 })) {
      setActiveType(newTypeCode.trim()); setNewTypeCode(''); setNewTypeFirstLabel(''); load()
    }
  }
  const toggle = async (it: DictItem) => { if (await call('PUT', `/api/v1/dicts/${it.id}`, { enabled: !it.enabled })) load() }
  const saveEdit = async (it: DictItem) => {
    if (!editLabel.trim() || editLabel.trim() === it.label) { setEditId(null); return }
    if (await call('PUT', `/api/v1/dicts/${it.id}`, { label: editLabel.trim() })) { setEditId(null); load() }
  }
  const remove = async (it: DictItem) => {
    if (!confirm(`删除「${it.label}」？\n\n历史数据里已使用该分类的记录不受影响（保留为历史值）；新数据将不可再选它。`)) return
    if (await call('DELETE', `/api/v1/dicts/${it.id}`)) load()
  }
  const move = async (it: DictItem, dir: -1 | 1) => {
    const idx = items.findIndex(x => x.id === it.id)
    const swap = items[idx + dir]
    if (!swap) return
    // 交换排序号（简单可靠；并发编辑场景少）
    if (await call('PUT', `/api/v1/dicts/${it.id}`, { sortOrder: swap.sortOrder }) &&
        await call('PUT', `/api/v1/dicts/${swap.id}`, { sortOrder: it.sortOrder })) load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          分类/枚举的单一事实来源：企业知识分类、本体业务域等在此维护，各端下拉实时生效，改分类不再改代码。删除项不影响历史数据。
        </div>
        <button className="btn-secondary" onClick={load} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={13} />刷新</button>
      </div>
      {err && <div className="glass-panel" style={{ color: 'var(--accent-red)' }}>字典加载失败:{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
        {/* 左:类型列表 + 新增类型 */}
        <div className="glass-panel" style={{ padding: 14, height: 'fit-content', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}><BookMarked size={15} />字典类型</div>
          {Object.keys(view.types).map(t => (
            <button key={t} className={activeType === t ? 'btn-primary' : 'btn-secondary'} onClick={() => setActiveType(t)}
              style={{ justifyContent: 'flex-start', textAlign: 'left', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '8px 10px' }}>
              <span style={{ fontSize: 13 }}>{typeName(t)}</span>
              <span style={{ fontSize: 10, opacity: .7 }}>{t} · {(view.types[t] || []).length} 项</span>
            </button>
          ))}
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>新增类型（编码小写下划线 + 首个取值）</span>
            <input className="form-input" placeholder="类型编码,如 doc_level" value={newTypeCode} onChange={e => setNewTypeCode(e.target.value)} style={{ fontSize: 12 }} />
            <input className="form-input" placeholder="首个取值,如 一级" value={newTypeFirstLabel} onChange={e => setNewTypeFirstLabel(e.target.value)} style={{ fontSize: 12 }} />
            <button className="btn-secondary" disabled={!newTypeCode.trim() || !newTypeFirstLabel.trim()} onClick={addType} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, justifyContent: 'center' }}>
              <Plus size={13} />创建类型
            </button>
          </div>
        </div>

        {/* 右:当前类型的项管理 */}
        <div className="glass-panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{activeType ? typeName(activeType) : '—'}</span>
            <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{activeType}</code>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <input className="form-input" placeholder="新增取值…" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') addItem() }} style={{ fontSize: 12, width: 180 }} />
              <button className="btn-primary" disabled={!newLabel.trim()} onClick={addItem} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} />添加</button>
            </div>
          </div>

          {items.map((it, idx) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 8, opacity: it.enabled ? 1 : .5 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <button onClick={() => move(it, -1)} disabled={idx === 0} title="上移" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 1, color: 'var(--text-muted)' }}>▲</button>
                <button onClick={() => move(it, 1)} disabled={idx === items.length - 1} title="下移" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 1, color: 'var(--text-muted)' }}>▼</button>
              </div>
              {editId === it.id ? (
                <>
                  <input className="form-input" value={editLabel} autoFocus onChange={e => setEditLabel(e.target.value)}
                    onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') saveEdit(it); if (e.key === 'Escape') setEditId(null) }} style={{ fontSize: 12.5, flex: 1 }} />
                  <button className="btn-secondary" onClick={() => saveEdit(it)} title="保存"><Check size={13} /></button>
                  <button className="btn-secondary" onClick={() => setEditId(null)} title="取消"><X size={13} /></button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 13 }}>{it.label}</span>
                  {!it.enabled && <span style={{ fontSize: 10, color: 'var(--accent-red)' }}>已停用</span>}
                  <button className="btn-secondary" onClick={() => { setEditId(it.id); setEditLabel(it.label) }} title="改名"><Pencil size={12} /></button>
                  <button className="btn-secondary" onClick={() => toggle(it)} title={it.enabled ? '停用（下拉不再出现，历史不受影响）' : '启用'}>
                    {it.enabled ? <ToggleRight size={14} color="var(--accent-green, #16a34a)" /> : <ToggleLeft size={14} />}
                  </button>
                  <button className="btn-secondary" onClick={() => remove(it)} title="删除"><Trash2 size={12} color="var(--accent-red, #dc2626)" /></button>
                </>
              )}
            </div>
          ))}
          {activeType && items.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12 }}>该类型暂无取值，右上角添加。</div>}
        </div>
      </div>
    </div>
  )
}
