// 写意图判定的**单一来源**（纯叶子，零依赖）。体检 P1-2 教训：曾是两份漂移词表——
// agent-browse 的点击闸无英文、无「确定」；skill-exec 的技能分类表又是另一份——
// 英文按钮（Submit/Approve/Delete）与「确 定」类提交按钮上，写前签字一次都不会触发。
//
// 三层分工（都从这里取，别再各写各的）：
// 1) WRITE_INTENT_STRONG：明确写动词（中英）。browse/pw 点击闸命中即须签字。
// 2) AMBIGUOUS_CONFIRM：「确定/确认/OK」类歧义按钮。拾取弹窗/人员选择里的「确定」是常规交互，
//    逢确定必签会把流程打断成弹卡轰炸（当初整词排除的原因）——现在改为：**仅当 DOM 语义为
//    提交控件（type=submit / form 内默认 submit 的 button）时**按写处理（探针在 agent-browse）。
// 3) WRITE_INTENT_LABEL：技能读写分类的宽表（只读拦截用）。宁宽勿漏：多判成"写"只是多拦一道，
//    漏判成"读"才会出"看考勤误打卡"的事故。

/** 明确写动词：点击即改变业务状态，须写前签字。含空格变体（提 交/保 存/确 定 常见于国产系统按钮）与英文。 */
export const WRITE_INTENT_STRONG =
  /(提交|提 交|保存|保 存|发送|发布|同意|批准|通过|核准|驳回|拒绝|退回|删除|移除|作废|撤销|撤回|签退|签到|打卡|补卡|下单|付款|支付|结算|转账|签收|收货|盖章|签字|生效|发起|归档|上架|下架)|\b(submit|save|send|publish|approve|reject|delete|remove|revoke|withdraw|pay|checkout|sign\s?off)\b/i

/** 「确定/确认/OK」类歧义按钮：仅当 DOM 语义为提交控件时按写处理（配合 probeSubmitSemantics）。 */
export const AMBIGUOUS_CONFIRM = /^(确\s*定|确\s*认|ok|okay|yes|confirm)$/i

/** 技能读写分类宽表（含歧义词与新增/录入等）：只读模式据此拦截写技能。 */
export const WRITE_INTENT_LABEL =
  /同意|通过|批准|审批|核准|提交|确认|确定|保存|删除|移除|清除|新增|添加|录入|创建|发布|上架|下架|归档|驳回|拒绝|退回|撤回|撤销|作废|付款|转账|下单|支付|签收|收货|盖章|签字|生效|发送|发起|打卡|签到|签退|上班卡|下班卡|补卡|外出登记|\b(submit|save|send|publish|approve|reject|delete|remove|confirm|pay|checkout)\b/i

/**
 * 页面内提交语义探针（与 evalJS 配套的自包含函数体，无外部依赖）：
 * 按钮文本匹配 target 且满足「type=submit，或 form 内未显式 type 的 button（HTML 默认即 submit）」→ true。
 * 用于把「确 定」类歧义按钮里**真正落库的那一个**识别出来，其余（弹窗拾取器的确定）不打扰。
 */
export const SUBMIT_PROBE_FN = `(function (t) {
  try {
    t = String(t || '').replace(/\\s+/g, '')
    if (!t) return false
    var cand = document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')
    for (var i = 0; i < cand.length; i++) {
      var el = cand[i]
      var txt = String(el.innerText || el.value || '').replace(/\\s+/g, '')
      if (!txt || (txt !== t && txt.indexOf(t) < 0 && t.indexOf(txt) < 0)) continue
      var ty = String(el.getAttribute('type') || '').toLowerCase()
      if (ty === 'submit') return true
      if (el.tagName === 'BUTTON' && !ty && el.closest('form')) return true
    }
  } catch (e) { /* page */ }
  return false
})`
