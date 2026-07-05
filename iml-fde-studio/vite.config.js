import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Electron 下用相对路径加载构建产物（file://），产物输出到 dist/
export default defineConfig({
  root: path.resolve(__dirname, 'src'),
  base: './',
  plugins: [react()],
  // 5174：客户端(iml-work-client)的 vite 占用默认 5173，FDE 固定 5174，两端可同时开发
  server: { port: 5174, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
})
