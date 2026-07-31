// 工具调用 → 一行人话。对话框里那句「正在检索"2026 年报销标准"」就是这里合成的。
//
// 为什么在前端合成而不是让模型每次说明用途（同款取舍）：
// 让模型为**每一次**调用写一句用途，既费 token 又措辞飘忽（同一个检索一会儿叫"查询"一会儿叫"搜索"）。
// 模型只负责每**批**调用前写一句叙述（narration），单次调用的描述由这里按模板合成——省钱且措辞统一。
//
// 三段式（pre + obj + post）是为了让 UI 能把「对象」加粗：「检索 」+「2026年报销标准」+「」。
import type { TurnTodo } from '../../../../shared/turn-protocol'

export interface HumanLine { pre: string; obj?: string; post?: string }

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// 末段是这类通用文件名时，单看它完全没有区分度（新华网每篇稿子都叫 c.html，
// 连读两篇不同报道会显示成一模一样的两行，看着像重复调用）——这时往前多取一段。
const GENERIC_TAIL = /^(index|default|page|main|c|s|t)\.(html?|htm|php|aspx?|jsp)$/i

/** URL 只展示域名 + 关键路径段，整条链接会把行撑爆。 */
function shortUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const segs = u.pathname.split('/').filter(Boolean)
    const host = u.hostname.replace(/^www\./, '')
    const last = segs[segs.length - 1] || ''
    const pick = GENERIC_TAIL.test(last) && segs.length > 1 ? segs.slice(-2).join('/') : last
    return host + (pick ? `/${trunc(pick, 28)}` : '')
  } catch { return trunc(raw, 40) }
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

export function humanizeTool(name: string, args: unknown, skillNames?: Record<string, string>): HumanLine {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  switch (name) {
    case 'todo_write': {
      const todos = Array.isArray(a.todos) ? (a.todos as TurnTodo[]) : []
      const done = todos.filter(t => t?.status === 'done').length
      return todos.length
        ? { pre: '更新任务清单 ', obj: `${done}/${todos.length}`, post: ' 项已完成' }
        : { pre: '整理任务清单' }
    }
    case 'web_search':
      return { pre: '联网检索 ', obj: `“${trunc(str(a.query, '…'), 40)}”` }
    case 'read_page':
      return { pre: '读取网页 ', obj: shortUrl(str(a.url)) }
    case 'python':
      return { pre: '在沙箱里计算' }
    case 'read_file':
      return { pre: '读取文件 ', obj: trunc(str(a.path, '文件'), 40) }
    case 'browse': {
      const act = str(a.action)
      const target = trunc(str(a.target) || str(a.url) || str(a.selector), 36)
      const verbs: Record<string, string> = {
        goto: '打开页面 ', click: '点击 ', type: '填写 ', read: '读取页面内容',
        observe: '查看页面 ', scroll: '翻页查看',
      }
      const pre = verbs[act] || '操作页面 '
      return target ? { pre, obj: target } : { pre: pre.trimEnd() }
    }
    case 'run_skill': {
      // 显示名优先——「执行技能 skill-imp-fcde6655」没人看得懂（实测红线标注）；名录缺失回退 id
      const sid = str(a.skillId, '未指定')
      return { pre: '执行技能 ', obj: trunc(skillNames?.[sid] || sid, 36) }
    }
    case 'search_knowledge':
      return { pre: '查企业知识库 ', obj: `“${trunc(str(a.query, '…'), 30)}”` }
    default: {
      // 未知工具：兜底展示工具名 + 第一个有值的参数，至少让用户知道发生了什么。
      const first = Object.entries(a).find(([, v]) => v !== undefined && v !== null && String(v).trim())
      return first
        ? { pre: `${name} `, obj: trunc(String(first[1]), 40) }
        : { pre: `执行 ${name}` }
    }
  }
}

/** 拼成纯文本（无强调需求的场景，如 tooltip / 日志）。 */
export function humanizeToolText(name: string, args: unknown): string {
  const h = humanizeTool(name, args)
  return `${h.pre}${h.obj || ''}${h.post || ''}`.trim()
}


/**
 * 工具内部流水 → 第一人称拟人短句（执行中气泡的"我正在…"）。
 *
 * 内部日志是给排障看的技术文案（「跳过旧文：《合肥今日天气|大风|雷暴…》页面发布于 2024-08-08，
 * 与询问的时间范围不符」），原样放进气泡又长又冷（实测反馈）。这里按常见模式转写成一句人话；
 * 覆盖不到的模式去掉技术前缀原样展示——转写只做措辞，不改变事实。
 */
export function humanizeStep(raw: string): string {
  const t = (raw || '').split('\n')[0].replace(/^\[[^\]]+\]\s*/, '').trim()
  if (!t) return ''
  let m: RegExpMatchArray | null

  if ((m = t.match(/^跳过旧文[：:]\s*《(.{2,24}?)[|｜》]/))) return `翻到一篇旧文《${m[1]}…》，日期对不上，我先跳过`
  if ((m = t.match(/^正在细读[：:]\s*(.{2,28})/))) return `我正在细读《${trunc(m[1].replace(/^《|》.*$/g, ''), 24)}…》`
  if ((m = t.match(/^已细读[：:]?\s*《(.{2,24})/))) return `刚读完《${trunc(m[1], 22)}…》，继续`
  if ((m = t.match(/搜到\s*(\d+)\s*条结果[，,]?\s*细读成功\s*(\d+)/))) return `搜到 ${m[1]} 条结果，我挑了 ${m[2]} 篇细看`
  if ((m = t.match(/^调研计划[（(](\d+)\s*个子问题[）)]/))) return `我把问题拆成了 ${m[1]} 个角度，开始逐个查`
  if ((m = t.match(/^第(\d+)轮[：:]\s*提炼\s*(\d+)\s*条事实笔记（累计\s*(\d+)/))) return `第 ${m[1]} 轮读完，记下 ${m[2]} 条事实（手上已有 ${m[3]} 条）`
  if (/^素材收敛/.test(t)) return '素材差不多了，我开始动笔写报告'
  if ((m = t.match(/^报告大纲\s*(\d+)\s*节/))) return `大纲定了 ${m[1]} 节，我分节起草中`
  if (/^技能手册较长/.test(t)) return '技能手册有点长，我挑了跟这次任务相关的章节来看'
  if (/^已加载技能手册/.test(t)) return '手册看完了，我在写这次的执行脚本'
  if (/^在 Docker 容器沙箱中执行/.test(t)) return '脚本写好了，我在沙箱里跑它'
  if (/^按上一轮问题修复脚本后重试/.test(t)) return '刚才脚本有个小问题，我改好了再跑一次'
  if (/^正在联网搜/.test(t) || /^正在检索/.test(t)) return `我在联网查资料：${trunc(t.replace(/^正在(联网搜索?|检索)[：:]?/, ''), 26)}`
  if (/^深度调研启动/.test(t)) return '开工，我先把问题拆成检索计划'
  if (/报告已生成并保存/.test(t)) return '报告写完了，正在保存交付'
  return trunc(t, 40)
}
