// 打包 bench harness：electron → 桩、src/main/db → 桩，其余真实管线模块原样打进 bundle。
// 产物 node_modules/.bench/bundle.mjs（gitignored）；external 包运行时从 node_modules 解析。
// 仓库内相对路径，任意机器可跑（无绝对路径）。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))       // iml-work-client/bench
const CLIENT = path.resolve(BENCH, '..')                        // iml-work-client

const dbStubPlugin = {
  name: 'db-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/db$/ }, (args) => {
      if (args.resolveDir.includes(path.join('src', 'main'))) {
        return { path: path.join(BENCH, 'stubs/stub-db.ts') }
      }
      return null
    })
  },
}

await build({
  entryPoints: [path.join(BENCH, 'bench-agent.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/bundle.mjs'),
  alias: { electron: path.join(BENCH, 'stubs/stub-electron.ts') },
  plugins: [dbStubPlugin],
  external: ['playwright', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws'],
  logLevel: 'info',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
})
console.log('bundle OK → node_modules/.bench/bundle.mjs')
