// 打包「对话装技能」冒烟。与 build.mjs 的唯一区别：db 桩的拦截范围要更宽——
// harness 自己也要 import configSet 来切换登录态权限（测两条落点分支），
// 而它在 bench/ 目录下写的是 `../src/main/db`，原插件只拦 src/main 内部的 `./db`，
// 漏掉就会加载真 better-sqlite3（Electron ABI，纯 Node 下直接崩）。
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(BENCH, '..')

const dbStubPlugin = {
  name: 'db-stub',
  setup(b) {
    // `./db`（src/main 内部）与 `../src/main/db`（bench 里）都指向同一个桩
    b.onResolve({ filter: /(^\.\/db$|src[\\/]main[\\/]db$)/ }, (args) => {
      if (args.resolveDir.includes(path.join('src', 'main')) || args.resolveDir === BENCH) {
        return { path: path.join(BENCH, 'stubs/stub-db.ts') }
      }
      return null
    })
  },
}

await build({
  entryPoints: [path.join(BENCH, 'skill-install-smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(CLIENT, 'node_modules/.bench/skill-install-smoke.mjs'),
  alias: { electron: path.join(BENCH, 'stubs/stub-electron.ts') },
  plugins: [dbStubPlugin],
  external: ['playwright', 'better-sqlite3', 'pdfjs-dist', 'chokidar', 'electron-updater', '@larksuiteoapi/node-sdk', 'dingtalk-stream', 'qq-official-bot', 'ws'],
  logLevel: 'info',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
})
console.log('bundle OK → node_modules/.bench/skill-install-smoke.mjs')
