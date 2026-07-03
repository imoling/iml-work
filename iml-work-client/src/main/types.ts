// 主进程共享类型。

// 执行日志回调：把思考/动作/输出/观察/完成事件流回渲染层的执行抽屉。
export type SendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void
