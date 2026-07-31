// 语音输入按钮（本地引擎）：点击开始录音（红色脉冲），再点结束 →
// 本机 whisper 转写（Worker 内推理，见 lib/stt.ts）→ 文本追加到输入框。音频不上传。
// 状态就在按钮本体上表达：录音=红色脉冲、转写=话筒边缘转圈、出错=图标短暂变红（详情在 title）——
// 不用文字气泡（实测反馈：挤工具条/悬浮都显得怪）。
import { useEffect, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { VoiceRecorder } from '../../lib/stt-recorder'

type RecState = 'idle' | 'rec' | 'busy' | 'err'

export default function VoiceInput({ onStart, onText }: {
  /** 录音开始（宿主可借此聚焦输入框） */
  onStart: () => void
  /** 转写完成的文本（追加语义） */
  onText: (text: string) => void
}) {
  const [state, setState] = useState<RecState>('idle')
  const [errMsg, setErrMsg] = useState('')
  const recRef = useRef<VoiceRecorder | null>(null)

  useEffect(() => () => { recRef.current?.abort() }, [])   // 卸载兜底：停掉麦克风占用

  const fail = (msg: string) => {
    setErrMsg(msg)
    setState('err')
    setTimeout(() => { setErrMsg(''); setState('idle') }, 4000)
  }

  const toggle = async () => {
    if (state === 'busy') return
    if (state === 'rec') {
      setState('busy')
      try {
        const text = await recRef.current!.stop()
        recRef.current = null
        if (text) { onText(text); setState('idle') }
        else fail('没听清，请再试一次')
      } catch (e: any) {
        console.error('[voice-input] 转写失败:', e)
        recRef.current = null
        fail(`转写失败：${String(e?.message || e).slice(0, 60)}`)
      }
      return
    }
    try {
      const rec = new VoiceRecorder()
      await rec.start()
      recRef.current = rec
      onStart()
      setState('rec')
    } catch (e) {
      console.error('[voice-input] 无法访问麦克风:', e)
      fail('无法访问麦克风，请检查系统权限')
    }
  }

  const title = state === 'rec' ? '结束录音并转写'
    : state === 'busy' ? '正在转写…'
    : state === 'err' ? errMsg
    : '语音输入（本地转写，不上传）'

  return (
    <button type="button" className={`wb-mic ${state}`} onClick={toggle} title={title}>
      <Mic size={15} />
    </button>
  )
}
