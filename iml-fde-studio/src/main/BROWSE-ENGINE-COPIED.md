# browse 引擎（复制自客户端 · 请两端同步）

FDE 执行/录制引擎正从 Playwright 迁到 Electron + browse（与 `iml-work-client` 共用一套底座）。
下列文件是从 `iml-work-client/src/main/` **原样复制**的叶子模块（无 monorepo，跨仓只能复制 + 手工同步，
沿用既有约定，见 `automation.ts` 顶部注释）。**改动 browse 引擎行为时，两端必须同步。**

| FDE 文件 | 源 | 说明 |
|---|---|---|
| `agent-loop.ts` | `iml-work-client/src/main/agent-loop.ts` | ReAct 循环（callModel 注入） |
| `agent-browse.ts` | 同名 | browse 工具（Electron 离屏窗 + 跨帧注入定位）+ 写前签字钩子 |
| `browse-executor.ts` | 同名 | 统一 browse 执行器（登录态复用 / 只读模式 / onWriteConfirm） |
| `browser-scripts.ts` | 同名 | 注入 JS 常量（SEMANTIC_FN/SNAPSHOT_FN/STRUCT_FN/RECORDER_BOOTSTRAP…） |
| `select-match-core.ts` | 同名 | 模糊选项匹配（纯函数） |
| `util.ts` | 同名 | swallow/sleep（纯） |
| `types.ts` | 同名 | SendLog/RecStep（纯类型） |
| `llm.ts` | —（FDE 自备 shim） | 仅 `LlmConfig` 类型占位；FDE 模型走 `ipc/runtime.ts` 的 `callRelay` |

同步方法：`diff -ru iml-work-client/src/main/<f> iml-fde-studio/src/main/<f>`（llm.ts 除外）。
迁移进度与阶段见记忆 `[[fde-arch-consistency]]` / `[[browse-primary-engine-2026-07]]`。
