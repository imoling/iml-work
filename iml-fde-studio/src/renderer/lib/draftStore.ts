// 调试中的草稿技能：在「快速建技能」里写入，「技能测试」里读取并测试（无需先发布）
// 用 localStorage 持久化 → FDE 重启后草稿仍在，不丢手写的 SOP/直达路由。
const KEY = 'iml-fde-draft-skill'
let mem = null

export function setDraft(d) {
  mem = d
  try { localStorage.setItem(KEY, JSON.stringify(d)) } catch (_) {}
}

export function getDraft() {
  try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s) } catch (_) {}
  return mem
}
