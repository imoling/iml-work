// 欢迎态特色技能卡的数据（图/文案/场景示例库）。
// 点卡片弹出示例面板，点场景把话术填进输入框——话术是产品侧维护的语料，改这里即可，不动组件。
import heroDeepResearch from '../../assets/hero/deep-research.svg'
import heroStock from '../../assets/hero/stock.svg'
import heroDocGen from '../../assets/hero/doc-gen.svg'
import heroBizOps from '../../assets/hero/biz-ops.svg'
import heroCodeDev from '../../assets/hero/code-dev.svg'
import heroPersonalHub from '../../assets/hero/personal-hub.svg'

/** skillId/skillName：点选该示例时**锁定**这个技能直执行（与技能选择器同一机制）——
 *  明确任务不赌路由。缺省则只填话术、走常规判定。id 对应平台预置技能（builtin）。 */
export interface HeroExample { scene: string; text: string; skillId?: string; skillName?: string }
export interface HeroSkill { key: string; img: string; name: string; desc: string; examples: HeroExample[] }

export const HERO_SKILLS: HeroSkill[] = [
  {
    key: 'deep-research',
    img: heroDeepResearch,
    name: '深度调研',
    desc: '多轮联网检索，产出带信源的调研报告',
    examples: [
      { scene: '行业动态', text: '帮我深度调研人形机器人行业的最新进展和主要玩家', skillId: 'skill-imp-3474dd55', skillName: '深度调研' },
      { scene: '竞品分析', text: '深度调研一下国内教育AI市场的头部玩家与竞争格局', skillId: 'skill-imp-3474dd55', skillName: '深度调研' },
      { scene: '技术趋势', text: '调研一下多模态大模型今年的技术路线趋势', skillId: 'skill-imp-3474dd55', skillName: '深度调研' },
      { scene: '政策解读', text: '深度调研最近的AI监管政策对企业落地的影响', skillId: 'skill-imp-3474dd55', skillName: '深度调研' },
      { scene: '出海市场', text: '调研新能源汽车出海东南亚的市场机会与风险', skillId: 'skill-imp-3474dd55', skillName: '深度调研' },
      { scene: '自定主题', text: '帮我深度调研 ', skillId: 'skill-imp-3474dd55', skillName: '深度调研' },
    ],
  },
  {
    key: 'stock',
    img: heroStock,
    name: 'A股研究',
    desc: '行情、资金、龙虎榜、题材——一句话拿结论',
    examples: [
      { scene: '个股估值', text: '帮我估一下 688017，给我 PE / PEG / 消化时间', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '题材归因', text: '今天哪些股票走强，主要是什么题材', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '研报检索', text: '人形机器人产业链最近的研报，特别是丝杠和减速器', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '北向资金', text: '今天北向资金流入流出怎么样', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '概念板块', text: '688017 属于哪些概念板块', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '资金流向', text: '000858 今天主力资金流入还是流出', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '龙虎榜', text: '002475 最近上过龙虎榜吗，哪些营业部在买', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '全市场龙虎榜', text: '今天龙虎榜哪些票净买入最多', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '解禁预警', text: '这只股票未来 3 个月有没有限售解禁', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '行业轮动', text: '今天哪些行业涨幅最大', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '板块资金流', text: '今天主力资金在流入哪些行业/概念板块，近 5 日趋势呢', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '融资融券', text: '600519 最近的融资余额变化趋势', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '大宗交易', text: '这只票最近有没有大宗交易，溢价还是折价', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '股东户数', text: '000858 股东户数在增加还是减少，筹码集中吗', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '分红送转', text: '茅台历年分红派息多少', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: 'ETF 行情', text: '510050 上证50ETF 现在什么价、今天涨跌多少', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '涨停打板', text: '今天涨停多少家、最高几连板、炸板率多少', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '涨停归因', text: '今天涨停的票都是什么题材，哪些是几天几板', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '重点监控池', text: '现在哪些标的被交易所列入重点监控，监控到什么时候', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '日内异动', text: '今天有哪些严重异常波动的票，触发的是哪条异动规则', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '异动×监控交叉', text: '今天异动的票里，有没有已经在重点监控名单上的', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: 'ETF 期权', text: '50ETF 平值期权的隐含波动率和 Delta 是多少', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '互动易', text: '比亚迪最近投资者都在问什么，公司怎么回应的', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '市场热度', text: '今天哪些票最热门，被归到什么概念在炒', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '新闻公告', text: '拉一下 300476 最近的新闻和公告', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '市场快讯', text: '用财联社电报看看现在市场上有什么大新闻', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
      { scene: '批量对比', text: '帮我对比 中芯国际、韦尔股份、北方华创、澜起科技、寒武纪 这 5 只半导体股的估值', skillId: 'skill-imp-fcde6655', skillName: 'A股分析' },
    ],
  },
  {
    key: 'doc-gen',
    img: heroDocGen,
    name: '文档助手',
    desc: '大纲、Word/PPT/PDF/Excel、图片视频、审校，一站出稿',
    examples: [
      { scene: '写大纲', text: '帮我列一份季度业务汇报的 PPT 大纲，先出大纲我确认后再生成成稿' },
      { scene: 'Word 文档', text: '写一份客户答谢活动策划方案，输出 Word 文档，含日程表和预算表', skillId: 'skill-imp-810813c9', skillName: 'docx' },
      { scene: 'PPT 演示', text: '把我们的项目介绍做成 10 页以内的 PPT，风格商务简洁', skillId: 'skill-imp-4a954f92', skillName: 'pptx' },
      { scene: 'PDF 交付', text: '生成一份产品报价单 PDF，包含产品明细表、有效期和落款', skillId: 'skill-imp-dba1dfbb', skillName: 'pdf' },
      { scene: 'Excel 报表', text: '做一份销售月报 Excel：明细页 + 按区域/品类的汇总透视页 + 趋势图表', skillId: 'skill-imp-3eb6c86e', skillName: 'xlsx' },
      { scene: 'Excel 问数', text: '分析我发你的这份表格：按月汇总销售额、找出环比下滑的品类，给出图表和结论', skillId: 'skill-imp-3eb6c86e', skillName: 'xlsx' },
      { scene: '图片生成', text: '生成一张产品发布会主视觉海报图，科技感、深色底、留出标题位置', skillId: 'skill-imp-imagegen', skillName: 'image-gen' },
      { scene: '视频生成', text: '生成一段 10 秒的产品宣传短视频：都市夜景里霓虹流动，节奏明快', skillId: 'skill-imp-videogen', skillName: 'video-gen' },
      { scene: '文稿审校', text: '帮我审校这份稿件：错别字、语病、标点与格式问题都标出来，出批注版', skillId: 'skill-imp-3da4e454', skillName: 'iml-copyediting' },
      { scene: '周报总结', text: '帮我写一份本周工作总结' },
    ],
  },
  {
    key: 'code-dev',
    img: heroCodeDev,
    name: '代码编程',
    desc: '写脚本、做网页小工具、读代码，沙箱真跑验证',
    examples: [
      { scene: '网页小工具', text: '做一个单文件 HTML 的会议室预定看板：时段网格、点击预定、localStorage 保存，手机电脑都能用' },
      { scene: '办公脚本', text: '写一个 Python 脚本：把文件夹里的 Excel 按月份合并成一张总表，附使用说明' },
      { scene: '数据处理', text: '写脚本清洗这份 CSV：去重、补全缺失日期、按周汇总后导出新表' },
      { scene: '正则 / SQL', text: '帮我写一条正则，匹配中国大陆手机号和座机号，并逐段解释' },
      { scene: '代码解读', text: '解释一下这段代码在做什么，指出潜在 bug 和改进点：' },
    ],
  },
  {
    key: 'personal-hub',
    img: heroPersonalHub,
    name: '个人工作台',
    desc: '一句话生成专属的单文件应用，离线可用、数据不丢',
    examples: [
      {
        scene: '生活管家',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '给我做一个家庭生活管理台「小日子」，单文件 HTML：①记账（收支记录、月度预算、分类占比图、CSV 导出）②习惯打卡（自定义习惯 + 30 天热力图）③家庭日程与待办 ④心愿清单（想买的东西记价格、标记已购）。数据即时存 localStorage 关页不丢，支持 JSON 备份导入导出，预置少量可一键清空的演示数据；视觉温暖有生活气，避免模板化卡片风；手机单列 + 底部 Tab、电脑多栏，按钮和输入框要方便触屏点按，深浅色下文字都清晰可读。',
      },
      {
        scene: '儿童启蒙',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个 3-6 岁小朋友的启蒙乐园「启蒙星球」，单文件 HTML：①拼音角（声母韵母卡片点读，Web Speech 发音）②算术泡泡（10 以内加减法，答对泡泡爆开）③认物双语卡（动物/水果中英点读）④图形配对小游戏 ⑤奖励星系（做题攒星星、点亮星球成就墙）。糖果色、圆角大按钮（≥44px 方便小手），移动端底部 Tab、平板横排导航；星星和进度存 localStorage；不依赖任何外部资源，离线可用。',
      },
      {
        scene: '办公工作台',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个个人办公工作台「今日事」，单文件 HTML：①待办事项（真增删改、优先级、标签、今日/本周视图，勾选完成自动记完成时间）②番茄时钟（默认 25+5 可自定义、真实倒计时、结束提示音与页面标题闪烁、可关联某条待办并累计其专注时长）③自动日报/周报（按当天/本周真实完成的待办与番茄数生成结构化文本：完成了什么、投入多少专注时间、未完成顺延项，一键复制）④本周统计（每日番茄数与完成数的 SVG 柱状图）。数据即时存 localStorage 关页不丢，JSON 导入导出备份，预置可清空的演示数据；克制的效率工具风，手机单列 + 底部 Tab、电脑左侧导航，深浅色下都清晰可读。',
      },
      {
        scene: '目标冲刺',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个「目标冲刺板」，专管有总量和截止日的目标（背 2000 个单词、读完 400 页书这类），单文件 HTML：每日建议量自动算（剩余量÷剩余天数，打卡时可改）；每个目标显示完成率、连续天数（每周容错一次漏卡）、按近 7 天速度推算的预计完成日（样本不足就如实显示"暂无推算"）；今日/看板/周报/设置四个 Tab，周报可一键复制文本；SVG 进度环与近两周投入柱状图。localStorage 即时保存，JSON 导入导出，内置几个可清空的示例目标覆盖补卡、漏卡场景。',
      },
      {
        scene: '运动打卡',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个极简运动打卡站「练起来」，单文件 HTML：今日打卡（运动类型/时长/强度）、连续天数与本周汇总、体重记录 + 7 日均线 SVG 曲线、月历视图回看、成就墙。清爽运动风、动效克制，移动端底部 Tab、桌面侧栏；数据存 localStorage，支持 JSON 备份导入导出；不引用任何外部库和字体，断网双击即可用。',
      },
      {
        scene: '物理课件',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个初中物理互动课件「火车受力分析」，单文件 HTML：画面里一列火车停在铁轨上，用带标签的箭头实时画出牵引力、摩擦力、重力、支持力；滑块可调牵引力大小与坡度角度，实时计算并显示合力与加速度，火车随之加速/减速/匀速（内联 SVG 动画）；附 3 道随堂判断题，答错高亮讲解受力要点。适配手机和电脑、离线可用，界面清晰适合课堂投屏。',
      },
      {
        scene: '数学课件',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个初中数学互动课件「二次函数实验室」，单文件 HTML：y=ax²+bx+c 三个参数各配滑块，原生 SVG 坐标系上实时重绘抛物线，动态标注顶点、对称轴与坐标轴交点；附「看图猜参数」小游戏（随机给一条抛物线，学生调滑块去拟合，误差达标即过关计分）。离线可用，手机电脑都能操作，数字与刻度清晰适合投屏。',
      },
      {
        scene: '科学课件',
        skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable',
        text: '做一个小学科学互动课件「太阳系漫游」，单文件 HTML：八大行星按轨道绕太阳运转（内联 SVG 动画，速度可调可暂停），点击行星弹出资料卡（相对大小、距离、一条趣味知识）；附「行星排序」拖拽小测验，全对给星星奖励。配色深空风但文字对比度充足，离线可用、手机电脑均可操作。',
      },
      { scene: '自定工作台', text: '帮我做一个个人工作台，单文件 HTML、离线可用、数据存 localStorage：', skillId: 'skill-imp-7a47d5c1', skillName: 'impeccable' },
    ],
  },
  {
    key: 'biz-ops',
    img: heroBizOps,
    name: '业务系统操作',
    desc: '用你的登录态查单据、办流程，写入前必确认',
    examples: [
      { scene: '今日待办', text: '查询我今天的待办事项' },
      { scene: '单据查询', text: '查一下我最近提交的报销单状态' },
      { scene: '待我审批', text: '帮我看看有哪些待我审批的流程' },
      { scene: '客户跟进', text: '帮我在CRM里录入一条客户跟进记录' },
      { scene: '数据核对', text: '查一下本月我负责客户的回款情况' },
    ],
  },
]
