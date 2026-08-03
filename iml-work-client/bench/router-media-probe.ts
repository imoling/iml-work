// 多媒体生成技能的**路由探针**：新加 image-gen / video-gen 后，验证两件事——
// ① 该命中的命中；② 不该命中的**不要误触发**（画流程图/做PPT封面/看图 这类相邻语义最容易被误吞，
//    项目此前基准测试的 P0 之一就是「路由误触发生成技能」）。
// 跑法：node bench/router-media-probe.build.mjs && node node_modules/.bench/router-media-probe.mjs
import fs from 'node:fs'
import { routeSkillsByIntent } from '../src/main/skill-exec'
import { currentLlmConfig } from '../src/main/llm'

type Case = { q: string; want: string | null }
const CASES: Case[] = [
  // 正例
  { q: '帮我画一张橘猫在办公室的插画', want: 'image-gen' },
  { q: '生成一张产品发布会的海报底图', want: 'image-gen' },
  { q: '做个短视频，展示咖啡在窗边冒热气', want: 'video-gen' },
  { q: '生成一段 5 秒的产品演示动画', want: 'video-gen' },
  // 反例：相邻语义，绝不能被生成技能吞掉
  // 结构图有专门的 architecture-diagram 技能——考的是 image-gen 别去抢（'画' 字在这里不是 AI 作图）
  { q: '帮我画个系统架构的流程图', want: 'architecture-diagram' },
  { q: '把这份大纲做成 PPT', want: 'pptx' },
  { q: '这张截图里写的是什么？', want: null },             // 看图 = 视觉理解，不是生成
  { q: '把上季度销量做成柱状图', want: null },             // 数据可视化，数字要准
  { q: '写一份 Q3 复盘的 Word 文档', want: 'docx' },
  { q: '帮我梳理一下这个项目的思路', want: null },          // answer 类，一律不走技能
]

;(async () => {
  // 技能目录从文件读（catalog 接口要管理员鉴权，bench 里不引入登录态；
  // 形状与接口一致，路由判据只用到 id/name/description/triggerKeywords）
  const skills: any[] = JSON.parse(fs.readFileSync(process.env.BENCH_CATALOG || '/tmp/catalog.json', 'utf8'))
  const byId = new Map(skills.map(s => [s.id, s.name]))
  console.log(`目录 ${skills.length} 个技能\n`)

  const cfg = currentLlmConfig()
  let fail = 0
  for (const c of CASES) {
    const picked = await routeSkillsByIntent(c.q, skills as any, cfg)
    const names = picked.map(id => byId.get(id) || id)
    const hit = c.want === null ? names.length === 0 : names.includes(c.want)
    if (!hit) fail++
    console.log(`${hit ? '✓' : '✗'} "${c.q}"\n    期望=${c.want ?? '不走技能'}  实际=[${names.join(', ') || '—'}]`)
  }
  console.log(`\n${fail === 0 ? '✅ 路由全通' : `❌ ${fail}/${CASES.length} 不符`}`)
  process.exit(fail === 0 ? 0 : 1)
})()
