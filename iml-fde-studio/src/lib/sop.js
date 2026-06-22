// 录制步骤 → SOP（确定性生成，无需人工点 AI）。参数步骤输出 {{占位}}，常量输出真实值。
export function stepsToSop(steps, name) {
  const S = steps || []
  const out = [`# ${name || '录制技能'} SOP`, '', '## 操作步骤']
  let n = 1
  const add = (t) => out.push(`${n++}. ${t}`)
  add('打开绑定的业务系统（地址来自业务系统连接，登录会话由客户端注入，无需账号密码）。')
  for (const s of S) {
    const label = s.label || ''
    const shown = s.param ? `{{${label || s.param}}}` : (s.value || '')
    if (s.act === 'fxPick' || s.act === 'select' || s.act === 'search') {
      const isSearch = s.kind === 'object_reference' || s.act === 'search'
      const verb = isSearch ? '检索并选择' : '选择'
      // 下拉：附上表单预置可选项（结构信息），不只是录制时选的那一个
      const opts = (!isSearch && Array.isArray(s.options) && s.options.length)
        ? `（下拉，可选：${s.options.filter(o => o && o !== '请选择').join(' / ')}）` : ''
      add(`在「${label}」${verb}「${shown}」${opts}。`)
    } else if (s.act === 'fill') {
      add(`在「${label}」填入「${shown}」（文本）。`)
    } else if (s.act === 'click') {
      if (s.nav) add(`进入「${label || '目标页'}」。`)
      else if (label) add(`点击「${label}」。`)
    }
    // hover / pickOption 视为噪声，不写入 SOP
  }
  out.push('', '## 反馈要求',
    '- 成功：回报操作完成，并复述关键信息（客户/对象、记录ID 等）。',
    '- 失败 / 未登录 / 无权限：如实说明卡在哪一步，不要编造数据。')
  return out.join('\n')
}
