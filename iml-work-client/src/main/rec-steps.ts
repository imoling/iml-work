// 录制步骤的形状归一（叶子模块，跨端 DTO 的单一来源）。
//
// 血泪：FDE 录制上架的步骤是 **IR 形状**（`act` / `fp.sel` / `param`），而客户端回放引擎读的是
// **RecStep 形状**（`action` / `selector` / `fieldName`）。两边各写各的，结果回放**从来没读到过选择器**，
// 一路退化成"按文字找元素"——点按钮时碰巧能蒙对，一旦要 fill 就找到 `<label>目的地</label>` 这个标签元素，
// 再拿 HTMLInputElement 的 value setter 去 set 一个 `<label>` → `TypeError: Illegal invocation`。
//
// 凡是从 actionScript / stepsJson 解析步骤的地方，都必须过这一道，别再各自 `p.rawSteps || p.steps` 裸取。
import { type RecStep } from './types'

interface RawStep {
  action?: string; act?: string
  selector?: string; label?: string; value?: string; tag?: string; url?: string
  kind?: string; waitBefore?: number; resultSelector?: string
  fieldName?: string; param?: string
  inputType?: string
  options?: string[]
  fp?: { sel?: string; tag?: string; type?: string }
  frameUrl?: string; inIframe?: boolean
  repeat?: { n: number; idx: number; key: string }; near?: string[]
}

export function normalizeRecSteps(raw: unknown): RecStep[] {
  if (!Array.isArray(raw)) return []
  return raw.map((s: RawStep) => {
    const fp = s?.fp || {}
    const action = (s?.action || s?.act || 'click') as RecStep['action']
    return {
      action,
      selector: s?.selector || fp.sel || '',
      value: s?.value ?? '',
      label: s?.label ?? '',
      tag: s?.tag || fp.tag || '',
      url: s?.url ?? '',
      ...(s?.kind ? { kind: s.kind } : {}),
      ...(s?.waitBefore != null ? { waitBefore: s.waitBefore } : {}),
      ...(s?.resultSelector ? { resultSelector: s.resultSelector } : {}),
      // FDE 用 param 标"这一步填的是哪个参数"，客户端叫 fieldName——同一件事，两个名字。
      ...(s?.fieldName || s?.param ? { fieldName: s.fieldName || s.param } : {}),
      ...(s?.inputType || fp.type ? { inputType: s.inputType || fp.type } : {}),
      ...(Array.isArray(s?.options) ? { options: s.options } : {}),
      // frame/窗口与业务数据信号透传：回放切 frame、参数化点击(列表行)都靠它们
      ...(s?.frameUrl ? { frameUrl: s.frameUrl } : {}),
      ...(s?.inIframe ? { inIframe: true } : {}),
      ...(s?.repeat ? { repeat: s.repeat } : {}),
      ...(Array.isArray(s?.near) && s.near.length ? { near: s.near } : {}),
    } as RecStep
  })
}

/** 从 actionScript / stepsJson 的解析结果里取步骤（兼容 steps / rawSteps 两种存法），并归一形状。 */
export function extractRecSteps(parsed: { steps?: unknown; rawSteps?: unknown } | unknown[]): RecStep[] {
  if (Array.isArray(parsed)) return normalizeRecSteps(parsed)
  const p = parsed as { steps?: unknown; rawSteps?: unknown }
  return normalizeRecSteps(Array.isArray(p?.rawSteps) ? p.rawSteps : p?.steps)
}
