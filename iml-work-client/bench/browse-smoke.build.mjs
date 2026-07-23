// 打包 browse 冒烟为 CJS，在**真 Electron**（不桩 electron）下运行。
// 与 build.mjs 的关键区别：electron 不 alias 成桩（用真的）、db 不桩（agent-browse 依赖链不含 db）。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

await build({
  entryPoints: [path.join(BENCH, 'browse-smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/browse-smoke.cjs'),
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws', 'playwright'],
  logLevel: 'info',
})
console.log('browse-smoke bundle OK → node_modules/.bench/browse-smoke.cjs')
