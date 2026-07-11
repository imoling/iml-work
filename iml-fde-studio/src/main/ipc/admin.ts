// 后端代理 + 管理端对接：React 端所有 /api/v1/** 走 fde:api（规避 CORS）；技能上架 / SOP 生成 / 系统清单。
import { ipcMain } from 'electron'
import { stepsToReadable } from '../automation'

export function register(): void {
  // ===== 通用后端代理（React 端所有 /api/v1/** 调用走这里，规避 CORS、复用主进程网络）=====
  ipcMain.handle('fde:api', async (_e, { baseUrl, method, path: p, body, token }: any) => {
    try {
      const url = (baseUrl || process.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080').replace(/\/$/, '') + p
      // 模型推理端点用服务间共享密钥（网关会把非 corp 的 Bearer 当作上游 provider key 转发）；
      // 其余业务端点用登录用户 token（缺失回退共享密钥）。
      const isModelChat = (p || '').startsWith('/api/v1/model/chat')
      const authz = isModelChat ? 'Bearer sk-corp-default-key' : (token ? `Bearer ${token}` : 'Bearer sk-corp-default-key')
      const res = await fetch(url, {
        method: method || 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': authz, 'X-Client': 'fde' },
        body: body != null ? JSON.stringify(body) : undefined
      })
      const text = await res.text()
      let data: any; try { data = text ? JSON.parse(text) : null } catch (_) { data = text }
      return { ok: res.ok, status: res.status, data }
    } catch (e: any) { return { ok: false, status: 0, error: e.message } }
  })

  // ===== 管理端对接 =====
  ipcMain.handle('admin:systems', async (_e, { adminBaseUrl }: any) => {
    try {
      const base = (adminBaseUrl || '').replace(/\/$/, '')
      const res = await fetch(`${base}/api/v1/integrations`)
      if (!res.ok) return { ok: false, systems: [], error: `HTTP ${res.status}` }
      const list: any = await res.json()
      const systems = (Array.isArray(list) ? list : []).map((s: any) => ({ id: s.id, type: s.type, name: s.name, baseUrl: s.baseUrl }))
      return { ok: true, systems }
    } catch (e: any) { return { ok: false, systems: [], error: e.message } }
  })

  // 上传技能：rich steps(带指纹) + 可读脚本 + SOP；后端原样存。仅含步骤/指纹，绝不含登录态。
  ipcMain.handle('admin:save-skill', async (_e, { adminBaseUrl, name, triggerKeywords, targetSystemId, steps, fields, engine, script, sop }: any) => {
    try {
      const base = (adminBaseUrl || '').replace(/\/$/, '')
      const body = {
        name, triggerKeywords: triggerKeywords || [], targetSystemId: targetSystemId || '',
        steps: steps || [], fields: fields || [], engine: engine || 'browser',
        script: script || (engine === 'desktop' ? '' : stepsToReadable(steps || [])), sop: sop || ''
      }
      const res = await fetch(`${base}/api/v1/skills/from-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, skill: await res.json() }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  // 试运行阶段：根据脚本生成 SOP（经管理端模型中转站），供 FDE 编辑后随技能同步。
  ipcMain.handle('skill:gen-sop', async (_e, { adminBaseUrl, name, script, fields, engine }: any) => {
    try {
      const base = (adminBaseUrl || '').replace(/\/$/, '')
      const res = await fetch(`${base}/api/v1/skills/gen-sop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, script: script || '', fields: fields || [], engine: engine || 'browser' })
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      const d: any = await res.json()
      return { ok: true, sop: d.sop || '' }
    } catch (e: any) { return { ok: false, error: e.message } }
  })
}
