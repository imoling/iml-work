// 本地语音转写引擎（本地 whisper 引擎）：**推理跑在 Web Worker**（stt-worker.ts），
// 主线程只传音频收文本——曾在主线程跑 WASM 推理，实时转写把 UI 占死（实测）。
// 音频绝不上传任何服务（安全红线同源）。模型版本从企业平台目录选择（tiny/base/small，按本机配置推荐）；
// 文件企业平台优先（/api/v1/stt-models，内网可用），平台未托管时回退 hf-mirror；仅首次下载，之后浏览器 Cache 离线可用。
const HF_MIRROR = 'https://hf-mirror.com'
const DEFAULT_REPO = 'onnx-community/whisper-base'

export interface SttModel {
  id: string
  name: string
  desc: string
  approxSize: string
  requirements: string
  minMemGb: number
  minCores: number
  repo: string
  hosted: boolean
}

/** 平台目录不可达时的兜底目录（只有默认模型，走公网镜像）。 */
const FALLBACK_CATALOG: SttModel[] = [{
  id: 'whisper-base', name: 'Whisper Base · 多语言', desc: '速度与精度均衡——默认模型',
  approxSize: '约 57MB', requirements: '8GB 内存 · 4 核', minMemGb: 8, minCores: 4,
  repo: DEFAULT_REPO, hosted: false,
}]

export async function fetchCatalog(): Promise<SttModel[]> {
  try {
    const base: string = await window.api.invoke('stt:model-base')
    if (base) {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3000)
      const r = await fetch(`${base}/api/v1/stt-models/catalog`, { signal: ctl.signal, cache: 'no-store' })
      clearTimeout(t)
      if (r.ok) {
        const list = await r.json()
        if (Array.isArray(list) && list.length) return list
      }
    }
  } catch { /* 平台不可达 → 兜底目录 */ }
  return FALLBACK_CATALOG
}

// 模型选择是设备级偏好（转写发生在本机），localStorage 即可，不进账号库
export function getSelectedModelId(): string {
  return localStorage.getItem('stt-model-id') || ''
}
function selectedRepo(): string {
  return localStorage.getItem('stt-model-repo') || DEFAULT_REPO
}
export function setSelectedModel(id: string, repo: string): void {
  localStorage.setItem('stt-model-id', id)
  localStorage.setItem('stt-model-repo', repo)
  resetWorker()   // 换模型 → 重建 worker 与转写管线
}

let modelSource: 'platform' | 'mirror' | '' = ''
export function getModelSource(): 'platform' | 'mirror' | '' { return modelSource }

/** 当前量化方案下该模型的目标权重文件名（探测平台与判断缓存共用，两处不一致就会误判）。 */
function weightFiles(repo: string): { encoder: string; decoder: string } {
  return repo.endsWith('whisper-small')
    ? { encoder: 'encoder_model_q4.onnx', decoder: 'decoder_model_merged_q4.onnx' }
    : { encoder: 'encoder_model_quantized.onnx', decoder: 'decoder_model_merged_quantized.onnx' }
}

/** 模型来源探测：企业平台托管了**当前量化方案的权重文件**才走平台；否则公网镜像。
 *  曾只探 config.json——平台清单升级期（有 config 缺新权重）会误走平台然后 404（实测）。 */
async function resolveRemoteHost(repo: string): Promise<string> {
  try {
    const base: string = await window.api.invoke('stt:model-base')
    if (base) {
      const probe = `${base}/api/v1/stt-models/${repo}/resolve/main/onnx/${weightFiles(repo).encoder}`
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 2500)
      const r = await fetch(probe, { method: 'HEAD', signal: ctl.signal, cache: 'no-store' })
      clearTimeout(t)
      if (r.ok) { modelSource = 'platform'; return `${base}/api/v1/stt-models` }
    }
  } catch { /* 平台不可达 → 回退镜像 */ }
  modelSource = 'mirror'
  return HF_MIRROR
}

/** 指定模型是否已在本地缓存：按当前量化方案的目标 decoder 文件精确判断。 */
export async function isModelCached(repo?: string): Promise<boolean> {
  const r = repo || selectedRepo()
  const tail = r.split('/').pop() || ''
  const decoderFile = weightFiles(r).decoder
  try {
    const cache = await caches.open('transformers-cache')
    const keys = await cache.keys()
    return keys.some(k => k.url.includes(`/${tail}/`) && k.url.endsWith(decoderFile))
  } catch { return false }
}

// ── Worker 代理：init 一次（含模型加载），之后 transcribe 逐条 RPC ─────────────
let worker: Worker | null = null
let readyPromise: Promise<void> | null = null
let initFailedAt = 0   // 失败冷却：实时转写循环 1.5s 一轮，失败后不冷却会变成重复加载风暴
let seq = 0
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
let statusCb: ((s: string) => void) | null = null

function resetWorker(): void {
  worker?.terminate()
  worker = null
  readyPromise = null
  for (const p of pending.values()) p.reject(new Error('转写引擎已重置'))
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent) => {
    const { type, id, payload } = e.data || {}
    if (type === 'status') { statusCb?.(String(payload || '')); return }
    const p = id !== undefined ? pending.get(id) : undefined
    if (!p) return
    pending.delete(id)
    if (type === 'error') p.reject(new Error(String(payload || '转写失败')))
    else p.resolve(String(payload ?? ''))
  }
  worker.onerror = (e) => { console.error('[stt] worker 崩溃:', e); resetWorker() }
  return worker
}

function rpc(type: string, payload: Record<string, unknown>, transfer?: Transferable[]): Promise<string> {
  const w = ensureWorker()
  const id = ++seq
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type, id, payload }, transfer || [])
  })
}

async function init(onStatus?: (s: string) => void): Promise<void> {
  if (!readyPromise) {
    if (Date.now() - initFailedAt < 10_000) throw new Error('语音模型加载刚失败，稍候自动重试')
    readyPromise = (async () => {
      const repo = selectedRepo()
      const remoteHost = await resolveRemoteHost(repo)
      onStatus?.(modelSource === 'platform' ? '从企业平台加载语音模型…' : '加载本地语音模型…')
      // small 整体用 q4：q8(QDQ) 在 onnxruntime-web 创建会话即崩（实测），q4 走 MatMulNBits 路径。
      // 与平台 CATALOG 文件清单、weightFiles 三处保持一致。
      const dtype = repo.endsWith('whisper-small') ? 'q4' : 'q8'
      statusCb = onStatus || null
      // 加载带硬超时：worker 里 session 创建挂起时不能让调用方永远等（实测卡死在「初始化推理引擎…」）
      const withTimeout = (p: Promise<string>) => Promise.race([
        p,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('模型加载超时（90s）——可能与本机推理引擎不兼容，请换用 Base 模型')), 90_000)),
      ])
      // 偶发网络抖动一次自动重试——实测「刷新后就好了」的都属于这类
      try {
        await withTimeout(rpc('init', { repo, remoteHost, dtype }))
      } catch (e) {
        console.error('[stt] 模型加载失败，2s 后自动重试一次:', e)
        onStatus?.('加载中断，自动重试…')
        await new Promise(r => setTimeout(r, 2000))
        resetWorker()   // 挂死的 worker 必须杀掉重建，原地重发只会同样挂死
        await withTimeout(rpc('init', { repo, remoteHost, dtype }))
      }
    })().catch(e => { readyPromise = null; initFailedAt = Date.now(); throw e })   // 失败可再手动重试，不留死承诺
  }
  return readyPromise
}

/** 预下载/预热模型（设置页「下载」按钮）。 */
export async function downloadModel(onStatus?: (s: string) => void): Promise<void> {
  await init(onStatus)
}

/** 16kHz 单声道 PCM → 文本（Worker 内推理，不阻塞 UI）。首次调用触发模型加载/下载。 */
export async function transcribe(audio: Float32Array, onStatus?: (s: string) => void): Promise<string> {
  await init(onStatus)
  statusCb = onStatus || null
  onStatus?.('正在转写…')
  // 拷贝后转移所有权（原数组可能还要继续累计）
  const copy = new Float32Array(audio)
  return rpc('transcribe', { audio: copy }, [copy.buffer])
}
