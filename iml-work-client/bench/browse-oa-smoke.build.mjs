// 打包 browse×mock-oa 冒烟为 CJS，在**真 Electron**(不桩 electron)下运行。与 browse-smoke.build.mjs 同构。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

await build({
  entryPoints: [path.join(BENCH, 'browse-oa-smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/browse-oa-smoke.cjs'),
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws', 'playwright'],
  logLevel: 'info',
})
console.log('browse-oa-smoke bundle OK → node_modules/.bench/browse-oa-smoke.cjs')
