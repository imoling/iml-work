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

/**
 * iML 自己注入到页面上的浮层 id（登录提示条 / 录制提示条）。
 *
 * **取正文判定登录态时必须把它们排除**——提示条文案里就写着「请在此窗口完成登录」「我已登录，检测」，
 * 读进来就是自己看自己的字：正文短的业务页（ERM 排产页实测 ~350 字符）本来不含任何登录词，
 * 加上浮层这几十个字后既没超 400 阈值、又凭空命中了"登录"，于是登录完点检测永远回
 * 「似乎还没登录」（2026-08-05 真机实锤）。判定器不能读自己画的 UI。
 */
export const IML_OVERLAY_IDS = ['__iml_login_bar', '__iml_rec_bar']

/**
 * 页面正文取样表达式：`(limit)=>string`，直接拼进 executeJavaScript / page.evaluate。
 * 剔除 iML 浮层文案的方式是**从结果串里减去浮层自身的 innerText**，不去改 display——
 * 改样式会让浮层在用户眼前闪一下，且触发两次重排。
 */
export const PAGE_TEXT_JS = `(function(limit){
  try {
    var b = document.body; if (!b) return '';
    var t = b.innerText || '';
    var ids = ${JSON.stringify(IML_OVERLAY_IDS)};
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]); if (!el) continue;
      var ot = el.innerText || ''; if (!ot) continue;
      var k = t.indexOf(ot);
      if (k >= 0) t = t.slice(0, k) + t.slice(k + ot.length);
    }
    return t.slice(0, limit || 800);
  } catch (e) { return ''; }
})`

/**
 * 密码输入框探测：`()=>boolean`。比"正文含登录二字"强得多的结构化信号——
 * 已登录的业务页几乎不会有 input[type=password]，而登录页一定有。
 */
export const HAS_PASSWORD_FIELD_JS = `(function(){ try { return !!document.querySelector('input[type=password]'); } catch (e) { return false; } })`

/**
 * 登录态综合判定（主进程侧单一来源）。三路证据，任一命中即「仍未登录」：
 * URL 是登录/SSO 地址、页面有密码输入框、正文呈登录页特征（极短 + 登录词）。
 * 保持"宁可漏判已登录、不可误判未登录"的保守取向——在登录页上瞎跑自动化比多点一次检测糟得多。
 */
export function stillOnLoginPage(opts: { text: string; url?: string; hasPasswordField?: boolean }): boolean {
  return isLoginUrl(opts.url || '') || !!opts.hasPasswordField || isLoginText(opts.text)
}
