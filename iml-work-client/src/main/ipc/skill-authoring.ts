// 技能自建/上传 IPC：员工经 skill-creator 引擎创建私有技能（立即本地生效），
// 或上传第三方技能包（后端先审后用）。权限点随登录 user.permissions 下发，
// UI 只做显隐，真正的强制校验在后端（SecurityConfig 按权限点拦截）。
import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { configGet } from '../db'
import { getAdminBaseUrl, afetch } from '../http'
import { writeSkillFile, loadLocalSkills, rememberUserSkill } from '../skill-store'
import { swallow } from '../util'

function myPerms(): string[] {
  try {
    const u = JSON.parse(configGet('auth-user') || '{}')
    return Array.isArray(u.permissions) ? u.permissions : []
  } catch (e) { swallow(e, 'skillauth-perms'); return [] }
}
const hasPerm = (p: string) => { const ps = myPerms(); return ps.includes('*') || ps.includes(p) }

async function postJson(pathname: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; data: any }> {
  const res = await afetch(`${getAdminBaseUrl()}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), timeoutMs
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, data }
}

export function registerSkillAuthoringHandlers(): void {
  ipcMain.handle('skillauth:perms', () => ({
    canCreate: hasPerm('client.skill.create'),
    canUpload: hasPerm('client.skill.upload')
  }))

  // 一句话指令 → 追问选项卡或草稿（生成脚本属长任务，超时放宽）
  ipcMain.handle('skillauth:draft', async (_e, body: { instruction: string; answers?: Record<string, string> }) => {
    try {
      const { ok, data } = await postJson('/api/v1/skills/creator/draft', body || {}, 200_000)
      return ok ? { success: true, ...data } : { success: false, error: (data && data.error) || '生成失败' }
    } catch (err: any) { return { success: false, error: err?.message || String(err) } }
  })

  ipcMain.handle('skillauth:validate', async (_e, draft: unknown) => {
    try {
      const { ok, data } = await postJson('/api/v1/skills/creator/validate', { draft }, 60_000)
      return ok ? { success: true, ...data } : { success: false, error: (data && data.error) || '校验失败' }
    } catch (err: any) { return { success: false, error: err?.message || String(err) } }
  })

  // 保存为私有技能：后端落库（安全闸在后端 create），成功后立即本地落盘生效
  ipcMain.handle('skillauth:save', async (_e, draft: unknown) => {
    try {
      const { ok, data } = await postJson('/api/v1/skills/creator/save', { draft }, 60_000)
      if (!ok) return { success: false, error: (data && data.error) || '保存失败' }
      if (data && data.id) {
        writeSkillFile(data)
        rememberUserSkill(String(data.id))
        loadLocalSkills()
      }
      return { success: true, skill: { id: data?.id, name: data?.name, triggerKeywords: data?.triggerKeywords || [] } }
    } catch (err: any) { return { success: false, error: err?.message || String(err) } }
  })

  // 上传第三方技能包（zip / SKILL.md）：主进程弹系统选择框 → multipart 提交 → 待审核
  ipcMain.handle('skillauth:upload', async () => {
    try {
      const pick = await dialog.showOpenDialog({
        title: '选择技能包（.zip 或 SKILL.md）',
        filters: [{ name: '技能包', extensions: ['zip', 'md'] }],
        properties: ['openFile']
      })
      if (pick.canceled || !pick.filePaths.length) return { success: false, cancelled: true }
      const fp = pick.filePaths[0]
      const form = new FormData()
      form.append('file', new Blob([fs.readFileSync(fp)]), path.basename(fp))
      const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills/submit-package`, {
        method: 'POST', body: form as any, timeoutMs: 120_000
      })
      const data: any = await res.json().catch(() => null)
      if (!res.ok) return { success: false, error: (data && data.error) || `HTTP ${res.status}` }
      return { success: true, ...data }
    } catch (err: any) { return { success: false, error: err?.message || String(err) } }
  })

  // 本人私有技能清单（含上传待审的状态，供技能页展示）
  ipcMain.handle('skillauth:mine', async () => {
    try {
      const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills/mine`)
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
      const list: any = await res.json()
      return { success: true, skills: Array.isArray(list) ? list.map((s: any) => ({
        id: s.id, name: s.name, description: s.description || '', status: s.status || '',
        type: s.type || '', source: s.source || '', triggerKeywords: s.triggerKeywords || [],
        reviewNote: s.reviewNote || ''   // 待审/驳回时给上传者看原因
      })) : [] }
    } catch (err: any) { return { success: false, error: err?.message || String(err) } }
  })
}

