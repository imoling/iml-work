# iML Work 客户端 ↔ 管理后端 对接说明

本文档描述 Electron 客户端（`iml-work-client`）与运营管理后端（`iml-work-admin/admin-backend`，Spring Boot + PostgreSQL/pgvector）之间的对接契约与数据流。

## 配置

| 配置项 | 存储位置 | 默认值 | 用途 |
| :--- | :--- | :--- | :--- |
| `adminBaseUrl` | SQLite `config` 表 | `http://localhost:8080` | 管理后端根地址（专家领用 / RAG / 同步 / 心跳） |
| `llm-base-url` | SQLite `config` 表 | `http://localhost:8080/api/v1/model` | 统一模型网关 Base URL |
| `llm-connection-mode` | SQLite `config` 表 | `proxy` | `proxy`=走企业网关，`direct`=厂商直连 |
| `clientId` | SQLite `config` 表 | 首次启动自动生成 `node-xxxx` | 客户端心跳唯一标识 |
| `kbScope:<expertId>` | SQLite `config` 表 | 领用时下发 | 该岗位获授权的知识库检索范围 |

> 在「设置中心 → 大模型配置」可视化修改 `adminBaseUrl`，并用「指向网关」按钮一键把模型 Base URL 设为 `{adminBaseUrl}/api/v1/model`。

## 五条对接链路

### 1. 统一模型网关 (DLP 脱敏 + Token 审计)
- 触发：`connection-mode = proxy` 时，客户端所有 LLM 调用（`callLlm` 与简单问答路径）。
- 调用：`POST {llm-base-url}/chat`，body `{ model, messages }`，`Authorization: Bearer <apiKey>`。
- 后端：`ModelProxyController` 对手机号/身份证做 DLP 脱敏后转发上游，并累加 Token 统计；未配置真实 key 时返回演示响应。
- 解析：读取 `choices[0].message.content`。

### 2. 岗位专家领用 (技能 + 知识库范围下发)
- 触发：`expert:claim` IPC。
- 调用：`POST {adminBaseUrl}/api/v1/experts/claim/{expertId}`。
- 返回：`{ success, skillsSynced[], knowledgeScope[] }`。
- 客户端：把 `skillsSynced` 写入物理 `skills/` 目录；把 `knowledgeScope` 持久化到 `kbScope:<expertId>` 并注入 Agent 系统提示词；记录 `lastClaimedExpertId` 供心跳上报。
- 离线降级：后端不可达时回退本地 `skills/` 目录扫描。

### 3. 公司级 RAG 融合检索 (真实 pgvector)
- 触发：`agent:send-message` 构建 prompt 前。
- 调用：`GET {adminBaseUrl}/api/v1/knowledge/query?text=...&topK=3&categories=<kbScope>&clientId=<expertId>`。
- 后端：按 `categories` 限定范围做 pgvector 余弦检索，并记录检索命中率审计。
- 客户端：`queryCorporateKnowledge()` 取回条款，`buildCorporateRagBlock()` 渲染为「公司级知识库检索结果」块，与本地个人记忆/岗位 SOP **融合**进上下文；执行抽屉实时打印命中条数与相似度。
- 访问隔离：未在 `kbScope` 内的知识类目不会被该岗位检索到。
- 离线降级：失败返回空，Agent 退回本地上下文作答。

### 4. 个人文件自动同步 (FileSyncService · chokidar)
- 监听：`chokidar` 监听客户端 `documents/` 目录（`add` / `change`）。
- 差量：对文件做 MD5，与 `fhash:<name>` 比对，未变更则跳过。
- 调用：变更文件经 `multipart` 上传到 `POST {adminBaseUrl}/api/v1/sync/upload`（file / path / summary / employee）。
- 事件：通过 IPC `filesync:event` 向渲染端推送 `detected/syncing/synced/error` 状态。
- 离线降级：上传失败标记为「仅本地」，不阻塞。

### 5. 客户端心跳 (沙箱状态上报)
- 周期：启动时 + 每 30 秒。
- 调用：`POST {adminBaseUrl}/api/v1/clients/heartbeat`，body `{ clientId, hostname, expertId, expertName, sandboxMode, pyodideHealthy, imCommandCount, appVersion }`。
- 后端：`ClientController` upsert 节点；`GET /api/v1/clients` 返回列表并按 `lastSeen` 90s 窗口标记在线。
- 管理端：SandboxManager「在线客户端节点」表实时展示。

## 后端依赖前置

客户端对接需要 admin-backend 在线（默认 `:8080`）。启动方式见 [admin-backend/README.md](../iml-work-admin/admin-backend/README.md)。所有链路均做了离线优雅降级，后端不可用时客户端仍可用本地能力运行。

## 运行前提与已知问题

### 主进程必须以 CommonJS 打包
本包是 `"type": "module"`，若把 Electron 主进程打成 ESM，会在运行时报
`The requested module 'electron' does not provide an export named 'BrowserWindow'`，且 `__dirname` 为 undefined，应用无法启动。
`vite.config.ts` 已将主进程固定为 **CommonJS 输出**（`lib.formats: ['cjs']` → `main.cjs`，`package.json` 的 `main` 指向 `dist-electron/main.cjs`，并把 `electron`/`better-sqlite3`/Node 内建模块全部 external）。改动构建配置时请保持这一点。

### 原生模块需为 Electron ABI 重建
`better-sqlite3` 是原生模块，必须用 Electron 的 ABI 重建，否则启动即 `NODE_MODULE_VERSION` 不匹配：
```bash
npx electron-rebuild -f -w better-sqlite3
```

### 运行依赖可用的 Electron 运行时
`npm run dev`（或打包后 `electron .`）需要 node_modules 内为**真实可用的 Electron 二进制**。可用以下命令自检——正常应输出 `v30.x`：
```bash
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --version   # macOS
```
若输出的是 Node 版本号（如 `v20.x`）或运行时 `require('electron').app` 为 `undefined`，说明该环境的 Electron 二进制是桩/损坏的，GUI 无法拉起；请在具备正常 Electron 运行时的机器上运行。FileSyncService 与心跳会在主进程 `app.whenReady()` 时自动启动，无需额外操作。
