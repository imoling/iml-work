# 开发与启动指南

从零把 iML Work 全栈跑起来的说明：环境准备 → 一键启动 → 初始账号与预置数据 → 模型接入 → 验证命令 → 常见坑。生产部署见文末。

## 环境准备

| 依赖 | 版本 | 说明 |
|---|---|---|
| Java | 21 | 后端。macOS 推荐 `brew install openjdk@21`（`scripts/dev.sh` 会自动识别 Homebrew 路径） |
| Maven | 3.9+ | 后端构建 |
| Node.js | 20+ | 管理前端 / 两个 Electron 桌面端 / Mock OA |
| PostgreSQL | 17 + pgvector | 没有本机 PG 也行：`dev.sh` 检测到 Docker 会自动 `docker compose up` 拉起（配置在 `iml-work-admin/admin-backend/docker-compose.yml`） |
| Docker | 可选 | 代码沙箱、docling 文档解析、bge-m3 向量模型三个基础服务用；不装也能跑，对应能力降级 |

各目录先 `npm install`（`iml-work-admin/admin-frontend`、`iml-work-client`、`iml-fde-studio`、`iml-mock-oa`）。

## 一键启动

```bash
bash scripts/dev.sh
```

依次拉起 PostgreSQL(pgvector) → 后端 → 管理前端 → Mock OA，日志落在 `.devlogs/`。桌面端是 Electron 应用，各自单独启动：

```bash
cd iml-work-client && npm run dev     # 员工桌面客户端（分身本体）
cd iml-fde-studio  && npm run dev     # FDE 技能工作台
```

| 服务 | 地址 |
|---|---|
| 管理后台 | http://localhost:3000 |
| 后端 API / Swagger | http://localhost:8080/api/v1 · `/swagger-ui.html` |
| Mock OA / CRM / ERM | http://localhost:8090 / 8091 / 8092（登录任意账号密码） |
| PostgreSQL | localhost:5432，库/用户/密码均为 `imlwork` |

沙箱、docling、bge-m3 向量模型跑在 Docker 上，可选但推荐：

```bash
bash scripts/docker-services.sh up
```

> ⚠️ 向量模型（bge-m3）缺失时系统**不报错**，知识检索会静默退化成字面匹配。部署后先在管理端「知识中心」验证一次语义检索。

## 初始账号与预置数据

首次启动、库为空时自动播种（幂等，重启不会重复）：

| 账号 | 密码 | 角色 | 用途 |
|---|---|---|---|
| `admin` | `admin123` | 超级管理员 | 登录管理后台（http://localhost:3000） |
| `demo` | `demo123` | 员工 + FDE | 登录桌面客户端与 FDE 工作台 |

> 这是**开发默认口令**，任何对外可达的部署都必须改掉。`prod` profile 下不播 demo 账号，且必须显式配置 `security.initial-admin-password`，否则拒绝启动。

随账号一起播种的演示数据：

- **一个演示岗位**「通用工作助理」，绑定全部预置技能，客户端用 `demo` 登录认领即可体验完整能力面。
- **9 个系统预置技能**（种子在 `admin-backend/src/main/resources/seed/builtin-skills.json`，任何环境都会播种，界面上不可删除）：

  | 技能 | 作用 |
  |---|---|
  | 深度调研 | 联网多轮检索 + 结构化调研报告（客户端内置引擎） |
  | A股分析 | 行情 / K线 / 研报 / 资金面等真实取数分析（沙箱执行） |
  | docx / pptx / xlsx / pdf | 四类办公文档的生成与编辑（沙箱执行） |
  | image-gen / video-gen | 图片 / 视频生成（走模型网关多媒体通道） |
  | skill-creator | 把重复性工作沉淀成新技能的「造技能」方法论包 |

- **本体建模示例**：OA 审批域 + CRM 商机域的对象 / 状态机 / 动作定义（只有 Schema，无实例数据），与 Mock OA/CRM 页面一一对应，开箱即可演示「审批合同」「推进商机」全链路。
- 演示知识库 3 篇、Mock 业务系统登记（OA/CRM/GitHub）、3 个未填密钥的模型通道示例。

## 模型接入

分身要真干活需要接一个大模型，两条路任选：

1. **企业中转站（推荐）**：管理后台 →「模型网关」，在演示通道里填上你的厂商 API Key（DeepSeek / OpenAI 兼容接口均可）。客户端登录后自动以登录身份走中转站，**零配置**。
2. **客户端自配直连**：客户端「设置 → 模型服务」选择厂商、填自己的 Key（管理端可用开关禁止员工自配）。

RAG 语义检索默认接本机 Ollama 的 bge-m3（`EMBED_ENDPOINT` 可改指任意 OpenAI 兼容 `/embeddings` 服务）。

## 验证命令（改完代码的真值校验)

| 端 | 命令 |
|---|---|
| 后端 | `cd iml-work-admin/admin-backend && mvn -o clean compile`（**必带 `clean`**，增量编译会假通过） |
| 客户端 | `cd iml-work-client && npx tsc --noEmit && npm run build && npm test` |
| 管理前端 | `cd iml-work-admin/admin-frontend && npm run build` |

## 常见坑

- **客户端 dev 偶发报 `Cannot use import statement outside a module`**：`vite-plugin-electron` 打包竞态，非逻辑 bug。清缓存重启：`rm -rf node_modules/.vite dist dist-electron && npm run dev`。
- **后台脚本里启动 Electron**：必须 `env -u ELECTRON_RUN_AS_NODE npm run dev`，否则 `app.getPath` 报 undefined。
- **better-sqlite3 报 `incompatible architecture`**：交叉打包后原生模块架构错位，`npx electron-builder install-app-deps --arch arm64`（按本机架构）重编。
- **模型调用需要代理时**：Java `HttpClient` 只认 `-Dhttp(s).proxyHost` 系统属性、不读 `HTTP_PROXY`；`dev.sh` 已自动透传 shell 代理给后端 JVM。
- **npm 装包 / 镜像拉取挂死**：本机 HTTP 代理常是元凶，`env -u HTTP_PROXY -u HTTPS_PROXY` 摘掉再试，Electron 镜像可用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 生产部署

- 配置模板：`iml-work-admin/admin-backend/deploy/application.yml.example`（数据库、JWT/HMAC 密钥、初始超管口令、CORS——`prod` 下缺失或过弱直接拒启动）。
- 后端打包：`bash scripts/package-backend.sh`；基础服务容器化：`bash scripts/docker-services.sh`。
- 安全红线（代码层已强制）：凭证与登录态只留员工本机；本体只存 Schema 与对象引用；写操作须人工确认 + 一次性签名令牌；密钥经环境变量 / 外置配置注入，不进仓库。
