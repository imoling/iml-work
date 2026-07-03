// 跨模块共享的运行计数：远程 IM 指令 / 对话执行次数，供心跳上报统计。
let imCommandCount = 0

export function incImCommandCount(): void { imCommandCount++ }
export function getImCommandCount(): number { return imCommandCount }
