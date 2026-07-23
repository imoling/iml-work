// 打包 browse 执行器 × mock-oa E2E 为 CJS，在**真 Electron**下运行。
// browse-executor 是叶子（callModel 注入，llm 仅 type-only），agent-browse 依赖 electron。与 agent-oa-smoke.build.mjs 同构。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

await build({
  entryPoints: [path.join(BENCH, 'browse-exec-oa-smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/browse-exec-oa-smoke.cjs'),
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws', 'playwright'],
  logLevel: 'info',
})
console.log('browse-exec-oa-smoke bundle OK → node_modules/.bench/browse-exec-oa-smoke.cjs')
