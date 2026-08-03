// 多媒体生成引擎（图片 / 视频）：技能 SKILL.md 含 `IML-ENGINE: image-gen` 或 `IML-ENGINE: video-gen`
// 即分流到本模块。与 deep-research 同一形态——做成技能而非硬编码意图，技能中心统一管理/路由/装配。
//
// 为什么不能像别的生成类技能那样跑 Python 沙箱：沙箱是 networkIsolation=true 的，
// 脚本连不上任何外网，更不可能持有厂商密钥。所以走「客户端内置引擎 → 企业网关 → 上游」，
// 密钥只在网关侧（安全红线：模型统一经中转站，前端不裸连厂商）。
//
// 产物落地：把生成的图片/视频**下载进工作空间**，而不是丢个外链给用户。
// 外链是临时的（上游几小时后回收），用户过两天点开就是 404；而工作空间里的文件
// 与技能产出的 docx/pptx 同一套归档（会话子目录 + 产物索引 + 文件卡）。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次生成验证。
import { callLlm, corpGatewayBase, corpGatewayKey } from './llm'
import { configGet } from './db'
import { swallow } from './util'
import { downloadToWorkspace, saveBase64ToWorkspace } from './workspace-files'
import { runningState } from './automation-runtime'
import type { AgentTaskData, SkillExecOut } from './agent-types'
import type { AgentTrace } from './agent-trace'
import type { SendLog } from './types'

/** 技能标记（供 skill-forms 分流、skill-exec 侧判定共用，定义在此处避免环形依赖）。 */
export const IMAGE_GEN_MARKER = /IML-ENGINE:\s*image-gen/
export const VIDEO_GEN_MARKER = /IML-ENGINE:\s*video-gen/

// 生成模型名可配（不同网关接的上游不一样），默认取 Agnes 的免费档。
// 与对话模型的档位机制**不通用**：档位解决的是"同一次对话用哪个模型"，
// 生成模型是另一条能力线，网关按通道 modelType=image/video 路由。
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.0-flash'
const DEFAULT_VIDEO_MODEL = 'agnes-video-v2.0'

const IMAGE_MAX_N = 4                       // 单次最多出几张（成本闸，也避免刷屏）
const VIDEO_POLL_MS = 6_000                 // 轮询间隔
const VIDEO_DEADLINE_MS = 12 * 60_000       // 视频生成封顶等待时长
const VIDEO_MAX_BYTES = 200 * 1024 * 1024   // 视频体积上限（文档解析那 20MB 显然不够）

function imageModel(): string { return configGet('media-image-model') || DEFAULT_IMAGE_MODEL }
function videoModel(): string { return configGet('media-video-model') || DEFAULT_VIDEO_MODEL }

/** 打企业网关的多媒体端点。与 callLlm 同一套鉴权（corp key），只是路径不同。 */
async function gatewayCall(
  path: string,
  body: Record<string, unknown> | null,
  timeoutMs: number,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const url = `${corpGatewayBase()}${path}`
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${corpGatewayKey()}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch { /* 非 JSON 回执按原文报错 */ }
    if (!res.ok) {
      const msg = data?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`
      return { ok: false, error: msg }
    }
    return { ok: true, data }
  } catch (e: any) {
    return { ok: false, error: e?.name === 'TimeoutError' ? '网关请求超时' : (e?.message || String(e)) }
  }
}

/**
 * 把用户的口语请求改写成一条可用的生成提示词。
 *
 * 直接把原话丢给生成模型效果很差——"帮我画个开会的图"缺主体、风格、构图，出图基本不能用。
 * 这一步用对话模型补全画面要素。失败时**原样使用用户输入**（宁可效果差，不能因为改写崩了就不生成）。
 */
async function refinePrompt(userText: string, kind: 'image' | 'video', data: AgentTaskData): Promise<string> {
  const raw = (userText || '').trim()
  if (!raw) return raw
  const what = kind === 'image' ? '文生图' : '文生视频'
  const extra = kind === 'image'
    ? '补全：主体、场景、风格（写实/插画/3D/扁平等）、构图与光线。'
    : '补全：主体动作、镜头运动（推/拉/摇/跟）、场景、风格与节奏。视频通常只有几秒，别塞多个分镜。'
  const prompt = `把下面这句用户请求改写成一条高质量的${what}提示词。
${extra}
要求：一段话，不分点、不加引号、不写"提示词："这类前缀；忠于用户原意，不要自行加入他没提的品牌/人名/文字水印；画面里不要出现文字。
只输出提示词本身。

用户请求：${raw}`
  try {
    const out = await callLlm(prompt, data.llmConfig, { temperature: 0.7 })
    const cleaned = (out || '').trim().replace(/^["“」『]+|["”」』]+$/g, '').trim()
    // 模型偶尔答非所问（回一句"好的"）——太短就不采信，退回原文
    return cleaned.length >= 8 ? cleaned : raw
  } catch (e) {
    swallow(e, 'media-refine-prompt')
    return raw
  }
}

/**
 * 用户说"来三张"→ n=3。没说就 1 张（默认省钱）。
 *
 * 量词只认 张/幅/版 这类**图片专用**的。曾把"个"也算进来，但"画一张 4 个人开会的图"
 * 会被读成要 4 张——"个"在中文里是万能量词，绝大多数出现都在描述画面内容而不是张数。
 * 宁可漏判（用户再说一次"多来几张"），也不能因为一句描述就多烧三倍额度。
 */
function wantedCount(userText: string): number {
  const cn = '一二三四'
  const m = (userText || '').match(/([1-9]|[一二三四])\s*(?:张|幅|版)/)
  if (!m) return 1
  const d = cn.indexOf(m[1]) >= 0 ? cn.indexOf(m[1]) + 1 : Number(m[1])
  return Math.min(Math.max(d, 1), IMAGE_MAX_N)
}

/**
 * 从上游回执里挖出媒体地址。
 *
 * 各家 schema 不一（OpenAI 是 data[].url / data[].b64_json，别家可能是 video_url / output / result.url），
 * 而这条链路是"要么拿到文件、要么整个技能白跑"，所以宽容匹配所有见过的形状，
 * 最后再兜一层全对象扫描——找不到就如实报错，绝不假装成功。
 */
function extractMediaUrls(data: any): { urls: string[]; b64: string[] } {
  const urls: string[] = []
  const b64: string[] = []
  const push = (v: any) => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && !urls.includes(v)) urls.push(v)
  }
  const items: any[] = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.output) ? data.output
    : Array.isArray(data?.results) ? data.results : []
  for (const it of items) {
    if (typeof it === 'string') { push(it); continue }
    push(it?.url); push(it?.video_url); push(it?.image_url); push(it?.download_url)
    if (typeof it?.b64_json === 'string') b64.push(it.b64_json)
  }
  push(data?.url); push(data?.video_url); push(data?.download_url)
  push(data?.result?.url); push(data?.result?.video_url); push(data?.video?.url)
  // Agnes 视频任务完成后把地址放在 metadata.url（实测形状，2026-08-02）。
  // 深扫兜底也能捞到它，但主路径不该依赖兜底——已知的形状就写明。
  push(data?.metadata?.url); push(data?.metadata?.video_url)
  if (typeof data?.b64_json === 'string') b64.push(data.b64_json)

  if (!urls.length && !b64.length && data && typeof data === 'object') {
    // 兜底：深度扫一遍找像媒体的直链（未知 schema 时的最后一道防线）
    const seen = new Set<any>()
    const walk = (o: any, depth: number) => {
      if (!o || depth > 4 || seen.has(o)) return
      if (typeof o === 'object') { seen.add(o); for (const v of Object.values(o)) walk(v, depth + 1); return }
      if (typeof o === 'string' && /^https?:\/\/\S+\.(png|jpe?g|webp|gif|mp4|mov|webm)(\?|$)/i.test(o)) push(o)
    }
    walk(data, 0)
  }
  return { urls, b64 }
}

/** 落盘：URL 直接下载；b64 走 data: URL（downloadToWorkspace 只认 http，这里单独写文件）。 */
async function saveMedia(
  urls: string[], b64: string[], kind: 'image' | 'video', sendLog: SendLog,
): Promise<{ name: string; sizeBytes: number }[]> {
  const saved: { name: string; sizeBytes: number }[] = []
  for (const u of urls) {
    const r = await downloadToWorkspace(u, sendLog, {
      maxBytes: kind === 'video' ? VIDEO_MAX_BYTES : undefined,
      source: kind === 'image' ? 'image-gen' : 'video-gen',
    })
    if ('error' in r) { sendLog('observing', `保存失败：${r.error}`); continue }
    saved.push({ name: r.name, sizeBytes: r.sizeBytes })
  }
  if (b64.length) {
    // 极少数上游只回 base64（不给直链）。复用同一套归档路径，走 dataUrl 分支。
    for (const b of b64) {
      try {
        const r = saveBase64ToWorkspace(b, kind === 'image' ? 'image.png' : 'video.mp4',
          kind === 'image' ? 'image-gen' : 'video-gen')
        saved.push({ name: r.name, sizeBytes: r.sizeBytes })
      } catch (e) { swallow(e, 'media-save-b64') }
    }
  }
  return saved
}

/** 汇报指令：产物是图/视频，文件卡已经把东西摆出来了，正文别复述文件名，也别描述"画面里有什么"（模型没看过成品）。 */
function reportHint(skl: string, kind: 'image' | 'video', prompt: string, files: { name: string }[]): string {
  const what = kind === 'image' ? '图片' : '视频'
  return `【技能 "${skl}" 真实执行结果】已按下述提示词生成 ${files.length} 个${what}并保存到工作空间：\n"""\n${prompt}\n"""\n\n请用**一两句话**汇报已生成完毕、并复述本次采用的画面要点（即上面的提示词大意）即可。\n文件卡会在下方自动展示文件与预览入口，**不要**罗列文件名、大小、路径。\n你并没有看到成品画面，**绝不要描述成品里具体有什么**（构图、颜色、人物表情等），只能陈述"按 XX 要求生成"。\n如果用户想调整，提示他直接说要改哪里即可重新生成。`
}

/**
 * 用户点了停止 → 立刻收手，并且**不产出成功语气的汇报**。
 *
 * 光靠 abortRun 置位不够：它只是把挂起的等待用空值 resolve 掉，管线会照常往下跑到合成，
 * 于是一个已被停止的任务过一会儿还是冒出一条答复（2026-08-02 实测，deep-research 早前也踩过同一坑）。
 * 所以每个耗时环节前后都要显式检查，检查到就按"已终止"收尾。
 */
function bailIfAborted(kind: 'image' | 'video', skl: string, sendLog: SendLog, trace: AgentTrace, out: SkillExecOut): boolean {
  if (!runningState.aborted) return false
  const what = kind === 'image' ? '图片' : '视频'
  sendLog('completed', `已终止${what}生成。`)
  out.skillOk = false
  out.skillResult = `🚫 ${what}生成已按你的要求终止。`
  out.skillPromptHint = `【技能 "${skl}" 用户终止】用户中途取消，未产出任何${what}。请简短确认已终止即可，绝不声称已生成或描述任何画面。`
  trace.spans.push({ type: 'skill', name: `${kind === 'image' ? '图片' : '视频'}生成·${skl}`, status: 'warn' })
  return true
}

/** 图片生成：同步接口，一次请求拿到结果。 */
export async function runImageGen(
  data: AgentTaskData, skl: string, sendLog: SendLog, trace: AgentTrace, out: SkillExecOut,
): Promise<void> {
  const n = wantedCount(data.content)
  if (bailIfAborted('image', skl, sendLog, trace, out)) return
  sendLog('thinking', '正在整理画面要素…')
  const prompt = await refinePrompt(data.content, 'image', data)
  // 提示词改写也要几秒，用户很可能就在这期间点的停止——别再往上游发生成请求（要花钱）
  if (bailIfAborted('image', skl, sendLog, trace, out)) return
  sendLog('acting', `生成图片（${n} 张）：${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`)

  const res = await gatewayCall('/images/generations', { model: imageModel(), prompt, n }, 240_000)
  if (!res.ok) {
    sendLog('observing', `图片生成失败：${res.error}`)
    out.skillOk = false
    out.skillResult = `❌ 图片生成失败：${res.error}`
    out.skillPromptHint = `【技能 "${skl}" 执行失败】图片生成接口报错："${res.error}"。请如实告知用户本次未生成成功与原因（若提示无可用通道，建议联系管理员在管理端登记图片生成通道），绝不编造已生成图片。`
    trace.spans.push({ type: 'skill', name: `图片生成·${skl}`, status: 'warn' })
    return
  }

  const { urls, b64 } = extractMediaUrls(res.data)
  if (!urls.length && !b64.length) {
    sendLog('observing', '上游未返回图片地址')
    out.skillOk = false
    out.skillResult = '❌ 图片生成未返回可用结果'
    out.skillPromptHint = `【技能 "${skl}" 执行失败】上游回执里没有图片地址。请如实告知用户本次没能拿到图片，绝不编造。`
    trace.spans.push({ type: 'skill', name: `图片生成·${skl}`, status: 'warn' })
    return
  }

  // 已生成出来了就照常落盘（钱已经花了，丢掉更亏），但汇报按终止口径
  const files = await saveMedia(urls, b64, 'image', sendLog)
  if (bailIfAborted('image', skl, sendLog, trace, out)) return
  finish(files, 'image', skl, prompt, sendLog, trace, out)
}

/** 视频生成：**异步任务**——提交拿 task_id，再轮询到完成。 */
export async function runVideoGen(
  data: AgentTaskData, skl: string, sendLog: SendLog, trace: AgentTrace, out: SkillExecOut,
): Promise<void> {
  if (bailIfAborted('video', skl, sendLog, trace, out)) return
  sendLog('thinking', '正在整理镜头与画面要素…')
  const prompt = await refinePrompt(data.content, 'video', data)
  if (bailIfAborted('video', skl, sendLog, trace, out)) return
  sendLog('acting', `提交视频生成任务：${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`)

  const fail = (msg: string, hint: string) => {
    sendLog('observing', msg)
    out.skillOk = false
    out.skillResult = `❌ ${msg}`
    out.skillPromptHint = `【技能 "${skl}" 执行失败】${hint} 请如实告知用户本次未生成成功与原因，绝不编造已生成视频。`
    trace.spans.push({ type: 'skill', name: `视频生成·${skl}`, status: 'warn' })
  }

  const sub = await gatewayCall('/videos', { model: videoModel(), prompt }, 180_000)
  if (!sub.ok) return fail(`视频生成提交失败：${sub.error}`, `提交接口报错："${sub.error}"（若提示无可用通道，建议联系管理员在管理端登记视频生成通道）。`)

  const taskId = sub.data?.task_id || sub.data?.id || sub.data?.taskId
  // 少数上游同步直出（不给 task_id 就给结果），先看有没有直接可用的地址
  const direct = extractMediaUrls(sub.data)
  if (!taskId && !direct.urls.length && !direct.b64.length) {
    return fail('视频生成未返回任务号', '上游回执里既没有 task_id 也没有视频地址。')
  }

  let media = direct
  if (taskId) {
    sendLog('observing', `任务已提交（${taskId}），视频生成通常需要 1-5 分钟，请稍候…`)
    const deadline = Date.now() + VIDEO_DEADLINE_MS
    let lastProgress = -1
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, VIDEO_POLL_MS))
      // 视频最长要等 12 分钟——不每轮查一次，用户点了停止还得干等到底
      if (bailIfAborted('video', skl, sendLog, trace, out)) return
      const st = await gatewayCall(`/videos/${encodeURIComponent(taskId)}`, null, 60_000)
      if (!st.ok) { swallow(new Error(st.error), 'video-poll'); continue }   // 单次轮询失败不终止，等下一轮

      const status = String(st.data?.status || '').toLowerCase()
      const progress = Number(st.data?.progress ?? -1)
      if (progress >= 0 && progress !== lastProgress) {
        lastProgress = progress
        sendLog('thinking', `视频生成中… ${progress <= 1 ? Math.round(progress * 100) : Math.round(progress)}%`)
      }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
        return fail(`视频生成失败：${st.data?.error || st.data?.message || status}`, `上游任务状态为 ${status}。`)
      }
      const got = extractMediaUrls(st.data)
      if (got.urls.length || got.b64.length) { media = got; break }
      if (['succeeded', 'success', 'completed', 'done'].includes(status)) {
        return fail('视频任务显示完成但没给地址', '上游标记任务完成，回执里却没有视频地址。')
      }
    }
    if (!media.urls.length && !media.b64.length) {
      return fail(`视频生成超时（已等待 ${VIDEO_DEADLINE_MS / 60_000} 分钟）`,
        `任务 ${taskId} 在超时前未完成——任务可能仍在上游排队，但本次会话不再等待。`)
    }
  }

  sendLog('acting', '视频已生成，正在下载到工作空间…')
  const files = await saveMedia(media.urls, media.b64, 'video', sendLog)
  if (bailIfAborted('video', skl, sendLog, trace, out)) return
  finish(files, 'video', skl, prompt, sendLog, trace, out)
}

/** 两条链路的共同收尾：落盘结果 → 产物清单 → 汇报指令 → trace。 */
function finish(
  files: { name: string; sizeBytes: number }[], kind: 'image' | 'video',
  skl: string, prompt: string, sendLog: SendLog, trace: AgentTrace, out: SkillExecOut,
): void {
  const what = kind === 'image' ? '图片' : '视频'
  const label = kind === 'image' ? '图片生成' : '视频生成'
  if (!files.length) {
    sendLog('observing', `${what}下载失败，未保存到工作空间`)
    out.skillOk = false
    out.skillResult = `❌ ${what}已生成，但下载到工作空间失败`
    out.skillPromptHint = `【技能 "${skl}" 部分失败】上游生成了${what}，但下载保存失败（网络或体积超限）。请如实告知用户，绝不编造文件已保存。`
    trace.spans.push({ type: 'skill', name: `${label}·${skl}`, status: 'warn' })
    return
  }
  sendLog('completed', `已生成 ${files.length} 个${what}并保存到工作空间：${files.map(f => f.name).join('、')}`)
  out.skillOk = true
  out.skillFiles = files
  out.skillResult = `🎨 已生成 ${files.length} 个${what}并保存到工作空间。`
  out.skillPromptHint = reportHint(skl, kind, prompt, files)
  trace.spans.push({ type: 'skill', name: `${label}·${skl}`, status: 'ok' })
}
