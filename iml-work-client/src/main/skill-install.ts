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
}

function parsePreflight(data: any): Preflight | null {
  const sk = Array.isArray(data?.skills) ? data.skills[0] : null
  if (!sk) return null
  const sec = sk.security || {}
  const items = Array.isArray(sec.findings) ? sec.findings : []
  return {
    name: String(sk.name || ''),
    description: String(sk.description || ''),
    keywords: Array.isArray(sk.keywords) ? sk.keywords.map(String) : [],
    bundleFiles: Array.isArray(sk.bundleFiles) ? sk.bundleFiles.map(String) : [],
    risk: String(sec.risk || 'UNKNOWN'),
    // findings 形状各版本略有差异，取得到什么显示什么——显示不全好过整张卡片渲染不出来
    findings: items.map((f: any) => typeof f === 'string' ? f : String(f?.message || f?.rule || JSON.stringify(f))).slice(0, 8),
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
      const endpoint = manage ? '/import-github' : '/submit-github'
      const landing = manage
        ? '装入企业技能目录（状态 DRAFT），还需在管理台上架并绑定岗位后才会生效'
        : '以你的名义提交，状态「待审核」，管理员审核发布后自动同步到你的客户端才可使用'

      // ── ① 预检：不写库，只把技能信息与安全扫描结论取回来 ──
      ctx.sendLog('acting', `正在检查技能包：${url}`)
      const pre = await postSkills(endpoint, { url, confirm: false })
      if (!pre.ok) {
        const err = pre.data?.error || pre.data?.message || `HTTP ${pre.status}`
        return `技能包检查失败：${err}。请确认这个地址下确实有 SKILL.md（技能目录），或换一个地址重试。绝不要改口告诉用户用 npx / git clone 安装。`
      }
      const info = parsePreflight(pre.data)
      if (!info) return `没能从 ${url} 解析出技能（该目录里可能没有 SKILL.md）。请确认地址指向的是技能目录本身。`
      if (pre.data?.blocked) {
        return `技能「${info.name}」的安全扫描判定为 HIGH 风险，已被阻断安装。发现：${info.findings.join('；') || '（详见管理台安全报告）'}。请如实告知用户被安全闸拦下、未安装，建议交管理员在管理台人工审核。`
      }

      // ── ② 人工签字确认：技能包里可能带可执行脚本，这是必须让人看清楚再点的操作 ──
      ctx.sendLog('acting', `已取到技能信息，等待你在确认卡上核对签字…`)
      const sc = await requestSignedConfirmation([
        { name: '_name', label: '技能名称', value: info.name, type: 'text' },
        { name: '_desc', label: '它能做什么', value: info.description.slice(0, 300), type: 'text' },
        { name: '_src', label: '来源地址（请核对是不是你要的那个）', value: url, type: 'text' },
        { name: '_why', label: '安装理由', value: reason || '（用户在对话中要求安装）', type: 'text' },
        { name: '_kw', label: '触发词（说到这些词会调用它）', value: info.keywords.join('、') || '（无，将由平台自动派生）', type: 'text' },
        { name: '_files', label: '包含文件', value: info.bundleFiles.join('、') || 'SKILL.md', type: 'text' },
        { name: '_sec', label: '安全扫描', value: `${info.risk}${info.findings.length ? ' — ' + info.findings.join('；') : ''}`, type: 'text' },
        { name: '_land', label: '装到哪、什么时候能用', value: landing, type: 'text' },
      ], { actionId: `skill-install:${url}` })

      if (sc.tokenState === 'cancelled') {
        return `用户取消了安装，未做任何写入。请简短确认已取消即可。`
      }
      if (sc.tokenState === 'rejected') {
        return `🚫 安全闸拦截：确认令牌校验未通过（${sc.rejectReason || ''}），未安装。请如实告知用户本次未安装。`
      }

      // ── ③ 真安装 ──
      ctx.sendLog('acting', `确认通过，正在安装「${info.name}」…`)
      const res = await postSkills(endpoint, { url, confirm: true, force: false })
      if (!res.ok || res.data?.success === false) {
        const err = res.data?.error || res.data?.message || `HTTP ${res.status}`
        return `技能「${info.name}」安装失败：${err}。请如实告知用户失败原因，绝不声称已装好。`
      }

      const installedName = Array.isArray(res.data?.skills) && res.data.skills[0]?.name
        ? String(res.data.skills[0].name) : info.name
      ctx.sendLog('completed', `技能「${installedName}」已安装（${manage ? '企业目录 DRAFT' : '待审核'}）`)
      // 让「技能」页立刻看到这条新记录（它只在挂载时拉一次，不发事件就得关掉重开才出现）
      emitToRenderer('skills:changed', { reason: 'installed' })
      return [
        `技能「${installedName}」已成功提交到平台。`,
        `落点：${landing}。`,
        `安全扫描结论：${info.risk}。触发词：${info.keywords.join('、') || '（平台已自动派生）'}。`,
        '',
        '请如实告诉用户：**现在还不能直接用**，要等' + (manage ? '在管理台上架并绑定岗位' : '管理员审核通过') + '之后才会生效。',
        '不要让用户去执行 npx / git clone，也不要声称技能已经可以调用了。',
      ].join('\n')
    },
  }
}
