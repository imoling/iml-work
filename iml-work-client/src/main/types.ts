// 主进程共享类型。

// 执行日志回调：把思考/动作/输出/观察/完成事件流回渲染层的执行抽屉。
export type SendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void

// 表单/回放共享的数据形状。
export interface VisitField { name: string; label: string; value: string; type: string; options?: string[]; readonly?: boolean }

// 录制/回放的单步动作。
export interface RecStep { action: 'click' | 'fill' | 'select'; selector: string; value: string; label: string; tag: string; url: string; kind?: string; waitBefore?: number; resultSelector?: string; fieldName?: string; options?: string[]; inputType?: string; optional?: boolean }

// 语义脚本(DSL)解析出的单步。
export interface DslStep { op: string; arg: string; valueExpr: string; sel?: string }
