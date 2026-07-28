/**
 * 企业模型网关的**开发默认** corp-key（单一来源，主进程与渲染层共用）。
 * 与后端 ModelProxyService.DEV_DEFAULT_CORP_KEY 同值：仅限本地开发/演示；
 * 生产环境后端对默认值拒启动，真实 key 由管理员在设置页下发、经 SECURE_KEYS 加密落盘。
 */
export const DEV_CORP_GATEWAY_KEY = 'sk-corp-default-key'
