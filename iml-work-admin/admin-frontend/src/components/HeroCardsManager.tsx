import { useEffect, useState } from 'react'
import imgDeepResearch from '../assets/hero/deep-research.svg'
import imgStock from '../assets/hero/stock.svg'
import imgDocGen from '../assets/hero/doc-gen.svg'
import imgCodeDev from '../assets/hero/code-dev.svg'
import imgPersonalHub from '../assets/hero/personal-hub.svg'
import imgBizOps from '../assets/hero/biz-ops.svg'

// 卡片管理：客户端首页欢迎卡片与示例话术的可视化编辑。
// 存 /api/v1/client-config/hero-cards（JSON = Card[]）；客户端启动拉取，未配置回退内置语料。
// 上限 6 张（客户端 3×2 布局）；示例可指定 skillId → 客户端点选时锁定该技能直执行。
// key 决定客户端配图：内置六个 key 各有专属插图，新 key 用文档插图兜底。

interface Example { scene: string; text: string; skillId?: string; skillName?: string }
interface Card { key: string; name: string; desc: string; examples: Example[]; img?: string }

const MAX_CARDS = 6
const KNOWN_KEYS = ['deep-research', 'stock', 'doc-gen', 'code-dev', 'personal-hub', 'biz-ops']
// 与客户端同一套内置插图（按 key 对应）；自定义 key 暂用文档图兜底。生成/上传图片后续支持。
const KEY_IMG: Record<string, string> = {
  'deep-research': imgDeepResearch, stock: imgStock, 'doc-gen': imgDocGen,
  'code-dev': imgCodeDev, 'personal-hub': imgPersonalHub, 'biz-ops': imgBizOps,
}

export default function HeroCardsManager() {
  const [cards, setCards] = useState<Card[]>([])
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([])
  const [msg, setMsg] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState(0)
  const [genPrompt, setGenPrompt] = useState('')
  const [genBusy, setGenBusy] = useState(false)

  useEffect(() => {
    fetch('/api/v1/client-config/hero-cards').then(r => r.json()).then(d => {
      try {
        const arr = JSON.parse(d?.value || '[]')
        if (Array.isArray(arr)) setCards(arr)
      } catch { setMsg('已存配置解析失败，请检查后重新保存') }
      setLoaded(true)
    }).catch(() => { setMsg('读取配置失败'); setLoaded(true) })
    fetch('/api/v1/skills/catalog?size=300').then(r => r.json()).then(d => {
      const rows = Array.isArray(d) ? d : (d?.content || d?.items || [])
      setSkills(rows.map((s: any) => ({ id: String(s.id), name: String(s.name || s.id) })).filter((s: any) => s.id))
    }).catch(() => { /* 技能表拉不到只影响下拉，不影响编辑 */ })
  }, [])

  const patchCard = (i: number, p: Partial<Card>) =>
    setCards(cs => cs.map((c, idx) => idx === i ? { ...c, ...p } : c))
  const patchEx = (i: number, j: number, p: Partial<Example>) =>
    setCards(cs => cs.map((c, idx) => idx !== i ? c : {
      ...c, examples: c.examples.map((e, jdx) => jdx === j ? { ...e, ...p } : e),
    }))

  const setSkill = (i: number, j: number, skillId: string) => {
    if (!skillId) { patchEx(i, j, { skillId: undefined, skillName: undefined }); return }
    const s = skills.find(x => x.id === skillId)
    patchEx(i, j, { skillId, skillName: s?.name || skillId })
  }


  // ── 自定义插图：上传（canvas 压到 400×240 cover，几十 KB 进配置）/ AI 生成（走网关图片通道）──
  const setImg = (i: number, img?: string) => patchCard(i, { img })

  const uploadImg = (i: number, file: File) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const W = 400, H = 240
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H
      const ctx = cv.getContext('2d')
      if (!ctx) { setMsg('浏览器不支持 canvas'); return }
      const sc = Math.max(W / image.width, H / image.height)
      ctx.drawImage(image, (W - image.width * sc) / 2, (H - image.height * sc) / 2, image.width * sc, image.height * sc)
      URL.revokeObjectURL(url)
      let dataUrl = cv.toDataURL('image/webp', 0.85)
      if (!dataUrl.startsWith('data:image/webp')) dataUrl = cv.toDataURL('image/jpeg', 0.85)
      setImg(i, dataUrl)
      setMsg('插图已就绪，记得点「保存全部」')
    }
    image.onerror = () => { URL.revokeObjectURL(url); setMsg('图片读取失败，请换一张') }
    image.src = url
  }

  const genImg = async (i: number) => {
    const c = cards[i]
    const prompt = genPrompt.trim()
      || `为效率工具首页卡片「${c.name}」画一张扁平插画：${c.desc || c.name}。柔和浅色渐变背景、圆角构图、现代简洁、不要出现文字。`
    setGenBusy(true); setMsg('')
    try {
      const r = await fetch('/api/v1/model/images/generations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'corp-image', prompt, n: 1 }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok) throw new Error(d?.error?.message || d?.error || `HTTP ${r.status}`)
      const item = Array.isArray(d?.data) ? d.data[0] : null
      if (typeof item?.b64_json === 'string' && item.b64_json) {
        setImg(i, `data:image/png;base64,${item.b64_json}`)
        setMsg('插图已生成，记得点「保存全部」')
      } else if (typeof item?.url === 'string' && item.url) {
        setImg(i, item.url)
        setMsg('已使用生成图链接（部分厂商链接有时效，建议下载后改用「上传」固化）')
      } else throw new Error('上游未返回图片数据')
    } catch (e: any) { setMsg(`生成失败：${e?.message || e}`) }
    setGenBusy(false)
  }

  const addCard = () => {
    if (cards.length >= MAX_CARDS) return
    const key = prompt(`卡片 key（决定客户端配图；内置可选：${KNOWN_KEYS.join(' / ')}，也可自定义）`)?.trim()
    if (!key) return
    if (cards.some(c => c.key === key)) { setMsg(`key「${key}」已存在`); return }
    setCards(cs => [...cs, { key, name: '新卡片', desc: '', examples: [] }])
    setTab(cards.length)
  }

  const save = async () => {
    setMsg('')
    if (cards.length > MAX_CARDS) { setMsg(`最多 ${MAX_CARDS} 张卡片`); return }
    for (const c of cards) {
      if (!c.key.trim() || !c.name.trim()) { setMsg('每张卡的 key 与名称不能为空'); return }
      for (const e of c.examples) {
        if (!e.scene.trim() || !e.text.trim()) { setMsg(`卡片「${c.name}」有示例的场景名或话术为空`); return }
      }
    }
    const r = await fetch('/api/v1/client-config/hero-cards', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(cards) }),
    }).catch(() => null)
    setMsg(r?.ok ? '✅ 已保存，客户端下次打开首页生效' : `保存失败${r ? `：HTTP ${r.status}` : '：网络错误'}`)
  }

  return (
    <div>
      <div className="glass-panel" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <strong>客户端首页卡片（{cards.length}/{MAX_CARDS}）</strong>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            示例可锁定技能：客户端点选该示例时直接以指定技能执行，不再走路由判定；不选则按常规判定。
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button className="btn-secondary" onClick={addCard} disabled={cards.length >= MAX_CARDS}>＋ 添加卡片</button>
            <button className="btn-primary" onClick={save}>保存全部</button>
          </span>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 13 }}>{msg}</div>}
        {loaded && !cards.length && (
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            尚未配置——客户端正在使用内置语料。点「添加卡片」从零配置，保存后以此处为准。
          </div>
        )}
      </div>

      {cards.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {cards.map((c, i) => (
            <button key={`${c.key}-${i}`} className={i === tab ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setTab(i)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <img src={KEY_IMG[c.key] || imgDocGen} alt="" style={{ width: 28, height: 17, borderRadius: 3, objectFit: 'cover' }} />
              {c.name || c.key}
            </button>
          ))}
        </div>
      )}
      {cards.map((c, i) => i === tab && (
        <div className="glass-panel" key={`${c.key}-${i}`} style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <img src={c.img || KEY_IMG[c.key] || imgDocGen} alt=""
                style={{ width: 200, height: 120, objectFit: 'cover', borderRadius: 10, display: 'block', border: '1px solid var(--border-color)' }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', width: 200 }}>
                <label className="btn-secondary" style={{ cursor: 'pointer' }}>
                  上传
                  <input type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={ev => { const f = ev.target.files?.[0]; if (f) uploadImg(i, f); ev.target.value = '' }} />
                </label>
                <button className="btn-secondary" disabled={genBusy} onClick={() => genImg(i)}>{genBusy ? '生成中…' : 'AI 生成'}</button>
                {c.img && <button className="btn-ghost" onClick={() => setImg(i, undefined)}>恢复默认</button>}
              </div>
              <input className="form-input" value={genPrompt} onChange={ev => setGenPrompt(ev.target.value)}
                placeholder="生成提示词（留空按卡片名/描述自动写）" style={{ width: 200, marginTop: 6, fontSize: 12 }} />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, width: 200 }}>
                上传图自动压缩为 400×240 存进配置；未自定义时按 key 用内置插图。
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{ fontSize: 12, background: 'var(--bg-hover)', color: 'var(--text-secondary)', padding: '3px 8px', borderRadius: 6 }}>{c.key}</code>
            <input className="form-input" value={c.name} onChange={e => patchCard(i, { name: e.target.value })}
              placeholder="卡片名称" style={{ width: 160, fontWeight: 600 }} />
            <input className="form-input" value={c.desc} onChange={e => patchCard(i, { desc: e.target.value })}
              placeholder="卡片一句话描述" style={{ flex: 1, minWidth: 240 }} />
            <button className="btn-danger" onClick={() => { if (confirm(`删除卡片「${c.name}」及其 ${c.examples.length} 条示例？`)) { setCards(cs => cs.filter((_, idx) => idx !== i)); setTab(t => Math.max(0, t - (i <= t ? 1 : 0))) } }}
              >删除卡片</button>
          </div>

          <table style={{ width: '100%', marginTop: 10, fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                <th style={{ width: 130, padding: '4px 6px' }}>场景名</th>
                <th style={{ padding: '4px 6px' }}>话术（点选后填进客户端输入框）</th>
                <th style={{ width: 210, padding: '4px 6px' }}>锁定技能</th>
                <th style={{ width: 52 }} />
              </tr>
            </thead>
            <tbody>
              {c.examples.map((e, j) => (
                <tr key={j} style={{ verticalAlign: 'top', borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '6px' }}>
                    <input className="form-input" value={e.scene} onChange={ev => patchEx(i, j, { scene: ev.target.value })} style={{ width: '100%' }} />
                  </td>
                  <td style={{ padding: '6px' }}>
                    <textarea className="form-textarea" value={e.text} onChange={ev => patchEx(i, j, { text: ev.target.value })}
                      rows={Math.min(4, Math.max(1, Math.ceil(e.text.length / 60)))} style={{ width: '100%', resize: 'vertical' }} />
                  </td>
                  <td style={{ padding: '6px' }}>
                    <select className="form-select" value={e.skillId || ''} onChange={ev => setSkill(i, j, ev.target.value)} style={{ width: '100%' }}>
                      <option value="">（不锁定 · 常规判定）</option>
                      {skills.map(s => <option key={s.id} value={s.id}>{s.name}（{s.id}）</option>)}
                      {e.skillId && !skills.some(s => s.id === e.skillId) && (
                        <option value={e.skillId}>{e.skillName || e.skillId}（已配置）</option>
                      )}
                    </select>
                  </td>
                  <td style={{ padding: '6px' }}>
                    <button className="btn-danger" onClick={() => patchCard(i, { examples: c.examples.filter((_, jdx) => jdx !== j) })}
                      >删</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-secondary" style={{ marginTop: 6 }}
            onClick={() => patchCard(i, { examples: [...c.examples, { scene: '', text: '' }] })}>＋ 添加示例</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
