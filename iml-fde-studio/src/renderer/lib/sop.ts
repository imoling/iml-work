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
    } else if (s.act === 'choose') {
      const opts = Array.isArray(s.options) && s.options.length ? `（可选：${s.options.join(' / ')}）` : ''
      add(`在「${label}」勾选「${shown}」${opts}。`)
    } else if (s.act === 'upload') {
      add(`在「${label || '附件'}」上传文件「${shown || '{{附件}}'}」。`)
    } else if (s.act === 'press') {
      if (s.value === 'Enter') add(`在「${label || '输入框'}」按回车${label ? '提交检索/表单' : ''}。`)
    } else if (s.act === 'agent') {
      add(`【AI 指令步】${s.value || label}（此步由 AI 现场读页面完成，只做这一步）。`)
    } else if (s.act === 'openTab') {
      add('系统在新窗口打开目标页面，切换到新窗口继续操作。')
    } else if (s.act === 'extract') {
      add(`提取「${label || '页面数据'}」列表数据。`)
    } else if (s.act === 'click') {
      if (s.nav) add(`进入「${label || '目标页'}」。`)
      else if (s.param) add(`在列表中找到并点击「${shown}」${s.repeat ? '所在行' : ''}。`)
      else if (label) add(`点击「${label}」。`)
    }
    // hover / pickOption 视为噪声，不写入 SOP
  }
  out.push('', '## 反馈要求',
    '- 成功：回报操作完成，并复述关键信息（客户/对象、记录ID 等）。',
    '- 失败 / 未登录 / 无权限：如实说明卡在哪一步，不要编造数据。')
  return out.join('\n')
}
