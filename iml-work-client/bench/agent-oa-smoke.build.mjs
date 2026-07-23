// 打包 agent×mock-oa E2E 为 CJS，在**真 Electron**下运行。agent-loop 是纯叶子、agent-browse 依赖 electron，
// llm 仅 type-only 导入(esbuild 擦除，不引入 db)。与 browse-oa-smoke.build.mjs 同构。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

await build({
  entryPoints: [path.join(BENCH, 'agent-oa-smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/agent-oa-smoke.cjs'),
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws', 'playwright'],
  logLevel: 'info',
})
console.log('agent-oa-smoke bundle OK → node_modules/.bench/agent-oa-smoke.cjs')
