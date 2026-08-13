// 被有意吞掉的错误：默认静默（best-effort 操作失败通常是预期的，不应刷屏），
// 设置环境变量 IML_DEBUG 后统一输出，便于排障。用于替代裸 `catch (_) {}`。
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function swallow(e: unknown, tag?: string): void {
  if (process.env.IML_DEBUG) {
    const msg = (e && typeof e === 'object' && 'message' in e) ? (e as any).message : e
    console.debug(`[swallow]${tag ? ' ' + tag : ''}:`, msg)
  }
}

// 从模型返回的 JSON 里取某个字段的值（字段抽取的统一入口）。
// 坑一：金额/数量类字段模型会输出**裸数字**（"预算(元)": 5000）。早先只认 typeof==='string'，
//       数字被静默丢成空串——用户明明说了"预算5000"，表单里却是空的。字符串字段一切正常，
//       所以这个洞藏了很久：只有数字字段中招。
// 坑二：字段名带标点（如「预算(元)」）时，模型可能吐成全角「预算（元）」，键对不上照样丢值。
// 对象/数组/null 一律不要——那不是字段值，宁可留空让人工补，也不往业务系统里灌垃圾。
export function pickFieldValue(values: Record<string, unknown>, name: string): string {
  const norm = (s: string) => s.replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '')
  let v = values[name]
  if (v === undefined) {
    const want = norm(name)
    const hit = Object.keys(values).find(k => norm(k) === want)
    if (hit !== undefined) v = values[hit]
  }
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return ''
}

// 网络级失败翻译成用户能行动的人话——undici/SDK 的原话只有一句干巴巴的 "fetch failed"。
// 各「测试连接」类 IPC（backend:ping / connectors:test / remote-bot:test / sandbox:status）统一走这里，
// 保证同一种故障在不同设置页看到同一句话。取值顺序 cause.code → message → name：
// undici 网络错误的真相在 cause.code；普通业务 Error 的 name 恒为 "Error"，放最后兜底，
// 否则连接器/机器人 SDK 抛的有意义 message 会被翻成一个词 "Error"。
export function friendlyNetError(e: unknown, base?: string): string {
  const err = e as any
  const raw = String(err?.cause?.code || err?.message || err?.name || err || '')
  const at = base ? ` ${base}` : ''
  if (/ECONNREFUSED/i.test(raw)) return `无法连接${at}——服务未启动或端口不通（ECONNREFUSED）`
  if (/ETIMEDOUT|TimeoutError|UND_ERR_\w*TIMEOUT/i.test(raw)) return `连接${at}超时（ETIMEDOUT）——检查网络或防火墙`
  if (/ECONNRESET|EPIPE|SocketError|other side closed/i.test(raw)) return `连接${at}被中断（ECONNRESET）——服务或代理主动断开`
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `地址无法解析${at ? '：' + base : ''}（DNS 查询失败，检查主机名拼写）`
  if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return `网络不可达${at ? '：' + base : ''}（EHOSTUNREACH，检查网段/VPN）`
  if (/CERT_|certificate|self.signed/i.test(raw)) return `HTTPS 证书校验失败${at ? '：' + base : ''}（自签名或证书过期）`
  if (/fetch failed/i.test(raw)) return `无法连接${at || '目标服务'}（网络不通，或被代理/防火墙拦截）`
  return base ? `${raw || '未知网络错误'}（目标 ${base}）` : (raw || '未知网络错误')
}

// 提交前的日期自洽校验（写操作最后一道代码闸）。
// 真事：用户说"下周去北京"，模型抽出"7月19日出发、7月14日返回"——返回早于出发 5 天，
// 这张荒唐的单子一路确认、真提交进了 OA。提示词已经要求"结束不得早于开始"，但**光靠提示词不够**：
// 模型偶尔不守规矩，而写操作错一次就是脏数据。这里按字段声明顺序检查所有 date 型字段——
// 表单里的日期几乎总是按时间先后排列（出发→返回、开始→结束），后一个早于前一个即视为不自洽。
// 只看 type='date'（与领域无关，不靠"出发/返回"这类中文词，换个系统照样管用）。
export function checkDateOrder(fields: { name: string; label: string; type: string }[], values: Record<string, string>): string {
  const dates = fields
    .filter(f => f.type === 'date')
    .map(f => ({ label: f.label, raw: (values[f.name] || '').trim() }))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.raw))
  for (let i = 1; i < dates.length; i++) {
    for (let j = 0; j < i; j++) {
      if (dates[i].raw < dates[j].raw) {
        return `「${dates[j].label}」${dates[j].raw} 晚于「${dates[i].label}」${dates[i].raw}`
      }
    }
  }
  return ''
}
