import { useUserStore } from '../stores/userStore'
import logoLight from '../assets/brand/logo-mark.svg'
import logoDark from '../assets/brand/logo-mark-dark.svg'

// 品牌 LOGO：字形部分亮色版是近黑 graphite、暗色背景下会消失，
// 所以按当前主题切换到浅字形的暗色变体。所有页面统一走这个组件，不再各自 <img src={logoMark}>。
export default function BrandMark({ height = 40, style }: { height?: number; style?: React.CSSProperties }) {
  const theme = useUserStore(s => s.theme)
  return (
    <img
      src={theme === 'dark' ? logoDark : logoLight}
      alt=""
      style={{ height, width: 'auto', display: 'block', ...style }}
    />
  )
}
