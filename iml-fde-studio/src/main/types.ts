// 主进程共享类型。

// 执行日志回调：把思考/动作/输出/观察/完成事件流回渲染层的执行抽屉。
export type SendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void

// 表单/回放共享的数据形状。
export interface VisitField { name: string; label: string; value: string; type: string; options?: string[]; readonly?: boolean }

// 录制/回放的单步动作。
// action 开放为 string：FDE 录制器持续新增动作类型（press/choose/upload/agent/openTab/extract…），
// 客户端按能力分派、未知动作走语义解释器兜底，不因为类型收窄而在归一层被丢弃。
export interface RecStep { action: string; selector: string; value: string; label: string; tag: string; url: string; kind?: string; waitBefore?: number; resultSelector?: string; fieldName?: string; options?: string[]; inputType?: string; optional?: boolean; frameUrl?: string; inIframe?: boolean; repeat?: { n: number; idx: number; key: string }; near?: string[] }

// 语义脚本(DSL)解析出的单步。frame = 该步所在 iframe 的 URL(@frame= 语法,回放切入对应子 frame)。
export interface DslStep { op: string; arg: string; valueExpr: string; sel?: string; frame?: string }
