// 客户端心跳与近实时技能同步：每 30s 向管理端上报节点遥测（沙箱监控用），
// 并按指纹拉取岗位技能集变更（增/删/改/装配变更无需重启/重新领用）。
import { app } from 'electron'
import os from 'os'
import crypto from 'crypto'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { getImCommandCount } from './stats'
import { emitToRenderer } from './window-ref'
import { writeSkillFile, pruneDeletedSkills, loadLocalSkills } from './skill-store'

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
async function syncClaimedSkills() {
  const expertId = configGet('lastClaimedExpertId')
  if (!expertId) return
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}/skills`)
    if (!res.ok) return
    const data: any = await res.json()
    const fp = String(data.fingerprint || '')
    if (!fp || fp === (configGet('skillFp:' + expertId) || '')) return   // 无变化
    const skills: any[] = Array.isArray(data.skills) ? data.skills : []
    for (const sk of skills) writeSkillFile(sk)
    configSet('boundSkills:' + expertId, JSON.stringify(skills.map(s => String(s.id))))
    await pruneDeletedSkills()
    loadLocalSkills()
    configSet('skillFp:' + expertId, fp)
    emitToRenderer('skills:changed', { expertId, skills })
    console.log(`[skills:sync] 岗位技能集变更，已同步 ${skills.length} 项并重载（fp=${fp}）`)
  } catch (_) { /* 管理端离线 → 下个周期再试 */ }
}

export function startHeartbeat() {
  void sendHeartbeat()
  void syncClaimedSkills()
  heartbeatTimer = setInterval(() => { void sendHeartbeat(); void syncClaimedSkills() }, 30_000)
}

export function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}
