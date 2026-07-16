// 技能本地缓存：SKILL.md 落盘/加载/清理与展示名映射。技能的单一来源是管理端
// （配置→认领下发→本地落盘），客户端不自造预置。共享状态（已加载技能、展示名映射）
// 封装在本模块内，外部经 getLoadedSkills()/skillLabel() 访问。
import path from 'path'
import { appDataRoot } from './app-paths'
import fs from 'fs'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { swallow } from './util'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  triggerKeywords: string[]
  allowedRoles: string[]
  sopContent: string
}

let loadedSkills: SkillDefinition[] = []

/** 当前已加载的技能目录（loadLocalSkills 后有效）。返回内部数组引用，调用方勿修改。 */
export function getLoadedSkills(): SkillDefinition[] {
  return loadedSkills
}

// 技能「展示名」映射（id → 管理端维护的人类可读名称）。本地 SKILL.md 的 `name:` 是 slug(=id)，
// 真正的展示名在管理端，需异步拉取后缓存。用于在用户可见文案里展示「名称（编号）」。
const skillNameMap = new Map<string, string>()

export function skillLabel(s: { id: string; name?: string } | null | undefined): string {
  if (!s) return ''
  const disp = skillNameMap.get(s.id) || (s.name && s.name !== s.id ? s.name : '')
  return disp ? `${disp}（${s.id}）` : s.id
}

/** 读取技能展示名（未缓存返回 undefined，调用方自带回退）。 */
export function skillDisplayName(id: string): string | undefined {
  return skillNameMap.get(id)
}

/** 缓存技能展示名（认领同步/详情拉取时调用）。 */
export function setSkillDisplayName(id: string, name: string): void {
  skillNameMap.set(id, name)
}

export function loadLocalSkills() {
  const projectRoot = appDataRoot()
  const skillsDir = path.join(projectRoot, 'skills')

  console.log(`[Skills Loader] Loading skills from directory: ${skillsDir}`)

  try {
    const subdirs = fs.readdirSync(skillsDir)
    const newSkills: SkillDefinition[] = []

    for (const subdir of subdirs) {
      const subdirPath = path.join(skillsDir, subdir)
      if (!fs.statSync(subdirPath).isDirectory()) continue

      const skillMdPath = path.join(subdirPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      const content = fs.readFileSync(skillMdPath, 'utf-8')

      const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/
      const match = frontmatterRegex.exec(content)

      let name = subdir
      let description = `Local skill from ${subdir}`
      let triggerKeywords: string[] = []
      let allowedRoles: string[] = []
      let sopContent = content

      if (match) {
        const yamlText = match[1]
        sopContent = content.substring(match[0].length).trim()

        const lines = yamlText.split('\n')
        let currentKey = ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith('-')) {
            if (currentKey === 'trigger_keywords') {
              const val = trimmed.replace(/^-/, '').trim().replace(/^['"]|['"]$/g, '')
              // 触发词可能被错误地存成「A，B、C」长串（录制转技能时未拆分），统一按分隔符拆开，
              // 否则纯子串匹配永远命中不了整串，导致对话框调不出技能。
              if (val) for (const part of val.split(/[，,、；;\s]+/)) { const k = part.trim().toLowerCase(); if (k) triggerKeywords.push(k) }
            } else if (currentKey === 'allowed_roles') {
              const val = trimmed.replace(/^-/, '').trim().replace(/^['"]|['"]$/g, '')
              if (val) allowedRoles.push(val)
            }
          } else if (trimmed.includes(':')) {
            const separatorIndex = trimmed.indexOf(':')
            const key = trimmed.substring(0, separatorIndex).trim()
            let val = trimmed.substring(separatorIndex + 1).trim()

            val = val.replace(/^['"]|['"]$/g, '')

            if (key === 'name') {
              name = val
            } else if (key === 'description') {
              description = val
            } else if (key === 'trigger_keywords') {
              currentKey = 'trigger_keywords'
            } else if (key === 'allowed_roles') {
              if (val.startsWith('[') && val.endsWith(']')) {
                allowedRoles = val.substring(1, val.length - 1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''))
              } else if (val) {
                allowedRoles.push(val)
              }
              currentKey = 'allowed_roles'
            } else {
              currentKey = ''
            }
          }
        }
      }

      console.log(`[Skills Loader] Loaded skill "${name}" (Keywords: ${triggerKeywords.join(', ')} | Roles: ${allowedRoles.join(', ') || 'all'})`)
      newSkills.push({
        id: subdir,
        name,
        description,
        triggerKeywords,
        allowedRoles,
        sopContent
      })
    }

    loadedSkills = newSkills
  } catch (err: any) {
    console.error(`[Skills Loader] Failed to load local skills:`, err.message)
  }
}

// 清理本地已被管理端删除的技能：以管理端技能全集为准，删掉本地多余的技能目录。
// 仅在成功取到管理端清单时执行（避免离线时误删全部）。返回清理数量。
export async function pruneDeletedSkills(): Promise<number> {
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills`)
    if (!res.ok) return 0
    const list: any = await res.json()
    if (!Array.isArray(list)) return 0
    // 顺带缓存技能展示名（id → name），供后续文案展示「名称（编号）」
    list.forEach((s: any) => { if (s && s.id && s.name) skillNameMap.set(String(s.id), String(s.name)) })
    const keep = new Set(list.map((s: any) => String(s.id)))
    const skillsDir = path.join(appDataRoot(), 'skills')
    if (!fs.existsSync(skillsDir)) return 0
    let removed = 0
    for (const sub of fs.readdirSync(skillsDir)) {
      const dir = path.join(skillsDir, sub)
      try { if (!fs.statSync(dir).isDirectory()) continue } catch (_) { continue }
      if (!keep.has(sub)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); removed++; console.log(`[Skills Loader] 清理已删除技能：${sub}`) } catch (e) { swallow(e) }
      }
    }
    return removed
  } catch (_) { return 0 }
}

/** 已装配技能是否都真实在磁盘上：boundSkills 里每个 id 都有 skills/<id>/SKILL.md。
 *  没有装配记录也算"不完整"——技能同步不能只信指纹，必须以磁盘为准（老版本把技能写进
 *  打包后只读的 cwd，文件根本不在，指纹却可能说"没变化"）。 */
export function skillsOnDiskComplete(expertId: string): boolean {
  try {
    const raw = configGet('boundSkills:' + expertId)
    const ids: string[] = raw ? JSON.parse(raw) : []
    if (!ids.length) return false
    return ids.every(id => fs.existsSync(path.join(appDataRoot(), 'skills', String(id), 'SKILL.md')))
  } catch (e) { swallow(e, 'skills-on-disk'); return false }
}

/** 管理端下发的技能载荷（认领/近实时同步时落盘用的最小面）。 */
export interface SkillSyncPayload {
  id?: string; name?: string; description?: string
  triggerKeywords?: string[]; allowedRoles?: string[]; sopContent?: string
}

export function writeSkillFile(skill: SkillSyncPayload) {
  const projectRoot = appDataRoot()
  // The skill's stable identifier (matches the directory name); the SKILL.md
  // `name:` frontmatter is this slug, NOT the display name.
  const skillId = skill.id || skill.name
  if (!skillId) { console.warn('[Skills Sync] 跳过无 id/name 的技能载荷'); return }   // 以前会 path.join(undefined) 直接抛异常
  const skillDir = path.join(projectRoot, 'skills', skillId)
  const skillMd = path.join(skillDir, 'SKILL.md')

  // Physical skills already on disk are the source of truth — never clobber
  // them on claim. This stops the backend's display name from overwriting the
  // preset SKILL.md slug (`name: web-screenshot` → `name: 网页截图`) every sync.
  if (fs.existsSync(skillMd)) {
    return
  }
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true })
  }

  const yamlHeader = [
    '---',
    `name: ${skillId}`,
    `description: ${skill.description || ''}`,
    'trigger_keywords:',
    ...(skill.triggerKeywords || []).map((kw: string) => `  - ${kw}`),
    'allowed_roles:',
    ...(skill.allowedRoles || []).map((role: string) => `  - ${role}`),
    '---',
    '',
    ''
  ].join('\n')

  fs.writeFileSync(skillMd, yamlHeader + (skill.sopContent || ''), 'utf-8')
  console.log(`[Skills Sync] Seeded new physical skill file: ${skillMd}`)
}

/** 记私有技能 id 集（skill-orchestrator 路由范围会并入它，岗位装配变更不覆盖）。 */
export function rememberUserSkill(id: string): void {
  try {
    const ids: string[] = JSON.parse(configGet('userSkills') || '[]')
    if (!ids.includes(id)) { ids.push(id); configSet('userSkills', JSON.stringify(ids)) }
  } catch (e) { swallow(e, 'remember-user-skill') }
}

/** 同步本人私有技能（skill-creator 自建）：/skills/mine 里 PUBLISHED 的落盘生效，
 *  id 集记入 userSkills（路由范围并入它）——换机重装自动带回来。心跳周期调用。 */
export async function syncMineSkills(): Promise<void> {
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills/mine`)
    if (!res.ok) return
    const list: any = await res.json()
    if (!Array.isArray(list)) return
    const ids: string[] = []
    for (const s of list) {
      if (!s || !s.id || s.status !== 'PUBLISHED') continue
      writeSkillFile(s)
      ids.push(String(s.id))
    }
    const prev = configGet('userSkills') || '[]'
    const next = JSON.stringify(ids)
    if (prev !== next) { configSet('userSkills', next); loadLocalSkills() }
  } catch (e) { swallow(e, 'sync-mine-skills') }
}

/** 启动初始化：先加载本地技能，再异步以管理端为准清理已删技能并重载（不阻塞启动）。 */
export function initSkillStore(): void {
  loadLocalSkills()
  pruneDeletedSkills().then(n => { if (n > 0) loadLocalSkills() })
}
