import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Electron 下用相对路径加载构建产物（file://），产物输出到 dist/
export default defineConfig({
  root: path.resolve(__dirname, 'src'),
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
})
