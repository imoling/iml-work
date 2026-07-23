// browse 引擎（复制自 iml-work-client/src/main）只 **type-only** 依赖 LlmConfig。
// FDE 不直连厂商，模型统一走中转站 callRelay（ipc/runtime.ts），运行时的 callModel 由调用方注入——
// 本文件仅提供类型占位，避免把客户端 llm.ts（llm→db→app.getPath 重依赖）整套搬进来。
export interface LlmConfig {
  mode: string
  apiMode: string
  baseUrl: string
  apiKey: string
  modelName: string
}
