// 字段抽取的提示词（叶子模块：纯函数，可离线评测——与运行时同构，别再各写一套）。
//
// 这是「一句话 → 业务系统表单」的关键一环：抽错一个字段，就是往真实业务系统里写错数据。
// 已经栽过两次，两次都写进了下面的规则里：
//   ① 模型把金额输出成**裸数字**（"预算(元)": 5000），代码只认字符串 → 静默丢成空。
//   ② 模型给"下周去北京"编了个"7月19日出发、7月14日返回"的荒唐日期，还真提交进了 OA。
//
// **字段类型必须进提示词**：控件是 date 就要 YYYY-MM-DD，是 datetime-local 就要 YYYY-MM-DDTHH:mm。
// 只告诉模型"这是个日期"，它填 "2026-07-13 14:00"（带空格），datetime-local 控件根本不认，一填就空。

import type { VisitField } from './types'

/** 控件类型 → 对模型的格式要求。与原生 <input type> 同名，录制时从 DOM 抓到什么就是什么。 */
const TYPE_RULE: Record<string, string> = {
  date: '纯日期 YYYY-MM-DD（如 2026-07-13）',
  'datetime-local': '日期+时间 YYYY-MM-DDTHH:mm，**中间是大写字母 T，不是空格**（如 2026-07-13T14:00）',
  time: '时间 HH:mm（如 14:00）',
  month: '年月 YYYY-MM',
  number: '纯数字，不带单位、不带千分位（如 5000，不要写「5000元」或「5,000」）',
  textarea: '完整的一段话，忠于用户原意，不要替他扩写',
}

export function buildFieldExtractPrompt(userContent: string, fields: VisitField[], now: Date): string {
  const today = now.toISOString().slice(0, 10)
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  // 逐字段给出「含义 + 格式要求」——泛泛说"日期类字段"是不够的，控件类型不同格式就不同。
  const fieldLines = fields.map(f => {
    const rule = TYPE_RULE[f.type]
    return `- ${f.name}（${f.label}）${rule ? `：${rule}` : ''}`
  }).join('\n')

  const optionLines = fields.filter(f => Array.isArray(f.options) && f.options.length)
    .map(f => `${f.name}(${f.label}) 只能从以下选项中选一个：${f.options!.join(' / ')}`)

  return `请从下面用户的描述中抽取字段值，输出严格 JSON 对象，键名固定为：${fields.map(f => f.name).join(', ')}。

【字段清单与格式要求】
${fieldLines}

【规则】
- 相对时间一律换算成绝对时间。现在是 ${today}（${weekday}）${hhmm}。"今天/明天/后天""下周X""N 天后""下午两点"等都要按当前时间算成具体值。
- 时间跨度：给了起始日期和天数（如"去北京 3 天"），结束日期 = 起始日期 + (天数-1) 天。
- **先后必须自洽**：任何"结束/返回/截止"类时间都不得早于对应的"开始/出发/起始"时间。推算不出来就**留空**让人工补——绝不能随便填一个（曾填出"7月19日出发、7月14日返回"的荒唐单子并真提交进了业务系统）。
- 所有值都用**字符串**输出（数字也加引号，如 "5000"，不要写成裸数字）；键名原样照抄，标点用半角。
- 找不到就输出空字符串。**绝不编造**关键信息（装置名、位号、客户名、联系人、金额、单号）——缺失留空，由人工补。${optionLines.length ? '\n\n【下拉字段】必须从给定选项里选最贴切的一个原样输出，选不出就留空：\n' + optionLines.join('\n') : ''}

只输出 JSON。

【用户描述】
${userContent}`
}
