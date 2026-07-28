// 登录页判定的**单一来源**（纯叶子，零依赖）。体检 P2-9 教训：同一判定曾有 8+ 份漂移副本
//（词表各不相同、400 阈值散落各处）——同一页面在不同引擎下可能一个判"未登录"一个判"已登录"。
// 所有引擎（回放/DSL/SOP/browse/保活/pw/预检）一律从这里取；页面注入脚本用 *_SRC 字符串形态。
//
// 词表取历史副本的**并集**（只放宽不收紧：漏判"未登录"会让自动化在登录页上瞎跑，比误判更糟）。

/** 登录页文案特征（配合"正文极短"阈值使用；单独命中不代表未登录——已登录门户也常有"退出登录"）。 */
export const LOGIN_TEXT_RE = /(登录|登陆|log\s?in|sign\s?in|账号|帐号|密码|password|认证|扫码|验证码)/i

/** 登录/单点认证类 URL 特征（命中即未登录，与正文长度无关）。含 SSO/CAS/authserver 变体（讯飞/泛微实测）。 */
export const LOGIN_URL_RE = /\/(sso\/)?login(\?|$|#|\/)|\/signin|account\/login|\/cas\/login|casLogin|authserver|\/cas\b|\/auth\/|passport|\/authorize|sso\.[a-z]/i

/** 登录页正文长度阈值：正文极短 + 含登录字样才判未登录（营销文案丰富的登录页靠 URL 特征补判）。 */
export const LOGIN_PAGE_MAX_TEXT = 400

/** 正文是否呈登录页特征（极短 + 登录字样）。 */
export function isLoginText(text: string): boolean {
  const t = (text || '').trim()
  return t.length < LOGIN_PAGE_MAX_TEXT && LOGIN_TEXT_RE.test(t)
}

/** URL 是否是登录/认证页。 */
export function isLoginUrl(url: string): boolean {
  return !!url && LOGIN_URL_RE.test(url)
}

/** 综合判定：正文特征或 URL 特征任一命中即视为登录页。 */
export function looksLikeLoginPage(text: string, url?: string): boolean {
  return isLoginText(text) || isLoginUrl(url || '')
}

/** 页面注入脚本用的内联片段：`(txt)=>boolean` 的表达式体（正则字面量含 /i，直接拼进 executeJavaScript）。 */
export const LOGIN_TEXT_JS = `(function(txt){ txt = String(txt||''); return txt.trim().length < ${LOGIN_PAGE_MAX_TEXT} && ${LOGIN_TEXT_RE.toString()}.test(txt) })`
