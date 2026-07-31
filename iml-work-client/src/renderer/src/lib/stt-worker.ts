// 语音转写 Worker：whisper 推理在这里跑，渲染主线程只传音频/收文本。
// 曾在主线程直接调 pipeline——实时模式每 2.5s 一轮整段重转，WASM 计算把 UI 占死（实测卡死）。
// 模型下载（fetch/Cache API）在 worker 内同样可用，CORS 同渲染层 origin。
import { pipeline, env } from '@huggingface/transformers'

let pipe: any = null

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data || {}
  if (type === 'init') {
    try {
      ;(env as any).remoteHost = payload.remoteHost
      pipe = null
      let lastPct = -1
      pipe = await pipeline('automatic-speech-recognition', payload.repo, {
        dtype: payload.dtype,
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && p.total) {
            const pct = Math.round((p.loaded / p.total) * 100)
            if (pct !== lastPct) { lastPct = pct; self.postMessage({ type: 'status', payload: `下载语音模型 ${pct}%（仅首次）` }) }
          }
          // 文件全下完到推理会话建好还有几秒——不给状态会看起来卡在 100%
          if (p?.status === 'done') self.postMessage({ type: 'status', payload: '初始化推理引擎…' })
        },
      })
      self.postMessage({ type: 'ready', id })
    } catch (err: any) {
      pipe = null
      self.postMessage({ type: 'error', id, payload: String(err?.message || err) })
    }
    return
  }
  if (type === 'transcribe') {
    try {
      if (!pipe) throw new Error('模型未加载')
      const out = await pipe(payload.audio as Float32Array, { language: 'chinese', task: 'transcribe' })
      self.postMessage({ type: 'result', id, payload: String(out?.text || '').trim() })
    } catch (err: any) {
      self.postMessage({ type: 'error', id, payload: String(err?.message || err) })
    }
  }
}
