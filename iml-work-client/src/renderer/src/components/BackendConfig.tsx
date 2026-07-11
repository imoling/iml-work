import { useState, useEffect } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { swallow } from '../utils'

// 后端服务地址配置：登录前（登录页）与登录后（设置页）都可用。
// 读/存 config('adminBaseUrl')，留空回落到默认 http://localhost:8080；「测试」探测连通性。
export default function BackendConfig() {
  const [url, setUrl] = useState('')
  const [effective, setEffective] = useState('http://localhost:8080')
  const [busy, setBusy] = useState<'test' | 'save' | ''>('')
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    window.api.invoke('backend:get-url')
      .then((r: any) => { setUrl(r?.url || ''); if (r?.effective) setEffective(r.effective) })
      .catch(e => swallow(e, 'backend:get-url'))
  }, [])

  const test = async () => {
    setBusy('test'); setResult(null)
    try {
      const r = await window.api.invoke('backend:ping', { url })
      setResult(r?.reachable
        ? { ok: true, msg: `可连接（HTTP ${r.status}） · ${r.base}` }
        : { ok: false, msg: `无法连接：${r?.error || '未知错误'}` })
    } catch (e: any) { setResult({ ok: false, msg: e?.message || '测试失败' }) }
    setBusy('')
  }
  const save = async () => {
    setBusy('save'); setResult(null)
    try {
      const r = await window.api.invoke('backend:set-url', url)
      if (r?.effective) setEffective(r.effective)
      setResult({ ok: true, msg: `已保存 · 当前生效：${r?.effective || effective}` })
    } catch (e: any) { setResult({ ok: false, msg: e?.message || '保存失败' }) }
    setBusy('')
  }

  return (
    <div className="backend-cfg">
      <div className="backend-cfg-row">
        <input value={url} onChange={e => setUrl(e.target.value)} spellCheck={false}
          placeholder={effective || 'http://localhost:8080'} />
        <button type="button" className="backend-cfg-btn" onClick={test} disabled={!!busy}>{busy === 'test' ? '测试中…' : '测试'}</button>
        <button type="button" className="backend-cfg-btn primary" onClick={save} disabled={!!busy}>{busy === 'save' ? '保存中…' : '保存'}</button>
      </div>
      {result
        ? <div className={`backend-cfg-msg ${result.ok ? 'ok' : 'err'}`}>{result.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}<span>{result.msg}</span></div>
        : <div className="backend-cfg-hint">留空则用默认 {effective || 'http://localhost:8080'}；改后需重新登录。</div>}
    </div>
  )
}
