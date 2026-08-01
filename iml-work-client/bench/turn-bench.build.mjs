// 打包 TurnEngine 基准 harness：electron→桩、src/main/db→桩，其余真实模块（turn-engine/turn-tools/llm callLlmTools…）原样打进。
// 与 bench/build.mjs 同构，只换 entry。产物 node_modules/.bench/turn-bundle.mjs。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')
const dbStubPlugin = {
  name: 'db-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/db$/ }, (args) => {
      if (args.resolveDir.includes(path.join('src', 'main'))) return { path: path.join(BENCH, 'stubs/stub-db.ts') }
      return null
    })
  },
}
await build({
  entryPoints: [path.join(BENCH, 'turn-bench-agent.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/turn-bundle.mjs'),
  alias: { electron: path.join(BENCH, 'stubs/stub-electron.ts') },
  plugins: [dbStubPlugin],
  external: ['playwright', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws'],
  logLevel: 'info',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
})
console.log('turn-bundle OK → node_modules/.bench/turn-bundle.mjs')
