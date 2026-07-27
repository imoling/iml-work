import { defineConfig } from 'vite'
import { builtinModules } from 'module'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// electron + better-sqlite3 + all node builtins must stay external (required at
// runtime), so the main bundle can be emitted as plain CommonJS.
const mainExternals = [
  'electron',
  'electron-updater',
  'better-sqlite3',
  // pdfjs is ESM-only and heavy; keep external and load via runtime import().
  'pdfjs-dist',
  'pdfjs-dist/legacy/build/pdf.mjs',
  // playwright is optional (only used when configured + browser installed).
  'playwright',
  // 远程控制机器人官方 SDK：长连接 + 动态 require，保持外部化在运行时从 node_modules 加载。
  '@larksuiteoapi/node-sdk',
  'dingtalk-stream',
  'qq-official-bot',
  'ws',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Main process entry. Emit CommonJS (.cjs) so Electron can require the
        // `electron` builtin — the package is "type": "module", so a .js main
        // would be treated as ESM and `import { BrowserWindow } from 'electron'`
        // fails at runtime.
        //
        // ⚠️ 真根因（读插件源码坐实）：vite-plugin-electron 按 package.json "type":"module"
        // 给 main 默认 lib.formats=['es']；此处若再配 lib.formats=['cjs']，mergeConfig 对数组是
        // **拼接** → ['es','cjs'] 两份产物都按 fileName 写成 main.cjs → 谁后落盘谁赢 = dev 偶发
        // "Cannot use import statement outside a module"。修法与 preload 同款（它从不炸）：
        // lib:false 禁掉插件的 ES 默认管线，用 input 单管线 + output 强制 CJS。
        entry: 'src/main/main.ts',
        vite: {
          build: {
            lib: false,
            rollupOptions: {
              input: 'src/main/main.ts',
              external: mainExternals,
              output: {
                format: 'cjs',
                inlineDynamicImports: true,
                entryFileNames: 'main.cjs',
              },
            },
          },
        },
      },
      preload: {
        // Preload entry
        input: 'src/main/preload.ts',
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: '[name].js',
              },
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
