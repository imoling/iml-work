// 打包 M4 任务集 harness 为 CJS，真 Electron 下运行。child_process 走 node 内置(external)。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

await build({
  entryPoints: [path.join(BENCH, 'agent-oa-suite.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/agent-oa-suite.cjs'),
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws', 'playwright'],
  logLevel: 'info',
})
console.log('agent-oa-suite bundle OK → node_modules/.bench/agent-oa-suite.cjs')
