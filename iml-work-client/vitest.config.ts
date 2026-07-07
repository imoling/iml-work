import { defineConfig } from 'vitest/config'

// 单元测试：只测主进程纯逻辑与渲染层状态机（不启 electron）。
// 覆盖 bug 高发点：多会话状态迁移、迭代编辑文件提取、路由 prompt/解析。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',   // 只测纯逻辑/状态机；window.api 在测试里手动桩
  },
})
