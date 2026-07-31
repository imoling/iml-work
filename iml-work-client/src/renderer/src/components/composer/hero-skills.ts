// 欢迎态特色技能卡的数据（图/文案/场景示例库）。
// 点卡片弹出示例面板，点场景把话术填进输入框——话术是产品侧维护的语料，改这里即可，不动组件。
import heroDeepResearch from '../../assets/hero/deep-research.svg'
import heroStock from '../../assets/hero/stock.svg'
import heroDocGen from '../../assets/hero/doc-gen.svg'
import heroBizOps from '../../assets/hero/biz-ops.svg'

export interface HeroExample { scene: string; text: string }
export interface HeroSkill { key: string; img: string; name: string; desc: string; examples: HeroExample[] }

export const HERO_SKILLS: HeroSkill[] = [
  {
    key: 'deep-research',
    img: heroDeepResearch,
    name: '深度调研',
    desc: '多轮联网检索，产出带信源的调研报告',
    examples: [
      { scene: '行业动态', text: '帮我深度调研人形机器人行业的最新进展和主要玩家' },
      { scene: '竞品分析', text: '深度调研一下科大讯飞在教育AI市场的竞品格局' },
      { scene: '技术趋势', text: '调研一下多模态大模型今年的技术路线趋势' },
      { scene: '政策解读', text: '深度调研最近的AI监管政策对企业落地的影响' },
      { scene: '出海市场', text: '调研新能源汽车出海东南亚的市场机会与风险' },
      { scene: '自定主题', text: '帮我深度调研 ' },
    ],
  },
  {
    key: 'stock',
    img: heroStock,
    name: 'A股研究',
    desc: '行情、资金、龙虎榜、题材——一句话拿结论',
    examples: [
      { scene: '个股估值', text: '帮我估一下 688017，给我 PE / PEG / 消化时间' },
      { scene: '题材归因', text: '今天哪些股票走强，主要是什么题材' },
      { scene: '研报检索', text: '人形机器人产业链最近的研报，特别是丝杠和减速器' },
      { scene: '北向资金', text: '今天北向资金流入流出怎么样' },
      { scene: '概念板块', text: '688017 属于哪些概念板块' },
      { scene: '资金流向', text: '000858 今天主力资金流入还是流出' },
      { scene: '龙虎榜', text: '002475 最近上过龙虎榜吗，哪些营业部在买' },
      { scene: '全市场龙虎榜', text: '今天龙虎榜哪些票净买入最多' },
      { scene: '解禁预警', text: '这只股票未来 3 个月有没有限售解禁' },
      { scene: '行业轮动', text: '今天哪些行业涨幅最大' },
      { scene: '板块资金流', text: '今天主力资金在流入哪些行业/概念板块，近 5 日趋势呢' },
      { scene: '融资融券', text: '600519 最近的融资余额变化趋势' },
      { scene: '大宗交易', text: '这只票最近有没有大宗交易，溢价还是折价' },
      { scene: '股东户数', text: '000858 股东户数在增加还是减少，筹码集中吗' },
      { scene: '分红送转', text: '茅台历年分红派息多少' },
      { scene: 'ETF 行情', text: '510050 上证50ETF 现在什么价、今天涨跌多少' },
      { scene: '涨停打板', text: '今天涨停多少家、最高几连板、炸板率多少' },
      { scene: '涨停归因', text: '今天涨停的票都是什么题材，哪些是几天几板' },
      { scene: '重点监控池', text: '现在哪些标的被交易所列入重点监控，监控到什么时候' },
      { scene: '日内异动', text: '今天有哪些严重异常波动的票，触发的是哪条异动规则' },
      { scene: '异动×监控交叉', text: '今天异动的票里，有没有已经在重点监控名单上的' },
      { scene: 'ETF 期权', text: '50ETF 平值期权的隐含波动率和 Delta 是多少' },
      { scene: '互动易', text: '比亚迪最近投资者都在问什么，公司怎么回应的' },
      { scene: '市场热度', text: '今天哪些票最热门，被归到什么概念在炒' },
      { scene: '新闻公告', text: '拉一下 300476 最近的新闻和公告' },
      { scene: '市场快讯', text: '用财联社电报看看现在市场上有什么大新闻' },
      { scene: '批量对比', text: '帮我对比 中芯国际、韦尔股份、北方华创、澜起科技、寒武纪 这 5 只半导体股的估值' },
    ],
  },
  {
    key: 'doc-gen',
    img: heroDocGen,
    name: '报告生成',
    desc: '总结、方案、汇报文档，成稿即交付',
    examples: [
      { scene: '周报总结', text: '帮我写一份本周工作总结' },
      { scene: '活动方案', text: '写一份客户答谢活动的策划方案' },
      { scene: '汇报大纲', text: '帮我列一份季度业务汇报的PPT大纲' },
      { scene: '会议议程', text: '帮我起草一份项目启动会的会议议程' },
      { scene: '对外邮件', text: '帮我写一封给客户的项目进度同步邮件' },
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
