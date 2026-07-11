import { defineConfig } from 'vite'
import { builtinModules } from 'module'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'path'

// 主进程必须外部化的运行时依赖：原生/可选模块（playwright、桌面录制回放）+ node 内建。
// 保证 main 以 CommonJS 产出、这些包在运行时从 node_modules 加载（与客户端 iml-work-client 一致）。
const mainExternals = [
  'electron',
  'playwright',
  'uiohook-napi',
  '@nut-tree-fork/nut-js',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

// 与客户端一致：用 vite-plugin-electron，`npm run dev` 一条命令连 Electron 窗口一起拉起。
// 与客户端一致：主进程代码在 src/main/（main.ts + preload.ts + ipc/* + automation.ts），
// 渲染层在 src/renderer/；主进程构建产物统一落 dist-electron/、渲染层落 dist/。
const MAIN = path.resolve(__dirname, 'src/main')
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [
    react(),
    electron({
      main: {
        entry: path.resolve(MAIN, 'main.ts'),
        vite: {
          build: {
            outDir: path.resolve(__dirname, 'dist-electron'),
            emptyOutDir: false,
            lib: {
              entry: path.resolve(MAIN, 'main.ts'),
              formats: ['cjs'],
              fileName: () => 'main.cjs',
            },
            rollupOptions: { external: mainExternals },
            // automation.ts 里仍有惰性 require()，需让 commonjs 插件转换源码里的 require，
            // 否则会被当外部依赖留在产物里、运行时找不到。
            commonjsOptions: { include: [/\.js$/, /\.ts$/, /node_modules/] },
          },
        },
      },
      preload: {
        input: path.resolve(MAIN, 'preload.ts'),
        vite: {
          build: {
            outDir: path.resolve(__dirname, 'dist-electron'),
            emptyOutDir: false,
            rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } },
          },
        },
      },
    }),
  ],
  // 5174：客户端 vite 占 5173，FDE 固定 5174，两端可同时开发
  server: { port: 5174, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
