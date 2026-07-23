// 打包结构化感知冒烟为 CJS，在真 Electron 下运行。browser-scripts 是纯字符串常量模块。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

await build({
  entryPoints: [path.join(BENCH, 'struct-perception-smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/struct-perception-smoke.cjs'),
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws', 'playwright'],
  logLevel: 'info',
})
console.log('struct-perception-smoke bundle OK → node_modules/.bench/struct-perception-smoke.cjs')
