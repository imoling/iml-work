// 一键起三套演示系统：OA(:8090) + CRM(:8091) + ERM(:8092)。任一子进程退出则整体退出（便于 dev.sh 托管）。
const { spawn } = require('child_process')
const path = require('path')

const servers = [
  ['OA ', 'server.js'],
  ['CRM', 'crm-server.js'],
  ['ERM', 'erm-server.js'],
]
const children = servers.map(([tag, file]) => {
  const p = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', d => process.stdout.write(`[${tag}] ${d}`))
  p.stderr.on('data', d => process.stderr.write(`[${tag}] ${d}`))
  p.on('exit', code => { console.error(`[${tag}] 进程退出(${code})，停止全部`); children.forEach(c => { try { c.kill() } catch (_) { /* 已退出 */ } }); process.exit(code || 1) })
  return p
})
process.on('SIGINT', () => children.forEach(c => c.kill('SIGINT')))
process.on('SIGTERM', () => children.forEach(c => c.kill('SIGTERM')))
