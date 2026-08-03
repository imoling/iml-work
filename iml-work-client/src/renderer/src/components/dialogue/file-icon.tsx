// 文件卡左侧图标：图片产物直接显示画面缩略图，其余按扩展名给色块。
//
// 为什么值得单独做：AI 出图/出视频是"结果本身就是画面"的能力，交付一个写着 PNG 的灰方块
// 等于让用户每次都点开才知道对不对。缩略图让"这次生成对不对"在卡片上一眼可判。
import { useEffect, useState } from 'react'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i

export function FileCardIcon({ name }: { name: string }): JSX.Element {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const isImage = IMAGE_EXT.test(name)
  const [thumb, setThumb] = useState('')

  useEffect(() => {
    if (!isImage) return
    let alive = true
    // 失败（文件太大/已被删/不是图）就静默留在扩展名色块，不打扰用户——缩略图是锦上添花
    window.api.invoke('files:thumb', name)
      .then((r: any) => { if (alive && r?.success && r.dataUrl) setThumb(r.dataUrl) })
      .catch(() => {})
    return () => { alive = false }
  }, [name, isImage])

  if (thumb) {
    return <div className="file-card-icon is-thumb"><img src={thumb} alt={name} /></div>
  }
  if (VIDEO_EXT.test(name)) {
    // 视频不解首帧（要转码，代价太大）：给个明确的播放态，点开走系统播放器
    return <div className={`file-card-icon ext-${ext} is-video`}>▶</div>
  }
  return <div className={`file-card-icon ext-${ext}`}>{ext.slice(0, 4).toUpperCase() || 'F'}</div>
}
