// 语音录音器：点击开始录音（MediaRecorder 收分片 + AnalyserNode 电平），点击停止后
// 整段解码送 whisper 转写（推理在 Worker，见 stt.ts）。
// 曾做过"边说边出字"的准实时版（周期性整段重转）——转写抖动 + 引擎负载得不偿失，
// 按用户拍板（2026-08-01）回归"停止后转写"的简单交互。
// 定稿带超时，绝不让「停止」卡死；失败直接抛给调用方展示。
import { transcribe } from './stt'

const FINAL_TIMEOUT_MS = 60_000

export class VoiceRecorder {
  private mr: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private blobs: Blob[] = []
  private meter: { ac: AudioContext; raf: number } | null = null

  /** 开始录音；onLevel 实时电平 0-1（收音动效）。 */
  async start(onLevel?: (v: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.blobs = []

    if (onLevel) {
      const ac = new AudioContext()
      const an = ac.createAnalyser()
      an.fftSize = 512
      ac.createMediaStreamSource(this.stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const tick = () => {
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
        if (this.meter) this.meter.raf = requestAnimationFrame(tick)
      }
      this.meter = { ac, raf: requestAnimationFrame(tick) }
    }

    this.mr = new MediaRecorder(this.stream)
    this.mr.ondataavailable = (e) => { if (e.data.size) this.blobs.push(e.data) }
    this.mr.start(1000)
  }

  /** 停止录音并转写整段；失败/超时抛错（由调用方展示）。 */
  async stop(onStatus?: (s: string) => void): Promise<string> {
    // 等 MediaRecorder 吐出最后一片再停流
    if (this.mr && this.mr.state !== 'inactive') {
      await new Promise<void>(res => {
        this.mr!.onstop = () => res()
        this.mr!.stop()
        setTimeout(res, 1500)   // onstop 不来也不等死
      })
    }
    this.cleanupCapture()
    if (!this.blobs.length) return ''
    onStatus?.('正在转写…')
    const buf = await new Blob(this.blobs).arrayBuffer()
    this.blobs = []
    const ac = new AudioContext({ sampleRate: 16000 })
    let audio: Float32Array
    try {
      const decoded = await ac.decodeAudioData(buf)
      audio = decoded.getChannelData(0)
    } finally {
      ac.close().catch(() => { /* 已关闭 */ })
    }
    if (audio.length < 8000) return ''   // 不足半秒，视为误触
    return Promise.race([
      transcribe(audio, onStatus),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('转写超时（60s）——请重试或换用更小的模型')), FINAL_TIMEOUT_MS)),
    ])
  }

  private cleanupCapture(): void {
    if (this.meter) { cancelAnimationFrame(this.meter.raf); this.meter.ac.close().catch(() => { /* 已关闭 */ }); this.meter = null }
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    this.mr = null
  }

  /** 立即中断丢弃（组件卸载兜底）。 */
  abort(): void {
    try { if (this.mr && this.mr.state !== 'inactive') this.mr.stop() } catch { /* 已停止 */ }
    this.cleanupCapture()
    this.blobs = []
  }
}
