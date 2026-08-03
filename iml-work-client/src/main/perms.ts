// 当前登录用户的权限点判定。
//
// 单独成叶子模块：登录态里的 permissions 现在有两处消费（技能创作 IPC、对话里的安装技能工具），
// 各写一份 JSON.parse('auth-user') 迟早漂移——权限判读漂移意味着闸门在某条路径上失效。
//
// 注意这只是**客户端侧的界面/流程判定**，不是安全边界：真正的授权在后端
// （SecurityConfig 按权限点拦 /api/v1/skills/**）。这里判一下是为了不让用户白填一遍确认卡才被 403。
import { configGet } from './db'
import { swallow } from './util'

function myPerms(): string[] {
  try {
    const u = JSON.parse(configGet('auth-user') || '{}')
    return Array.isArray(u.permissions) ? u.permissions : []
  } catch (e) { swallow(e, 'my-perms'); return [] }
}

/** '*' 视为全权（超管）。 */
export function hasPerm(p: string): boolean {
  const ps = myPerms()
  return ps.includes('*') || ps.includes(p)
}
