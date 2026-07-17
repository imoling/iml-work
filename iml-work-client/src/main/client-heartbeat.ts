// 客户端心跳与近实时技能同步：每 30s 向管理端上报节点遥测（沙箱监控用），
// 并按指纹拉取岗位技能集变更（增/删/改/装配变更无需重启/重新领用）。
import { app } from 'electron'
import os from 'os'
import crypto from 'crypto'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { getImCommandCount } from './stats'
import { emitToRenderer } from './window-ref'
import { writeSkillFile, pruneDeletedSkills, loadLocalSkills, skillsOnDiskComplete, syncMineSkills } from './skill-store'

let heartbeatTimer: NodeJS.Timeout | null = null

export function getClientId(): string {
  let id = configGet('clientId')
  if (!id) {
    id = 'node-' + crypto.randomUUID().slice(0, 8)
    configSet('clientId', id)
  }
  return id
}

async function sendHeartbeat() {
  try {
    const body = {
      clientId: getClientId(),
      hostname: os.hostname(),
      expertId: configGet('lastClaimedExpertId') || '',
      expertName: configGet('lastClaimedExpertName') || '',
      sandboxMode: 'backend-docker',      // 本地沙箱已移除；代码执行统一走公司级后端 Docker 沙箱
      // pyodideHealthy 字段兼容 ClientNode；本地沙箱移除后恒 true，沙箱真实状态见管理端「沙箱监控」(/exec/status)
      pyodideHealthy: true,
      imCommandCount: getImCommandCount(),
      appVersion: app.getVersion()
    }
    await afetch(`${getAdminBaseUrl()}/api/v1/clients/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err: any) {
    // Admin backend offline — heartbeat is best-effort.
  }
}

// 近实时技能同步：按指纹拉取当前岗位装配的技能集，变了才重新落盘/清理/重载并通知渲染层。
// 指纹覆盖：技能增/删（下架即脱离岗位→指纹变）、改（updatedAt 变）、装配变更——无需重启/重新领用。
// 同一后端+同一岗位的 404 只报一次（换过后端地址后旧认领必 404，每 30s 刷屏毫无信息量）。
const syncMissing = new Set<string>()
async function syncClaimedSkills() {
  // 认领 id 的优先级：claimed-expert-id（渲染层认领的**权威**单一来源）优先，
  // lastClaimedExpertId 仅作兜底（老版本认领落盘抛异常时只写了它）。
  // 血泪：曾反过来优先兜底键——换后端地址后兜底键存着旧后端的岗位 id（expert-1），
  // 权威键明明是有效认领，同步却拿旧 id 每 30s 404 一次，技能永远不更新。
  let expertId = configGet('claimed-expert-id') || configGet('lastClaimedExpertId')
  if (!expertId) return
  configSet('lastClaimedExpertId', expertId)   // 收敛回单一来源
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}/skills`)
    if (res.status === 404) {
      const key = `${getAdminBaseUrl()}|${expertId}`
      if (!syncMissing.has(key)) {
        syncMissing.add(key)
        console.warn(`[skills:sync] 岗位 ${expertId} 在当前后端不存在（HTTP 404）——多为切换过后端地址、旧认领失效。请在客户端重新认领岗位，认领后自动恢复同步。（本会话对该岗位只提示这一次）`)
      }
      return
    }
    if (!res.ok) { console.error(`[skills:sync] 拉取岗位技能失败 HTTP ${res.status}（expert=${expertId}）——路由将继续用本地旧技能`); return }
    const data: any = await res.json()
    const fp = String(data.fingerprint || '')
    // 指纹相同还要磁盘完整才算"无变化"——绝不让"指纹说没变"掩盖"文件根本不在"
    // （老版本把技能写进打包后只读的 cwd，落盘失败但指纹已存，就是这种烂状态）。
    if (!fp || (fp === (configGet('skillFp:' + expertId) || '') && skillsOnDiskComplete(expertId))) return
    const skills: any[] = Array.isArray(data.skills) ? data.skills : []
    // 单个技能载荷写盘失败不吞掉整轮同步（曾静默中断在中途：boundSkills 写了、文件没落、
    // skillFp 永远设不上——路由匹配不到绑定技能、每 30s 无声重演，排查极难）。
    let wrote = 0, failed = 0
    for (const sk of skills) {
      try { writeSkillFile(sk); wrote++ }
      catch (e: any) { failed++; console.error(`[skills:sync] 技能落盘失败 ${sk && sk.id}: ${e && e.message}`) }
    }
    configSet('boundSkills:' + expertId, JSON.stringify(skills.map(s => String(s.id))))
    try { await pruneDeletedSkills() } catch (e: any) { console.error('[skills:sync] 清理已删技能失败: ' + (e && e.message)) }
    loadLocalSkills()
    if (!failed) configSet('skillFp:' + expertId, fp)   // 有落盘失败则不写指纹，下轮重试
    emitToRenderer('skills:changed', { expertId, skills })
    console.log(`[skills:sync] 岗位技能集同步：落盘 ${wrote}/${skills.length}${failed ? `（失败 ${failed}，下轮重试）` : ''}，已重载（fp=${fp}）`)
  } catch (e: any) { console.error('[skills:sync] 同步异常（管理端离线则下个周期再试）: ' + (e && e.message)) }
}

export function startHeartbeat() {
  void sendHeartbeat()
  void syncClaimedSkills()
  void syncMineSkills()
  heartbeatTimer = setInterval(() => { void sendHeartbeat(); void syncClaimedSkills(); void syncMineSkills() }, 30_000)
}

export function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}
