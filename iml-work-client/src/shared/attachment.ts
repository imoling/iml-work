// 消息里的附件/图片名解析。**纯函数、零依赖**——主进程与渲染层共用。
//
// 抽出来的直接原因：这套正则原本一份在 main/workspace-files.ts（决定给不给视觉模型看），
// 一份在 renderer/DialoguePanel.tsx（决定气泡里怎么显示附件条），改一处漏一处就会出现
// 「界面显示带了附件、模型却没收到」这种对不上的状态。顺带也让它可被单测覆盖
// （workspace-files 依赖 electron 的 app.getPath，根本没法在纯 Node 下 import）。

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

/** 附件块：新格式【附件】「a」「b」（已加入工作空间）；旧格式按顿号分隔仍兼容。 */
export function parseAttachmentNames(text: string): string[] {
  const m = (text || '').match(/【附件】([^\n]*?)（已加入工作空间）/)
  if (!m) return []
  const quoted = m[1].match(/「([^」]+)」/g)
  if (quoted && quoted.length) return quoted.map(s => s.slice(1, -1).trim()).filter(Boolean)
  return m[1].split(/、|,/).map(s => s.trim()).filter(Boolean)
}

/** 正文里的裸提及（附件块之外，如"看下 报错截图.png"）。 */
export function extractImageNames(text: string): string[] {
  const re = /[^\s《》「」【】、，,。；;:：]+?\.(?:png|jpe?g|webp|gif|bmp)/gi
  return ((text || '').match(re) || []).map(x => x.replace(/[《》「」【】'"]/g, '').trim()).filter(Boolean)
}

/**
 * 本轮该看哪些图片。
 *
 * 两个来源的**授权含义完全不同**，不能被同一个开关一起挡掉：
 *   · 【附件】块 = 用户这一轮亲手递过来的，本身就是"你看一下"的明确意图；
 *   · 正文裸提及 = 让模型去工作空间里找，属于翻文件，该跟随「工作空间访问」开关。
 * 一起挡的后果实测过：用户关掉开关后发图，模型只拿到一个文件名，
 * 写 python 去沙箱里找了 7 轮工具调用才放弃（2026-08-03）。
 */
export function imageNamesInMessage(content: string, opts?: { includeMentions?: boolean }): string[] {
  const names = [
    ...parseAttachmentNames(content),
    ...(opts?.includeMentions === false ? [] : extractImageNames(content)),
  ]
  // 必须去重：裸提及的扫描会把【附件】块里的名字**再扫一遍**，
  // 不去重的话「最多 4 张」的上限会被重复项吃掉（2 张图占满 4 个名额）。
  return [...new Set(names.filter(n => IMAGE_EXT_RE.test(n)))]
}
