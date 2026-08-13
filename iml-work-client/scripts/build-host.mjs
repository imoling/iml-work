// 打包 Web 宿主：src/host/host.ts → dist-host/host.cjs（node dist-host/host.cjs 直接跑）。
// 独立 esbuild 管线，不碰 vite-plugin-electron（绕开 dev 下 main.cjs 被编成 ESM 的已知竞态）。
// external 与 vite.config 的 mainExternals 同口径：原生/重型/动态 require 的包运行时从 node_modules 解析。
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))

await build({
  entryPoints: [path.join(ROOT, 'src/host/host.ts')],
  outfile: path.join(ROOT, 'dist-host/host.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  external: [
    'electron',
    'electron-updater',
    'better-sqlite3',
    'pdfjs-dist',
    'pdfjs-dist/legacy/build/pdf.mjs',
    'playwright',
    '@larksuiteoapi/node-sdk',
    'dingtalk-stream',
    'qq-official-bot',
    'ws',
    // chokidar v5 是 ESM-only：与 vite 主进程管线同口径**打进包**（external 会让 CJS require 炸 ERR_REQUIRE_ESM）
  ],
  define: {
    'process.env.IML_APP_VERSION': JSON.stringify(pkg.version),
  },
  logLevel: 'info',
})
console.log('[build-host] dist-host/host.cjs 就绪；启动：npm run start:host')
