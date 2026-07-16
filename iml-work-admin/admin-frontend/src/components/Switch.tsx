/**
 * 滑动开关：轨道变色 + 滑块位移，状态一目了然。
 * 用于替代含义模糊的「checkbox + 开/关文案」（未勾选时用户会误以为勾选才是关）。
 * 键盘可达：内部仍是原生 checkbox（视觉隐藏），空格切换、focus 有品牌色光圈。
 */
export default function Switch({ checked, onChange, disabled, onText = '开', offText = '关' }: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** 开/关状态文字；传空串可只留轨道不显示文字 */
  onText?: string
  offText?: string
}) {
  return (
    <label className={`iml-switch${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="iml-switch-track" aria-hidden="true"><span className="iml-switch-thumb" /></span>
      {(checked ? onText : offText) && (
        <span className={`iml-switch-text${checked ? ' is-on' : ''}`}>{checked ? onText : offText}</span>
      )}
    </label>
  )
}
