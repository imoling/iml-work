// 对话里安装技能：「帮我装个 humanizer-zh」→ 预检 → 人工签字确认 → 按权限落库。
//
// 为什么做成**工具**而不是技能：安装是内核在回答过程中要执行的动作，需要工具注册表的确认闸
// （metadata.requiresApproval）；做成技能反而要先过关键词/意图路由，还绕不开确认。
//
// 为什么不自己实现下载解析：后端 /skills/import-github 已经是一条完整且安全的管线——
// 域名白名单防 SSRF、静态安全扫描、触发词自动派生、bundle 落库。客户端只做「问清楚 + 让人签字」，
// 绝不另起一条绕过治理的安装路径。
//
// 治理规则不因入口而变（2026-08-02 拍板）：
//   · 有技能管理权 → /skills/import-github，进企业目录 DRAFT，仍需管理员上架 + 绑岗位
//   · 只有 client.skill.upload → /skills/submit-github，owner=本人、PENDING_REVIEW，先审后用
//   · 两者皆无 → 如实告知无权限，不做任何写入
// 两条路径**都不会让技能立刻可用**，工具回执必须把这点说清楚，否则用户以为装完就能喊。
import { afetch, getAdminBaseUrl } from './http'
import { hasPerm } from './perms'
import { requestSignedConfirmation } from './confirm-token'
import { emitToRenderer } from './window-ref'
import type { ToolSpec } from './tool-registry'

// 权限点字面量必须与后端 Permissions.java 一致——写错不会报错，只会**永远判成没权限**，
// 然后所有人都被推去走员工待审路径（管理员也是），静默降级到没人会发现。
const PERM_MANAGE = 'admin.skill.manage'   // Permissions.SKILL_MANAGE
const PERM_UPLOAD = 'client.skill.upload'  // Permissions.CLIENT_SKILL_UPLOAD

/** 后端接受的技能来源域名（与 SkillPackageService 的白名单一致，这里只是提前给用户一个明确的错）。 */
const ALLOWED_HOSTS = /^(github\.com|raw\.githubusercontent\.com|gist\.github\.com|gist\.githubusercontent\.com|api\.github\.com)$/i

interface Preflight {
  name: string
  description: string
  keywords: string[]
  bundleFiles: string[]
  risk: string
  findings: string[]
  /** 聚合摘要（确认卡展示用）：档位 + 按严重度/类型计数，不逐条平铺重复发现。 */
  findingsSummary: string
  /** 风险明细（逐行）：类型×次数 + 证据样本 + 涉及文件数。 */
  findingsDetail: string
  /** 语义复审意见（网关模型读代码后的行为判定），后端静态拿不准时才有。 */
  semantic: string
  /** 信任盖章：同哈希包已被管理员发布过 / 来源在企业白名单。 */
  trusted: boolean
}

const SEV_LABEL: Record<string, string> = { HIGH: '高危', REVIEW: '需人工判读', MEDIUM: '中危', LOW: '低危' }

/**
 * 把逐条发现聚合成人能读的一行摘要。
 * 原始展示是「LOW·辅助脚本执行原语（process.env）；LOW·辅助脚本执行原语（import()）；…」——
 * 同类发现逐条平铺，一行输入框里全是重复词，用户根本读不出重点（实测反馈 2026-08-13）。
 * 聚合成「中危 · 低危 12 项（辅助脚本执行原语×12）；中危 2 项（包管理器安装、混淆/编码规避）」。
 */
function summarizeFindings(risk: string, items: any[]): string {
  const riskLabel = SEV_LABEL[risk] ? `${SEV_LABEL[risk]}（${risk}）` : risk
  if (!items.length) return risk === 'SAFE' ? '未发现风险项' : riskLabel
  const bySev = new Map<string, Map<string, number>>()
  for (const f of items) {
    const sev = String(f?.severity || '其他')
    const type = String(f?.type || f?.rule || f?.message || '其他')
    if (!bySev.has(sev)) bySev.set(sev, new Map())
    const m = bySev.get(sev)!
    m.set(type, (m.get(type) || 0) + 1)
  }
  const order = ['HIGH', 'REVIEW', 'MEDIUM', 'LOW']
  const parts: string[] = []
  for (const sev of [...order, ...[...bySev.keys()].filter(s => !order.includes(s))]) {
    const m = bySev.get(sev)
    if (!m) continue
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    const types = [...m.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join('、')
    parts.push(`${SEV_LABEL[sev] || sev} ${total} 项（${types}）`)
  }
  return `${riskLabel} · ${parts.join('；')}`
}

/**
 * 包含文件概览：目录级计数替代全量路径平铺。
 * Impeccable 这类包 60+ 条路径把整张卡刷满，真正要人核对的扫描结论反而被挤成一行
 * （实测反馈 2026-08-13）——文件清单给量级与分布就够，逐条明细管理台里有。
 */
function summarizeBundleFiles(files: string[]): string {
  if (!files.length) return 'SKILL.md'
  if (files.length <= 8) return files.join('、')
  const byDir = new Map<string, number>()
  for (const f of files) {
    const i = f.indexOf('/')
    byDir.set(i > 0 ? f.slice(0, i) + '/' : '根目录', (byDir.get(i > 0 ? f.slice(0, i) + '/' : '根目录') || 0) + 1)
  }
  const parts = [...byDir.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n} 个`)
  const roots = files.filter(f => !f.includes('/')).slice(0, 3)
  return `共 ${files.length} 个文件：${parts.join('、')}${roots.length ? `（含 ${roots.join('、')}）` : ''}`
}

/**
 * 风险明细（逐行）：每档列「类型×次数 + 命中证据样本 + 涉及文件数」。
 * 比单行结论多一层可判读的细节，但仍是聚合——不回到逐条平铺刷屏的老路。
 */
function findingsDetail(items: any[]): string {
  if (!items.length) return ''
  type G = { n: number; evs: Set<string>; files: Set<string> }
  const groups = new Map<string, Map<string, G>>()
  for (const f of items) {
    const sev = String(f?.severity || '其他')
    const type = String(f?.type || '其他')
    if (!groups.has(sev)) groups.set(sev, new Map())
    const m = groups.get(sev)!
    if (!m.has(type)) m.set(type, { n: 0, evs: new Set(), files: new Set() })
    const g = m.get(type)!
    g.n++
    if (f?.evidence) g.evs.add(String(f.evidence).slice(0, 30))
    const fm = /(?:脚本|文件|文档)\s+(\S+?)\s/.exec(String(f?.detail || ''))
    if (fm) g.files.add(fm[1])
  }
  const order = ['HIGH', 'REVIEW', 'MEDIUM', 'LOW']
  const lines: string[] = []
  for (const sev of [...order, ...[...groups.keys()].filter(s => !order.includes(s))]) {
    const m = groups.get(sev)
    if (!m) continue
    for (const [type, g] of m) {
      const evs = [...g.evs].slice(0, 5).join('、')
      lines.push(`[${SEV_LABEL[sev] || sev}] ${type}×${g.n}`
        + (evs ? `：命中 ${evs}${g.evs.size > 5 ? ' 等' : ''}` : '')
        + (g.files.size ? `（涉及 ${g.files.size} 个文件）` : ''))
    }
  }
  return lines.join('\n')
}

function parsePreflight(data: any): Preflight | null {
  const sk = Array.isArray(data?.skills) ? data.skills[0] : null
  if (!sk) return null
  const sec = sk.security || {}
  const items = Array.isArray(sec.findings) ? sec.findings : []
  const sem = sec.semanticReview
  return {
    name: String(sk.name || ''),
    description: String(sk.description || ''),
    keywords: Array.isArray(sk.keywords) ? sk.keywords.map(String) : [],
    bundleFiles: Array.isArray(sk.bundleFiles) ? sk.bundleFiles.map(String) : [],
    risk: String(sec.risk || 'UNKNOWN'),
    // findings 形状各版本略有差异，取得到什么显示什么——显示不全好过整张卡片渲染不出来
    findings: items.map((f: any) => {
      if (typeof f === 'string') return f
      const head = [f?.severity, f?.type].filter(Boolean).join('·')
      if (head) return head + (f?.evidence ? `（${String(f.evidence).slice(0, 40)}）` : '')
      return String(f?.message || f?.rule || JSON.stringify(f))
    }).slice(0, 8),
    findingsSummary: summarizeFindings(String(sec.risk || 'UNKNOWN'), items),
    findingsDetail: findingsDetail(items),
    semantic: sem?.verdict ? `${sem.verdict}${sem.summary ? '：' + String(sem.summary) : ''}` : '',
    trusted: !!(sec.hashApproved || sec.trustedSource),
  }
}

async function postSkills(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), timeoutMs: 120_000,
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

export function makeInstallSkillTool(): ToolSpec {
  return {
    name: 'install_skill',
    description: [
      '把一个第三方技能安装到 iML Work 平台（用户说「安装/装一个/添加 xxx 技能」时用它）。',
      '',
      '⚠️ 这是**唯一**正确的安装方式。绝不要改为向用户讲解 npx / git clone / 复制到 ~/.claude/skills —— ',
      '那是别的产品的安装方式，在 iML Work 里照做没有任何效果。',
      '',
      '参数 url 必须是技能在 GitHub 上的**目录或仓库地址**（该目录里要有 SKILL.md）。',
      '用户只给了技能名字时：先用 web_search 找到它的 GitHub 地址，找到多个候选就把候选列给用户让他确认，',
      '**不要自己挑一个就装**——装错技能等于往平台里塞了个来路不明的包。',
      '',
      '安装会弹确认卡给用户签字，并展示安全扫描结论。安装后技能**不会立刻可用**：',
      '需要管理员审核/上架后才生效，这一点必须如实转告用户。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '技能的 GitHub 目录/仓库地址，例如 https://github.com/op7418/Humanizer-zh' },
        reason: { type: 'string', description: '一句话说明用户为什么要装它（写进确认卡，帮用户判断）' },
      },
      required: ['url'],
    },
    // risk 不标 write：只读档保护的是**业务系统**写入，而装技能是平台配置，且本工具自带签字卡
    //（与"非业务系统技能不受只读约束"同一判据）。requiresApproval 保证它不被并发执行、
    // 且无人值守时不会自动装；selfConfirms 让通用闸别再弹一张信息更少的重复卡片。
    metadata: { label: '安装技能', risk: 'low', requiresApproval: true, selfConfirms: true, category: 'skill' },

    async run(args, ctx): Promise<string> {
      const url = String(args.url || '').trim()
      const reason = String(args.reason || '').trim()
      if (!url) return '未提供技能地址。请先确认要装哪个技能、它的 GitHub 地址是什么，再调用本工具。'

      let host = ''
      try { host = new URL(url).host } catch { return `"${url}" 不是合法的网址。需要技能在 GitHub 上的目录地址。` }
      if (!ALLOWED_HOSTS.test(host)) {
        return `平台只接受来自 GitHub 的技能包（当前地址在 ${host}）。这是防 SSRF 的域名白名单，不能绕过。请提供该技能在 GitHub 上的地址。`
      }

      // 权限决定落点（见文件头治理规则）。先判是为了不让用户白签一遍字才吃 403。
      const manage = hasPerm(PERM_MANAGE)
      const upload = hasPerm(PERM_UPLOAD)
      if (!manage && !upload) {
        return '你的账号没有安装技能的权限（需要「客户端技能上传」或「技能管理」授权）。请联系管理员开通，或请管理员在管理台的技能中心直接安装。'
      }
      // 对话里装的技能**一律先审后用**（review:true → 落「待审核」进审批流）：
      // 曾让 manage 权限走 DRAFT——结果管理台里只是一条无人认领的草稿、审批流里根本看不见，
      // 装的人还以为提交了审核（实测反馈 2026-08-13）。管理台里直接装的才是 DRAFT。
      const endpoint = manage ? '/import-github' : '/submit-github'
      const landing = manage
        ? '以你的名义提交为「待审核」——你有技能管理权限，可在管理台「待审核」里自行通过或退回；发布后自动同步，客户端「技能页·我的技能」可跟踪状态'
        : '以你的名义提交，状态「待审核」，管理员审核发布后自动同步到你的客户端才可使用；「技能页·我的技能」可跟踪状态'

      // ── ① 预检：不写库，只把技能信息与安全扫描结论取回来 ──
      ctx.sendLog('acting', `正在检查技能包：${url}`)
      const pre = await postSkills(endpoint, { url, confirm: false, review: true })
      if (!pre.ok) {
        const err = pre.data?.error || pre.data?.message || `HTTP ${pre.status}`
        return `技能包检查失败：${err}。请确认这个地址下确实有 SKILL.md（技能目录），或换一个地址重试。绝不要改口告诉用户用 npx / git clone 安装。`
      }
      const info = parsePreflight(pre.data)
      if (!info) return `没能从 ${url} 解析出技能（该目录里可能没有 SKILL.md）。请确认地址指向的是技能目录本身。`

      // HIGH/组合信号不再是死路：把「接受风险安装」直接摆上签字卡（与管理台同一 force 语义）。
      // 员工通道（submit-github）后端恒 force 落库隔离，blocked 到不了这里；能走到这个分支的是
      // 技能管理权限账号——他本人就是有权接受风险的人，没必要把他支去管理台再点一遍。
      const needsForce = !!(pre.data?.blocked || pre.data?.reviewRequired)
      const forceNote = pre.data?.blocked
        ? '⚠️ 安全扫描 HIGH，默认阻断。签字确认即「接受风险安装」（等同管理台同名操作），装入后仍需上架/审核才生效'
        : '⚠️ 静态扫描拿不准（组合信号/企业策略），签字确认即接受风险安装，装入后仍需上架/审核才生效'

      // ── ② 人工签字确认:技能包里可能带可执行脚本，这是必须让人看清楚再点的操作 ──
      // 全部字段只读（核对信息，不是要用户填）；标题/按钮换成安装语境——
      // 复用默认的「业务系统表单参数确认/提交至企业系统」会让人完全看不懂这一步在干嘛（实测反馈）。
      ctx.sendLog('acting', needsForce ? '安全扫描有风险发现，等待你决定是否接受风险安装…' : '已取到技能信息，等待你在确认卡上核对签字…')
      const ro = { type: 'text', readonly: true } as const
      const sc = await requestSignedConfirmation([
        { name: '_name', label: '技能名称', value: info.name, ...ro },
        { name: '_desc', label: '它能做什么', value: info.description.slice(0, 300), ...ro },
        { name: '_src', label: '来源地址（请核对是不是你要的那个）', value: url, ...ro },
        { name: '_why', label: '安装理由', value: reason || '（用户在对话中要求安装）', ...ro },
        { name: '_kw', label: '触发词（说到这些词会调用它）', value: info.keywords.join('、') || '（无，将由平台自动派生）', ...ro },
        { name: '_files', label: '包含文件（概览，明细见管理台）', value: summarizeBundleFiles(info.bundleFiles), ...ro },
        { name: '_sec', label: '安全扫描结论', value: `${info.findingsSummary}${info.trusted ? '（企业已信任：同哈希已审/来源白名单）' : ''}`, ...ro },
        ...(info.findingsDetail ? [{ name: '_secDetail', label: '风险明细', value: info.findingsDetail, ...ro }] : []),
        ...(info.semantic ? [{ name: '_sem', label: '模型语义复审（读代码判行为）', value: info.semantic, ...ro }] : []),
        ...(needsForce ? [{ name: '_force', label: '这一步意味着什么', value: forceNote, ...ro }] : []),
        { name: '_land', label: '装到哪、什么时候能用', value: landing, ...ro },
      ], { actionId: `skill-install${needsForce ? '-force' : ''}:${url}` }, {
        title: needsForce ? '安装技能 · 接受风险确认' : '安装技能 · 人工确认',
        submitLabel: needsForce ? '接受风险并安装' : '确认安装',
      })

      if (sc.tokenState === 'cancelled') {
        return `用户取消了安装，未做任何写入。请简短确认已取消即可。`
      }
      if (sc.tokenState === 'rejected') {
        return `🚫 安全闸拦截：确认令牌校验未通过（${sc.rejectReason || ''}），未安装。请如实告知用户本次未安装。`
      }

      // ── ③ 真安装（needsForce=接受风险安装；正常包 force=false 语义不变）──
      ctx.sendLog('acting', `确认通过，正在安装「${info.name}」…`)
      const res = await postSkills(endpoint, { url, confirm: true, force: needsForce, review: true })
      if (!res.ok || res.data?.success === false) {
        const err = res.data?.error || res.data?.message || `HTTP ${res.status}`
        return `技能「${info.name}」安装失败：${err}。请如实告知用户失败原因，绝不声称已装好。`
      }

      const installedName = Array.isArray(res.data?.skills) && res.data.skills[0]?.name
        ? String(res.data.skills[0].name) : info.name
      ctx.sendLog('completed', `技能「${installedName}」已提交（待审核）`)
      // 让「技能」页立刻看到这条新记录（它只在挂载时拉一次，不发事件就得关掉重开才出现）
      emitToRenderer('skills:changed', { reason: 'installed' })
      return [
        `技能「${installedName}」已成功提交到平台。`,
        `落点：${landing}。`,
        `安全扫描结论：${info.risk}。触发词：${info.keywords.join('、') || '（平台已自动派生）'}。`,
        '',
        '请如实告诉用户：**现在还不能直接用**，要等管理员在管理台「待审核」里通过之后才会生效' + (manage ? '（用户自己有技能管理权限，可去管理台自行通过）' : '') + '。',
        '可以顺带告诉用户：在客户端「技能」页的「我的技能」里能看到这条记录和它的审批状态（待管理员审核），审核发布后会自动变为已生效。',
        '不要让用户去执行 npx / git clone，也不要声称技能已经可以调用了。',
      ].join('\n')
    },
  }
}
