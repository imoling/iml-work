# iML Work — 企业级智能助理与自动化协同工作流系统

<p align="left">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT">
  <img src="https://img.shields.io/badge/platform-Electron-lightgrey.svg" alt="Platform Electron">
  <img src="https://img.shields.io/badge/framework-React_18-61dafb.svg" alt="Framework React">
  <img src="https://img.shields.io/badge/backend-Spring_Boot_3-6db33f.svg" alt="Backend Spring Boot">
</p>

`iML Work` 是一个面向企业内网环境的极致简洁、安全高效的智能助理与自动化协同系统。项目采用 **Monorepo** 架构进行统一管理，集成了桌面智能体客户端、离屏无头浏览器 RPA 驱动、本地隔离沙箱以及 SaaS 后台管理系统。

---

## 📂 项目结构 (Project Structure)

本仓库采用多包单仓管理（Monorepo）结构，包含两大核心子系统：

```
iml-work/
├── iml-work-client/          # 🖥️ Electron 桌面端客户端
│   ├── skills/               # 本地物理智能体技能定义 (YAML Frontmatter + SOP)
│   ├── src/main/             # Electron 主进程 (Harness 任务引擎、SQLite 持久化、本地技能解析)
│   └── src/renderer/         # React 前端渲染层 (Execution Drawer 思考抽屉、MarkdownRenderer)
└── iml-work-admin/           # ⚙️ SaaS 运营管理后台
    ├── admin-frontend/       # React 运营后台前端面版
    └── admin-backend/        # Java / Spring Boot 运营后台后端服务
```

---

## ✨ 核心特性 (Key Features)

### 1. “执行抽屉”交互设计 (Execution Drawer)
*   **清爽对话流**：主聊天区域仅渲染用户发言与智能体的最终富文本回答，不让冗余的调试日志影响视觉重心。
*   **自适应弹起**：在智能体进入 ReAct 推理时，执行抽屉自适应滑动展开，黑底绿字实时流式打印 CoT 思考过程（Thought）、Action 执行动作以及沙箱 Python/Playwright 执行的底层 stdout stdout。

### 2. 本地物理技能规范与角色控制 (Physical Skills & Allowed Roles)
*   **纯文本技能定义**：技能物理存放在 `skills/` 目录下，仅需一个 `SKILL.md` 文档及头部 YAML 元数据即可唤醒。
*   **多维度角色隔离**：主进程解析 `allowed_roles`（如 `expert-1`, `expert-2`），在员工领用岗位助手时差量下载、动态加载并过滤出该专家专享的技能，严防越权调用。

### 3. 高性能富文本渲染与原生交互
*   **防 DOM 嵌套警告设计**：自研 `MarkdownRenderer` React 组件。在解析图片时强行使用行内元素 `<span>`（display: inline-block）而非 `<div>` 作为段落 `<p>` 内部容器，彻底解决 React 嵌套报错。
*   **本地文件一键唤醒**：深度拦截 Markdown 链接，若匹配本地文件 `file://` 协议，调用 Electron `shell.openPath` 原生唤醒系统关联程序直接双击打开对应物理文件（如 PDF、Word）。
*   **避障机制**：在主进程与大模型交互时，将大图 Base64 缩略压缩并由占位符 `[IMAGE_PLACEHOLDER_PNG]` 替代，避免 LLM Token Window 爆表，响应完毕后再回写替换，保证了截图的急速高清载入。

---

## 🚀 快速开始 (Quick Start)

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

# 编译打包 Spring Boot 服务
mvn clean package
```

---

## 📄 许可证 (License)

本项目采用 [MIT License](LICENSE) 协议授权。

---

<p align="center">
  Built with ❤️ by <b>imoling</b>
</p>
