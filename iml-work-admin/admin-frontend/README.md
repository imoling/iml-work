# iML Work · 管理端前端 (admin-frontend)

企业管理后台的 Web 前端：React 18 + TypeScript + Vite。承载用户/角色权限、专家(岗位)与技能治理、
知识库、模型网关、本体只读治理、执行审计(Trace)等管理能力。

## 技术栈

- React 18 + TypeScript (`strict`)
- Vite 5（dev server `:3000`，`/api` 代理到后端）
- 无额外状态库/数据层：目前为原生 `fetch` + `useState`（见 `src/auth.tsx` 的鉴权注入）

## 运行

```bash
npm install

# 开发（http://localhost:3000，/api 代理到后端）
npm run dev

# 类型检查 + 生产构建
npm run build

# 预览构建产物
npm run preview
```

## 配置

- 后端地址：开发期由 Vite 代理转发 `/api` → 后端。代理 target 可用环境变量覆盖：

  ```bash
  # .env（见 .env.example）
  VITE_ADMIN_BASE_URL=http://localhost:8080
  ```

  生产部署时由反向代理(nginx 等)将 `/api` 转发到后端，前端只发相对路径。

## 登录

统一账户体系（后端 `/api/v1/auth`）。开发种子账号见后端 `AuthSeeder`（如超管 `admin`）。
JWT 存于前端，`src/auth.tsx` 拦截 `fetch` 自动注入 `Authorization`。

## 目录

- `src/components/*` — 各管理模块（用户、技能中心、知识库、沙箱、本体、审计等）
- `src/auth.tsx` — 鉴权上下文 + fetch 拦截
- `src/permissions.ts` — 权限点常量
- `src/App.tsx` — 侧栏 + 按权限渲染的 Tab 导航
