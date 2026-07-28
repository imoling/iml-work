// 写确认的一次性签名令牌闸（红线④后半程，体检 P1-1 接线）：
// 本地确认卡（人看清单据）+ 服务端 HMAC 一次性令牌（防重放/防表单中途调包）双闸合一。
//
// 语义：formDataHash 绑定的是**签发时摆给用户看的表单内容**——「执行的动作与用户签字时看到的
// 单据未被中途调包」。用户在卡里的可编辑输入（审批意见等）是他本人的产出，不参与摘要。
//
// 降级纪律（诚实优先）：后端令牌服务不可达时**不阻断**写操作（本地确认卡仍在），但必须把
// tokenState='degraded' 如实写进 trace 文案——绝不声称"已用一次性签名令牌"（体检 P1-1 的安全假象教训）。
import crypto from 'crypto'
import { afetch, getAdminBaseUrl } from './http'
import { requestFormConfirmation, type FormField, type FormCardOpts } from './automation-runtime'
import { swallow } from './util'

export interface SignedToken { tokenId: string; hash: string }
export type TokenState = 'consumed' | 'degraded' | 'rejected' | 'cancelled'
export interface SignedConfirmResult {
  values: Record<string, string> | null
  tokenState: TokenState
  rejectReason?: string
}

/** 令牌状态 → trace/HITL 节点的如实文案（单一来源，勿在调用方各写各的）。 */
export function tokenStateNote(st: TokenState): string {
  return st === 'consumed' ? '用户已确认（一次性签名令牌已核验消费）'
    : st === 'degraded' ? '用户已在本地确认卡确认（令牌服务不可达，本次降级为纯本地确认）'
    : st === 'rejected' ? '签名令牌校验拒绝（过期/重放/表单变更），未执行'
    : '用户取消确认，未执行'
}

function formDataHash(fields: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(fields ?? {})).digest('hex')
}

async function issueToken(meta: { actionId?: string; capability?: string; skillId?: string }, fields: unknown): Promise<SignedToken | null> {
  try {
    const hash = formDataHash(fields)
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/confirmations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...meta, formDataHash: hash }),
    })
    if (!r.ok) return null
    const d = await r.json() as { id?: string }
    return d && d.id ? { tokenId: d.id, hash } : null
  } catch (e) { swallow(e, 'confirm-token-issue'); return null }
}

async function consumeToken(tok: SignedToken, meta?: { actionId?: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/confirmations/${tok.tokenId}/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formDataHash: tok.hash, ...(meta || {}) }),
    })
    const d = await r.json().catch(() => ({})) as { ok?: boolean; reason?: string }
    return { ok: !!d.ok, reason: d.reason }
  } catch (e) { swallow(e, 'confirm-token-consume'); return { ok: false, reason: '令牌服务不可达' } }
}

/**
 * 组合闸：签发令牌 → 弹确认卡 → 消费令牌。所有企业写路径统一走这里（替代裸 requestFormConfirmation）。
 * - cancelled：用户取消（values=null）
 * - rejected：令牌被拒（过期/重放/表单变更）——**必须中止执行**（values=null）
 * - degraded：令牌服务不可达，仅本地确认（values 有效；trace 用 tokenStateNote 如实标注）
 * - consumed：双闸通过（values 有效）
 */
export async function requestSignedConfirmation(
  fields: FormField[],
  meta: { actionId?: string; capability?: string; skillId?: string },
  opts?: FormCardOpts,
): Promise<SignedConfirmResult> {
  const tok = await issueToken(meta, fields)
  const rc = await requestFormConfirmation(fields, opts)
  if (!rc || Object.keys(rc).length === 0) return { values: null, tokenState: 'cancelled' }
  if (!tok) return { values: rc, tokenState: 'degraded' }
  const c = await consumeToken(tok, { actionId: meta.actionId })
  if (!c.ok) return { values: null, tokenState: 'rejected', rejectReason: c.reason }
  return { values: rc, tokenState: 'consumed' }
}
