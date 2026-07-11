// 产物登记索引：任务(会话) → 产物文件 的单一事实来源（表 task_files，按账号库隔离）。
// 治「平铺工作空间四职混用」：目录只管物理存放，出处/分组/@引用/KB 排除一律走本索引。
// SQL 在 db.ts（域函数模式）；本模块做 fs/会话上下文组合。叶子模块，绝不 import workspace-files。
import fs from 'fs'
import path from 'path'
import { artifactInsert, artifactDistinctNames, artifactRecentByConv, artifactListJoined } from './db'
import { currentRun } from './automation-runtime'
import { swallow } from './util'

export interface ArtifactEntry {
  name: string
  absPath: string
  sizeBytes: number
  source: string          // 产出来源（技能名），空=未知
  convId: string
  createdAt: number       // unixepoch 秒
  exists: boolean         // 物理文件是否还在（被用户删了则 false，仅影响展示）
}

export interface ArtifactGroup {
  convId: string
  title: string           // 会话标题；孤儿产物归「其他产物」
  latestAt: number
  files: ArtifactEntry[]
}

/** 重名防覆盖：目录里已有同名文件 → “name (2).ext”“name (3).ext”…（与产物或用户文件撞名都躲）。 */
export function uniqueArtifactName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/** 登记一条产物。会话 ID 从当前 RunContext 隐式获取（runId ≡ convId），登记失败只记日志不阻断落盘。 */
export function registerArtifact(e: { name: string; absPath: string; sizeBytes: number; source?: string }): void {
  try {
    artifactInsert(currentRun()?.runId || '', e.name, e.absPath, e.sizeBytes, e.source || '')
  } catch (err) { swallow(err, 'artifact-register') }
}

/** 全部已登记产物文件名（供 KB 自动摄取排除、资料库视图分类）。 */
export function artifactNameSet(): Set<string> {
  try { return new Set(artifactDistinctNames()) }
  catch (err) { swallow(err, 'artifact-names'); return new Set() }
}

/** 某会话最近的产物（供“刚才那份”迭代指代的精确解析，替代整目录 mtime 猜测）。 */
export function recentConvArtifacts(convId: string, limit = 3): { name: string; absPath: string }[] {
  if (!convId) return []
  try { return artifactRecentByConv(convId, limit).map(r => ({ name: r.name, absPath: r.abs_path })) }
  catch (err) { swallow(err, 'artifact-recent'); return [] }
}

/** 按任务分组的产物清单（新任务在前），供个人空间「任务成果」视图与 @ 引用菜单。 */
export function listArtifactGroups(maxFiles = 500): ArtifactGroup[] {
  try {
    const groups = new Map<string, ArtifactGroup>()
    for (const r of artifactListJoined(maxFiles)) {
      const key = r.conv_id || '__orphan__'
      let g = groups.get(key)
      if (!g) {
        g = { convId: r.conv_id, title: r.title || (r.conv_id ? '（会话已删除）' : '其他产物'), latestAt: r.created_at, files: [] }
        groups.set(key, g)
      }
      g.files.push({
        name: r.name, absPath: r.abs_path, sizeBytes: r.size_bytes, source: r.source,
        convId: r.conv_id, createdAt: r.created_at, exists: fs.existsSync(r.abs_path)
      })
    }
    return [...groups.values()]
  } catch (err) { swallow(err, 'artifact-groups'); return [] }
}
