// 对话装技能工具的冒烟：走**真实生产路径** install_skill.run() → 真后端 → 真 GitHub。
// 验三段：① 权限判定选对落点 ② 预检信息能解析出来 ③ 签字确认后真落库待审。
//
// 签字闸不绕过，真实走完：无头环境没有渲染层来签字，用 runInContext 自持 runId +
// 轮询 resolveForm 扮演"人在屏幕前点了确认"，令牌签发/校验/消费全程照跑。
// 跑法：node bench/skill-install-smoke.build.mjs && node node_modules/.bench/skill-install-smoke.mjs
import { makeInstallSkillTool } from '../src/main/skill-install'
import { runInContext, resolveForm } from '../src/main/automation-runtime'
import { configSet } from '../src/main/db'   // bench 里解析到 stubs/stub-db（内存 KV）

/** 喂登录态权限点：工具据此决定落点（管理端目录 DRAFT / 员工待审）。 */
function actAs(perms: string[]): void {
  configSet('auth-user', JSON.stringify({ permissions: perms }))
}

const URL_OK = process.env.BENCH_SKILL_URL || 'https://github.com/op7418/Humanizer-zh'
const log = (t: string, x: string) => console.log(`  ·[${t}] ${x}`)

async function callTool(url: string, sign: boolean): Promise<string> {
  const runId = `install-smoke-${sign ? 'sign' : 'cancel'}`
  return runInContext(runId, async () => {
    // sign=true 扮演签字确认；sign=false 扮演用户取消（cancelForm 语义：空对象）
    const signer = setInterval(() => resolveForm(runId, sign ? { _ok: '1' } : {}), 300)
    try {
      return await makeInstallSkillTool().run({ url, reason: '冒烟测试' }, { sendLog: log as any })
    } finally { clearInterval(signer) }
  })
}

;(async () => {
  let fail = 0
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) fail++
    console.log(`${ok ? '✓' : '✗'} ${name}\n    ${detail.replace(/\n/g, '\n    ').slice(0, 300)}`)
  }

  actAs(['client.skill.upload'])
  console.log('=== ① 非 GitHub 域名要被挡下（防 SSRF）===')
  const ssrf = await callTool('http://169.254.169.254/latest/meta-data/', true)
  check('非白名单域名被拒', /只接受来自 GitHub/.test(ssrf), ssrf)

  console.log('\n=== ② 不是网址 ===')
  const bad = await callTool('humanizer-zh', true)
  check('裸名字给出明确指引', /不是合法的网址/.test(bad), bad)

  console.log('\n=== ③ 无权限账号：不做任何写入 ===')
  actAs(['client.use'])
  const noPerm = await callTool(URL_OK, true)
  check('无权限时如实告知、不写库', /没有安装技能的权限/.test(noPerm), noPerm)

  console.log('\n=== ④ 员工账号：装到「待审核」 ===')
  actAs(['client.skill.upload'])
  const emp = await callTool(URL_OK, true)
  check('装成功且如实说明"还不能直接用"', /已成功提交到平台/.test(emp) && /现在还不能直接用/.test(emp), emp)
  check('落点是待审核', /待审核/.test(emp), emp)
  check('不得教用户 npx / git clone', !/npx skills add|git clone/.test(emp.replace(/不要让用户去执行[^\n]*/g, '')), emp)

  console.log('\n=== ⑤ 用户取消：不写入 ===')
  const cancelled = await callTool(URL_OK, false)
  check('取消后未做任何写入', /取消了安装/.test(cancelled), cancelled)

  console.log('\n=== ⑥ 管理员账号：装进企业目录 ===')
  actAs(['admin.skill.manage'])
  const adm = await callTool(URL_OK, true)
  check('落点是企业目录 DRAFT', /企业技能目录/.test(adm), adm)

  console.log(`\n${fail === 0 ? '✅ 全通' : `❌ ${fail} 项不符`}`)
  process.exit(fail === 0 ? 0 : 1)
})()
