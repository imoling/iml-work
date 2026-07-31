// 轻量 CSV 解析（应用内表格预览用）——纯函数，零依赖，可单测。
//
// 只做预览需要的子集：引号字段（含转义引号 "" 与字段内换行/逗号）、\r\n 兼容。
// 不做类型推断/流式——预览上限几百行，追求正确与简单。

export interface CsvPreview {
  headers: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
}

export function parseCsvLite(text: string, maxRows = 200): CsvPreview {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const src = text || ''

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => {
    // 跳过完全空行（末尾换行产生的幽灵行）
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }   // 转义引号
        else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { pushField(); continue }
    if (c === '\n') { pushField(); pushRow(); continue }
    if (c === '\r') { continue }
    field += c
  }
  if (field !== '' || row.length) { pushField(); pushRow() }

  const headers = rows[0] || []
  const body = rows.slice(1)
  return {
    headers,
    rows: body.slice(0, maxRows),
    totalRows: body.length,
    truncated: body.length > maxRows,
  }
}
