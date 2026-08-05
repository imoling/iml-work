// 本地沙箱（叶子模块，不 import main.ts）：本机 Docker 里跑与云端**同一镜像**的代码执行——
// 数据不出机、离线可用。镜像从管理平台资源中心下载（GET /resources/sandbox-image/download）。
// 执行语义对齐后端 SandboxExecService：bundle 铺进 /work、跑 /work/main.py、产物收 /out 与 /work/out；
// 网络策略对齐云端「运行时白名单」形态：无申报包 → 全程断网（--network none）；有申报包 → 联网执行
// （包已过技能安装时的白名单校验与高危裁决，与云端 runtimeNetworkWhitelisted=true 行为一致）。
// 隔离与云端同规格：内存/CPU/pids 限额 + 一次性容器跑完即删（动态虾池语义不变）。
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afetch, getAdminBaseUrl } from './http'
import { API } from './api-paths'
import { configGet, configSet } from './db'
import { swallow } from './util'

const pExecFile = promisify(execFile)

// GUI 启动的 Electron 拿不到 shell 的 PATH——brew 装的 docker/colima 全在 /opt/homebrew/bin（实测坑）
const EXEC_ENV = { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` }

export type SandboxMode = 'cloud' | 'local'
export function getSandboxMode(): SandboxMode {
  return configGet('sandbox-mode') === 'local' ? 'local' : 'cloud'
}
export function setSandboxMode(mode: SandboxMode): void {
  configSet('sandbox-mode', mode)
}

export interface LocalSandboxStatus {
  dockerOk: boolean
  dockerVersion: string
  brewOk: boolean
  imageReady: boolean
  imageTag: string
  platformImage: { ready: boolean; sizeBytes: number; fileName: string } | null
}

/** 云端沙箱在用的镜像 tag（与平台 info 一致；拉不到时用默认）。 */
let cachedTag = 'iml-sandbox:py312'

async function platformImageInfo(): Promise<{ ready: boolean; sizeBytes: number; fileName: string; imageTag: string } | null> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}${API.sandboxImage.info}`, { timeoutMs: 6000 })
    if (!r.ok) return null
    const j: any = await r.json()
    if (j?.imageTag) cachedTag = String(j.imageTag)
    return { ready: !!j.ready, sizeBytes: Number(j.sizeBytes || 0), fileName: String(j.fileName || ''), imageTag: String(j.imageTag || '') }
  } catch (e) { swallow(e, 'sandbox-image-info'); return null }
}

export async function localStatus(): Promise<LocalSandboxStatus> {
  let dockerOk = false
  let dockerVersion = ''
  try {
    const { stdout } = await pExecFile('docker', ['version', '--format', '{{.Server.Version}}'], { env: EXEC_ENV, timeout: 6000 })
    dockerVersion = stdout.trim()
    dockerOk = !!dockerVersion
  } catch (e) { swallow(e, 'docker-detect') }

  let brewOk = false
  try { await pExecFile('brew', ['--version'], { env: EXEC_ENV, timeout: 6000 }); brewOk = true } catch { /* 无 brew */ }

  const plat = await platformImageInfo()
  let imageReady = false
  if (dockerOk) {
    try {
      const { stdout } = await pExecFile('docker', ['images', '-q', cachedTag], { env: EXEC_ENV, timeout: 6000 })
      imageReady = !!stdout.trim()
    } catch (e) { swallow(e, 'docker-images') }
  }
  return {
    dockerOk, dockerVersion, brewOk, imageReady, imageTag: cachedTag,
    platformImage: plat ? { ready: plat.ready, sizeBytes: plat.sizeBytes, fileName: plat.fileName } : null,
  }
}

/** 从平台下载镜像 tar 并 docker load（onProgress 回报阶段与百分比）。 */
export async function installLocalImage(onProgress: (msg: string) => void): Promise<{ ok: boolean; error?: string }> {
  const st = await localStatus()
  if (!st.dockerOk) return { ok: false, error: '未检测到本机 Docker 运行时——请先安装 OrbStack / colima / Docker Desktop 任一' }
  const plat = await platformImageInfo()
  if (!plat?.ready) return { ok: false, error: '平台尚未托管沙箱镜像——请联系管理员在资源中心「导出镜像」' }

  const tmp = path.join(os.tmpdir(), `iml-sandbox-image-${Date.now()}.tar`)
  try {
    onProgress('正在从企业平台下载镜像…')
    const r = await afetch(`${getAdminBaseUrl()}${API.sandboxImage.download}`, { timeoutMs: 30 * 60_000 })
    if (!r.ok || !r.body) return { ok: false, error: `下载失败（HTTP ${r.status}）` }
    const total = plat.sizeBytes || Number(r.headers.get('content-length') || 0)
    let done = 0
    let lastPct = -1
    const ws = fs.createWriteStream(tmp)
    // @ts-ignore Node fetch body 是 web stream
    for await (const chunk of r.body as any) {
      ws.write(chunk)
      done += chunk.length
      if (total > 0) {
        const pct = Math.floor((done / total) * 100)
        if (pct !== lastPct) { lastPct = pct; onProgress(`下载镜像 ${pct}%（${(done / 1048576).toFixed(0)}MB / ${(total / 1048576).toFixed(0)}MB）`) }
      }
    }
    await new Promise<void>((res, rej) => ws.end((e: any) => (e ? rej(e) : res())))
    if (total > 0 && Math.abs(fs.statSync(tmp).size - total) > 1024) {
      return { ok: false, error: '下载不完整（大小与平台不符），请重试' }
    }
    onProgress('下载完成，正在导入本机 Docker（docker load）…')
    await pExecFile('docker', ['load', '-i', tmp], { env: EXEC_ENV, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
    const after = await localStatus()
    return after.imageReady ? { ok: true } : { ok: false, error: '导入后未检测到镜像，请重试或手动 docker load' }
  } catch (e: any) {
    swallow(e, 'sandbox-image-install')
    return { ok: false, error: String(e?.message || e).slice(0, 120) }
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 临时文件可能未创建 */ }
  }
}

/** 流式跑命令：输出逐行转发（进度可感知），超时杀进程。 */
function spawnStream(cmd: string, args: string[], onLine: (l: string) => void, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: EXEC_ENV })
    let lastErr = ''
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} 超时`)) }, timeoutMs)
    const feed = (d: Buffer) => {
      const line = d.toString().split('\n').map(x => x.trim()).filter(Boolean).pop()
      if (line) { lastErr = line; onLine(line.slice(0, 90)) }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('close', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(lastErr || `${cmd} 退出码 ${c}`)) })
    child.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** Docker 环境一键安装（macOS + Homebrew）：brew 装 colima+docker CLI → colima start。
 *  无 brew 时不硬来（装 brew 需要交互/sudo），如实引导手动装 OrbStack/Docker Desktop。 */
export async function installDockerRuntime(onProgress: (msg: string) => void): Promise<{ ok: boolean; error?: string }> {
  const st = await localStatus()
  if (st.dockerOk) return { ok: true }
  if (!st.brewOk) return { ok: false, error: '未检测到 Homebrew，无法自动安装——请手动安装 OrbStack（推荐）或 Docker Desktop 后回来点刷新' }
  try {
    // 只报阶段说明，不转发 brew/colima 的原始输出（用户反馈：脚本行看不懂还挤坏布局）；
    // 原始输出仍进 spawnStream 的 lastErr，失败时能给出具体原因。
    onProgress('第 1/2 步：安装 Docker 组件（约 1-3 分钟）…')
    await spawnStream('brew', ['install', '--quiet', 'colima', 'docker'], () => { /* 输出仅留作错误诊断 */ }, 20 * 60_000)
    onProgress('第 2/2 步：启动虚拟机（首次需下载系统镜像，约 2-5 分钟）…')
    await spawnStream('colima', ['start', '--cpu', '2', '--memory', '4'], () => { /* 同上 */ }, 15 * 60_000)
    const after = await localStatus()
    return after.dockerOk ? { ok: true } : { ok: false, error: '安装完成但 Docker 未响应——请重启应用后重试，或手动执行 colima start' }
  } catch (e: any) {
    swallow(e, 'docker-runtime-install')
    return { ok: false, error: String(e?.message || e).slice(0, 140) }
  }
}

export interface LocalExecResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
  files: { name: string; base64: string }[]
  engine: string
}

/** 本地容器执行（与云端 execViaBackendSandbox 返回同形状）。 */
/**
 * 容器名生成器。**三段缺一不可**：
 *
 * 原先只有 `iml-sbx-${Date.now().toString(36)}`，而毫秒时间戳在并发下根本不唯一——
 * 实测 5000 次紧密循环取名只产生 **2 个**唯一值。撞名的后果不是排队而是硬失败：
 *   `docker: Error response from daemon: Conflict. The container name "/iml-sbx-x" is already in use`
 * 它会被当成 `退出码 125` 回灌给模型，而模型对这个数字既读不懂也无法正确重试。
 *
 * 这**不是**并行子智能体才有的问题：runInContext 本来就支持多会话并发，两个会话同时跑
 * python 技能就会撞，只是概率低、表现成"偶发的沙箱执行失败"，容易被当环境问题略过。
 *
 * · 时间戳 —— 保留可读性（docker ps 里能看出什么时候起的）
 * · pid    —— 跨进程唯一（dev 与打包版可能同时在跑）
 * · 自增序 —— 进程内唯一，这才是真正堵住同毫秒并发的那一段
 */
let sbxSeq = 0
export function sandboxContainerName(): string {
  return `iml-sbx-${Date.now().toString(36)}-${process.pid.toString(36)}-${(sbxSeq++).toString(36)}`
}

export async function execViaLocalSandbox(code: string, packages: string[], files?: Record<string, string>): Promise<LocalExecResult | null> {
  const st = await localStatus()
  if (!st.dockerOk || !st.imageReady) return null   // 调用方据此回落云端

  // 工作目录必须在 $HOME 下：colima 默认只共享 $HOME，os.tmpdir()（/var/folders/…）
  // 挂载进容器是**空目录**（真跑实锤：main.py not found）。
  const sbxRoot = path.join(os.homedir(), '.iml-work', 'sandbox-tmp')
  fs.mkdirSync(sbxRoot, { recursive: true })
  const work = fs.mkdtempSync(path.join(sbxRoot, 'sbx-'))
  const outDir = path.join(work, '__out')
  fs.mkdirSync(outDir)
  const name = sandboxContainerName()
  try {
    fs.writeFileSync(path.join(work, 'main.py'), code, 'utf8')
    for (const [rel, b64] of Object.entries(files || {})) {
      const target = path.join(work, rel)
      if (!path.resolve(target).startsWith(path.resolve(work))) continue   // 路径穿越防护
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from(b64, 'base64'))
    }
    // 装包容错（与后端 SandboxExecService 同构）：一把梭失败就逐包降级，装不上的跳过并在 stderr 留痕
    // （如 mootdx→py-mini-racer 无 arm64 轮子）；缺失包由脚本 ImportError 暴露，自愈循环按手册换备用源。
    const pipFlags = '--quiet --no-warn-script-location --disable-pip-version-check'
    const pip = packages.length
      ? `if ! pip install ${pipFlags} ${packages.join(' ')} >&2; then `
        + `echo '[sandbox] 整体装包失败，逐包降级安装（失败的包会被跳过）' >&2; `
        + `for p in ${packages.join(' ')}; do pip install ${pipFlags} "$p" >&2 `
        + `|| echo "[sandbox] 依赖 $p 安装失败已跳过：import 它会 ImportError，请按技能手册改用不依赖它的备用数据源" >&2; done; fi; `
      : ''
    const wrapper = `set -e; mkdir -p /out /work/out; ${pip}python /work/main.py`
    const args = [
      'run', '--rm', '--name', name,
      '--memory', '512m', '--cpus', '1', '--pids-limit', '256',
      ...(packages.length ? [] : ['--network', 'none']),
      '-v', `${work}:/work`, '-v', `${outDir}:/out`,
      '-w', '/work', st.imageTag, 'sh', '-c', wrapper,
    ]
    const timeoutMs = 240_000
    const res = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn('docker', args, { env: EXEC_ENV })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const t = setTimeout(() => {
        timedOut = true
        // 超时先杀容器再杀进程——docker run 前台进程被杀容器可能残留
        execFile('docker', ['rm', '-f', name], { env: EXEC_ENV }, () => child.kill('SIGKILL'))
      }, timeoutMs)
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('close', (c) => { clearTimeout(t); resolve({ code: c, stdout, stderr, timedOut }) })
    })

    const outFiles: { name: string; base64: string }[] = []
    for (const dir of [outDir, path.join(work, 'out')]) {
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f)
        if (fs.statSync(fp).isFile()) outFiles.push({ name: f, base64: fs.readFileSync(fp).toString('base64') })
      }
    }
    return {
      ok: !res.timedOut && res.code === 0,
      stdout: res.stdout.slice(0, 512 * 1024),
      stderr: res.stderr.slice(0, 128 * 1024),
      ...(res.timedOut ? { error: `本地执行超时（${timeoutMs / 1000}s），容器已回收` } : res.code !== 0 ? { error: `退出码 ${res.code}` } : {}),
      files: outFiles,
      engine: '本地容器',
    }
  } catch (e: any) {
    swallow(e, 'sandbox-local-exec')
    return { ok: false, stdout: '', stderr: '', error: String(e?.message || e).slice(0, 200), files: [], engine: '本地容器' }
  } finally {
    execFile('docker', ['rm', '-f', name], { env: EXEC_ENV }, () => { /* 容器多半已 --rm 自删 */ })
    try { fs.rmSync(work, { recursive: true, force: true }) } catch (e) { swallow(e, 'sandbox-local-clean') }
  }
}
