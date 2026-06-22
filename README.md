# iML Work — 企业级智能助理与自动化协同工作流系统

<p align="left">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT">
  <img src="https://img.shields.io/badge/platform-Electron-lightgrey.svg" alt="Platform Electron">
  <img src="https://img.shields.io/badge/framework-React_18-61dafb.svg" alt="Framework React">
  <img src="https://img.shields.io/badge/backend-Spring_Boot_3-6db33f.svg" alt="Backend Spring Boot">
</p>

`iML Work` 是一个面向企业内网环境的极致简洁、安全高效的「工作分身」智能体与自动化协同系统。项目采用 **Monorepo** 架构统一管理，集成了桌面工作分身客户端、无头浏览器 / 桌面 RPA 驱动、本地隔离沙箱、企业模型中转站与全链路审计的 SaaS 管理平台，以及面向 FDE 的现场技能构建工具。

> 分工原则：**管理平台定义、客户端执行、FDE 工作台构建**。登录态/凭据只在本地，技能内容只含步骤与脚本、绝不含登录态。

---

## 📂 项目结构 (Project Structure)

本仓库采用多包单仓管理（Monorepo）结构，包含三大核心子系统：

```
iml-work/
├── iml-work-client/          # 🖥️ Electron 工作分身客户端（执行）
│   ├── skills/               # 本地物理智能体技能定义 (YAML Frontmatter + SOP)
│   ├── src/main/             # Electron 主进程 (Harness 引擎、语义脚本解释器、SQLite、本地技能解析)
│   └── src/renderer/         # React 渲染层 (Execution Drawer、MarkdownRenderer、确认表单卡片)
├── iml-work-admin/           # ⚙️ SaaS 运营管理平台（定义与下发）
│   ├── admin-frontend/       # React 后台前端（岗位/技能中心/模型中转站/业务系统/知识库/审计追溯）
│   └── admin-backend/        # Java 21 / Spring Boot 3 / PostgreSQL 17 + pgvector
└── iml-fde-studio/           # 🛠️ FDE 工作台（Electron + Vite/React 多页应用，技能构建工具）
    └── src/pages/            # 系统连接 / 技能构建 / 技能测试 / 场景库 / 模板库…
                              # 录制 → 自动生成语义化技能(SOP+描述+直达路由) → 一段话链路测试 → 上架到管理平台
```

---

## 💡 FDE 工程师赋能与企业落地价值 (FDE Value & Enablement)

对于**前线部署工程师 (FDE)** 而言，`iML Work` 是快速攻坚企业内网数字化、“最后一公里”业务流程自动化的现场集成利器，具有不可替代的核心价值：

*   🚀 **极速低代码 SOP 物理化落地**：FDE 无需二次开发客户端，只需将客户现存的业务 PDF/Word 文档或规章制度转化为包含 YAML 头部属性的 `SKILL.md`，放入物理 `skills/` 子目录下，即可让特定岗位的智能体瞬间激活对应的业务 SOP，大幅度缩短交付周期。
*   🔗 **免接口内网穿透（RPA 零改造对接）**：面对企业内部缺乏开放 API 接口的传统老旧业务系统（如内网 OA、财务记账、ERP 客户端等），FDE 可以通过预设的 Playwright (RPA 网页驱动) 与 nut-js (系统级模拟) 进行零代码改造级别对接。通过 `storageState` 机制捕获并持久化会话凭证，实现“首次登录，终身免密静默穿透”。
*   🔒 **纯内网高安全级别合规保障**：
    *   **离线向量存储**：基于本地 `transformers.js` (ONNX bge-small) 在客户端主进程实现 100% 离线文本向量化与 SQLite 本地检索，保证用户的个人记忆、敏感业务数据及敏感对话永不出网，满足严苛的内网合规标准。
    *   **安全沙箱隔离**：内置 Pyodide WASM 与 Docker 本地双隔离沙箱。当执行数据分析脚本时，数据与运行环境在物理隔离的沙箱内强杀，防范非法脚本对客户宿主机文件系统的破坏与污染。
*   👁️ **交互式人机协同与调试 (Human-in-the-Loop)**：
    *   执行抽屉内嵌黑底绿字的实时 Terminal，方便 FDE 现场直接捕获并排查自动化脚本底层的 stdout 错误。
    *   当脚本遭遇未定义参数、验证码或涉及“删除/高风险”敏感操作时，系统能自动挂起并向用户弹出防嵌套警告的 React 表单或敏感权限口令验证表单，确保在 FDE 离场后系统的运行安全防线不失守。

---

## ✨ 核心特性 (Key Features)

### 1. “执行抽屉”交互设计 (Execution Drawer)
*   **清爽对话流**：主聊天区域仅渲染用户发言与智能体的最终富文本回答，不让冗余的调试日志影响视觉重心。
*   **自适应弹起**：在智能体进入 ReAct 推理时，执行抽屉自适应滑动展开，黑底绿字实时流式打印 CoT 思考过程（Thought）、Action 执行动作以及沙箱 Python/Playwright 执行的底层 stdout 运行日志。

### 2. 本地物理技能规范与角色控制 (Physical Skills & Allowed Roles)
*   **纯文本技能定义**：技能物理存放在 `skills/` 目录下，仅需一个 `SKILL.md` 文档及头部 YAML 元数据即可唤醒。
*   **多维度角色隔离**：主进程解析 `allowed_roles`（如 `expert-1`, `expert-2`），在员工领用岗位助手时差量下载、动态加载并过滤出该专家专享的技能，严防越权调用。

### 3. 高性能富文本渲染与原生交互
*   **防 DOM 嵌套警告设计**：自研 `MarkdownRenderer` React 组件。在解析图片时强行使用行内元素 `<span>`（display: inline-block）而非 `<div>` 作为段落 `<p>` 内部容器，彻底解决 React 嵌套报错。
*   **本地文件一键唤醒**：深度拦截 Markdown 链接，若匹配本地文件 `file://` 协议，调用 Electron `shell.openPath` 原生唤醒系统关联程序直接双击打开对应物理文件（如 PDF、Word）。
*   **避障机制**：在主进程与大模型交互时，将大图 Base64 缩略压缩并由占位符 `[IMAGE_PLACEHOLDER_PNG]` 替代，避免 LLM Token Window 爆表，响应完毕后再回写替换，保证了截图的急速高清载入。

### 4. 企业模型中转站与全链路审计
*   **模型中转站**：管理端登记多家模型供应商（厂商预设卡片自动填上游端点/模型），平滑加权轮询 + 故障转移，统一网关 `POST /api/v1/model/chat` 供客户端与管理平台内部统一调用；岗位/技能的 **AI 生成**亦经此网关。
*   **审计追溯 (Agent Trace) + 一键脱敏**：记录终端/用户/问题/模型/推理/技能/是否联网的全链路（Trace/Span/Event）；分级脱敏规则 D1–D15、级别 L1–L3、模式 轻度/标准/强；按角色查看、留痕、导出。
*   **联网检索**：岗位可开启"联网"能力，由大模型**自主研判**是否需要联网；检索前做查询改写（把"我们公司"替换为真实企业名）以防幻觉，检索→抓取头部结果→提取正文→带 Markdown 来源综合。

### 5. 语义脚本技能与 FDE 工作台（录制 → 自动成技能 → 一段话测试 → 上架）
*   **语义脚本技能（取代脆弱 RPA 回放）**：录制只作"示范采集"，落库为可读可改的**语义脚本 DSL** + **SOP**，按 `label / 可见文本 / 角色`语义定位（而非 `nth-of-type`），对页面变更更鲁棒。客户端内置解释器执行，弹**确认表单卡片**收集参数（带选项字段渲染为下拉）。
*   **FDE 工作台「技能构建」**：技能中心式卡片网格（统计 / 搜索 / 类型·系统筛选 / 分页 / 增删改查），新建/编辑收进右侧抽屉。**录制即自动产出**：真实表单结构 + 下拉真实选项、SOP、以及「技能描述（供大模型语义匹配）」（经模型中转站生成）。
*   **直达路由（navHash）与 agentic 执行**：把"直跳操作页"的路由作为技能常量（整页加载 `base#route`，绕开折叠/纯 JS 菜单）；读取/写入分流；以**无障碍树 + 原生 tool calling + Playwright 语义定位**驱动的智能体循环真实执行，支持参数化复用。
*   **一段话测整条链路**：调试区发一段话 → 提炼参数（必填缺失即追问，绝不带缺参操作）→ 真实执行 → 通过/失败 + **实际结果**；带无头浏览器开关（无头自动反指纹以复用本地登录态）。

### 6. 业务系统连接、登录保活与技能生命周期治理
*   **只登记地址，登录在本地**：管理平台「业务系统」只登记 名称+地址，**绝不收集凭证**；状态机 已登记 / 地址可达 / 地址不可达。「探测可达」做 HTTP 探测（HEAD→GET、跟随重定向、清洗 `#hash`/空白）。登录在 FDE/客户端本地受管浏览器完成（FDE: Playwright Profile；客户端: Electron `persist:bizsys-<id>` 分区），凭证只在本地。
*   **登录保活心跳**：定时无头静默访问已登录系统，刷新会话有效期（滑动过期）+ 检测掉线，短开短闭、与录制/执行互斥。
*   **技能生命周期治理（三端一致）**：上架 / 草稿 / 下架；**删除前必须先下架**，**下架即脱离所有岗位绑定**。
*   **运行总览（原运营监控）**：核心运行指标（任务总量 / 有效完成 / 活跃用户 / 端到端成功率 / 自动完成率，均来自审计追溯真实聚合、带样本量）+ 任务运行趋势 + 失败原因 + 热门岗位/技能 + 模型与资源消耗 + 企业数智资产总览；无数据来源的指标诚实标"暂无数据"，不把网关调用数当任务数。

---

## 🚀 快速开始 (Quick Start)

> 前置：管理端后端需 **Java 21 + PostgreSQL 17 + pgvector**（详见 `iml-work-admin/admin-backend/README.md` 的 docker-compose 一键起）。客户端默认模型流量指向本地后端的模型中转站 `http://localhost:8080/api/v1/model`。

### 1. 启动桌面客户端 (iml-work-client)

```bash
# 进入客户端目录
cd iml-work-client

# 安装依赖
npm install

# 启动 Electron 开发调试环境
npm run dev

# 编译打包客户端生产包
npm run build
```

### 2. 启动管理端前端 (admin-frontend)

```bash
# 进入管理后台前端目录
cd iml-work-admin/admin-frontend

# 安装依赖并运行
npm install
npm run dev
```

### 3. 启动管理端后端 (admin-backend)

```bash
# 进入管理后台后端 Java 目录
cd iml-work-admin/admin-backend

# 编译打包并运行 Spring Boot 服务（:8080，首启自动建表/装 pgvector/seed）
mvn clean package
JAVA_HOME=$(/usr/libexec/java_home -v 21) java -jar target/admin-backend-1.0.0-SNAPSHOT.jar
```

### 4. 启动 FDE 工作台 (iml-fde-studio)

```bash
# 也可在管理端「技能中心 → FDE 工作台」直接下载工具包
cd iml-fde-studio
npm install          # 含 vite/react + electron；桌面构建会按需装可选原生模块(uiohook-napi / nut-js)

# 生产方式：先构建再启动
npm run build && npm start

# 开发方式：Vite dev server + Electron 加载（热更新）
npm run dev          # 终端 A：启动 Vite (默认 :5173)
npm run app          # 终端 B：FDE_DEV_URL=http://localhost:5173 electron .

# 桌面自动化技能构建还需在 macOS「系统设置 → 隐私与安全性 → 辅助功能」授权
```

---

## 📄 许可证 (License)

本项目采用 [MIT License](LICENSE) 协议授权。

---

<p align="center">
  Built with ❤️ by <b>imoling</b>
</p>
