// 录后「候选参数识别」:三层信号(结构归并/重复容器/规则形态),纯函数零模型,
// 产出交 FDE 审阅区逐项定夺(参数化/固定)。LLM 建议层在 skill-run.ts 的 skill:suggest-params,
// 与本模块互补——这里管"确定性信号",模型管"语义判断",都只建议不自动定稿。
export interface ParamHint {
  index: number        // 命中的步骤下标
  name: string         // 建议参数名(去重后)
  reason: string       // 为什么建议参数化(展示给 FDE)
  confidence: number   // 0~1,排序用
  default: string      // 默认值 = 录制原值
  type?: string        // 建议控件类型(text/date/number/select/file)
}

// 值形态正则(借 workflow-use VariableIdentifier 思路,按中文业务语境重写)
const VALUE_RES: Array<[RegExp, string, string]> = [
  [/^\d{4}[-/年]\d{1,2}[-/月]?\d{0,2}/, 'date', '值是日期形态'],
  [/^1[3-9]\d{9}$/, 'text', '值是手机号形态'],
  [/^[\w.+-]+@[\w-]+\.[\w.]+$/, 'text', '值是邮箱形态'],
  [/^[A-Z]{2,6}[-_]?\d{4,}$/, 'text', '值是单号/编号形态'],
  [/^[¥$]?\d+(,\d{3})*(\.\d+)?(元|万|万元)?$/, 'number', '值是金额/数量形态'],
]
// 字段名业务关键词(领域语料放数据不放代码——这里只留最通用的一层)
const LABEL_KEYWORDS = /客户|名称|标题|主题|单号|编号|金额|数量|日期|时间|部门|联系人|电话|手机|邮箱|地址|备注|说明|事由|原因|姓名|公司|项目|合同|订单|物料|供应商|内容|意见/
// 稳定 UI 文案(锚点,绝不建议参数化)
const UI_WORDS = /^(提交|保存|取消|确定|确认|新建|新增|添加|删除|编辑|查询|搜索|重置|返回|关闭|下一步|上一步|登录|退出|首页|列表|详情|全部|更多|刷新|导出|导入|同意|驳回|通过|拒绝|审批|处理)$/

export function identifyParamCandidates(steps: any[]): ParamHint[] {
  const hints: ParamHint[] = []
  const seen = new Set<string>()
  const push = (h: ParamHint) => {
    let name = h.name
    if (seen.has(name)) { let n = 2; while (seen.has(name + n)) n++; name = name + n }
    seen.add(name); hints.push({ ...h, name })
  }
  ;(steps || []).forEach((s, i) => {
    if (!s) return
    if (s.param) { seen.add(String(s.param)); return }  // 已是参数的占住名字,避免建议重名
    const label = String(s.label || '').trim()
    const value = String(s.value || '').trim()
    // ① 结构信号:归并出的「检索并选择」字段(开下拉→点结果),天然是业务对象
    if (s.act === 'search') { push({ index: i, name: label || '检索对象', reason: '检索并选择的关联对象(录制值只是当时那条)', confidence: 0.9, default: value, type: 'text' }); return }
    // ① 结构信号:点在重复容器(列表行/卡片,同构兄弟≥3)里的文本 → 大概率是业务数据
    if (s.act === 'click' && s.repeat && label && !UI_WORDS.test(label)) {
      push({ index: i, name: '目标记录', reason: `点击了列表第 ${s.repeat.idx}/${s.repeat.n} 行的业务数据「${label.slice(0, 12)}」`, confidence: 0.8, default: label, type: 'text' })
      return
    }
    // 上传:运行时必须由执行侧供文件,强建议参数化
    if (s.act === 'upload') { push({ index: i, name: label || '附件', reason: '上传文件,回放时需提供本地文件', confidence: 0.95, default: value, type: 'file' }); return }
    // ② 规则信号:fill/select/choose 的值命中业务形态,或字段名命中业务关键词
    if (s.act === 'fill' || s.act === 'select' || s.act === 'choose') {
      let matched = ''; let vtype = ''
      for (const [re, t, why] of VALUE_RES) { if (value && re.test(value)) { matched = why; vtype = t; break } }
      if (!matched && label && LABEL_KEYWORDS.test(label)) matched = '字段名含业务关键词'
      if (matched) push({ index: i, name: label || ('字段' + (i + 1)), reason: matched, confidence: 0.7, default: value, type: vtype || (s.act === 'fill' ? 'text' : 'select') })
      return
    }
    // 未被归并的下拉点选:值也可能是业务数据(置信度最低,仅提示)
    if (s.act === 'pickOption' && value && value.length >= 2 && !UI_WORDS.test(value)) {
      push({ index: i, name: label || '选项', reason: '下拉点选的值(若随任务变化应参数化)', confidence: 0.5, default: value, type: 'select' })
    }
  })
  return hints.sort((a, b) => b.confidence - a.confidence)
}

// 保存前卡口(警告不硬阻断):值长得像业务数据、却既没参数化也没被识别确认过的步骤
export function unresolvedBusinessValues(steps: any[]): Array<{ index: number; label: string; value: string; why: string }> {
  const out: Array<{ index: number; label: string; value: string; why: string }> = []
  ;(steps || []).forEach((s, i) => {
    if (!s || s.param) return
    if (!['fill', 'search', 'upload'].includes(s.act)) return
    const value = String(s.value || '').trim()
    if (!value) return
    for (const [re, , why] of VALUE_RES) {
      if (re.test(value)) { out.push({ index: i, label: String(s.label || ''), value, why }); return }
    }
  })
  return out
}
