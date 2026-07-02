import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 后端地址：开发代理 target 走环境变量，默认本地 8080。生产由反向代理转发 /api，无需此项。
const ADMIN_BASE_URL = process.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: ADMIN_BASE_URL,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
