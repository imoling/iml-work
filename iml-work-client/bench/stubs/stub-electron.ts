// electron API 桩：让 iml-work-client 的主进程管线模块在纯 Node 下可加载。
// 原则：读路径类返回 harness 目录；离屏 BrowserWindow 快速失败（触发管线自身的降级链，
// 如 web-search 深读降级到 Playwright 真 Chrome），绝不静默假装成功。

export const app = {
  isPackaged: false,
  getPath: (_name: string) => process.env.BENCH_DATA_DIR || process.cwd(),
  getAppPath: () => process.cwd(),
  setPath: (_n: string, _p: string) => {},
  setName: (_n: string) => {},
  whenReady: () => new Promise(() => {}),   // 永不 resolve：harness 不走 app 生命周期
  on: () => {},
  quit: () => {},
  dock: null,
  setAboutPanelOptions: (_o: unknown) => {},
}

// 离屏抓取桩：构造成功，但 loadURL 立即走 did-fail-load → offscreenExtract 快速返回 null，
// 让 fetchPageText 按真实降级链走到 Playwright 真 Chrome（bench 环境仍具备真实抓取能力）。
export class BrowserWindow {
  webContents = {
    setAudioMuted: (_m: boolean) => {},
    once: (event: string, cb: (...a: unknown[]) => void) => {
      if (event === 'did-fail-load') setTimeout(() => cb(null, -2, 'bench-stub: no electron renderer'), 20)
    },
    on: () => {},
    send: () => {},
    executeJavaScript: async () => null,
    session: { setProxy: async () => {} },
    openDevTools: () => {},
  }
  constructor(_opts?: unknown) {}
  loadURL(_u: string): Promise<void> { return Promise.resolve() }
  loadFile(_f: string): Promise<void> { return Promise.resolve() }
  isDestroyed(): boolean { return false }
  close(): void {}
  destroy(): void {}
  show(): void {}
  hide(): void {}
  focus(): void {}
  on(): void {}
  once(): void {}
  static getAllWindows(): BrowserWindow[] { return [] }
  static fromWebContents(): null { return null }
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}

export const ipcMain = { handle: () => {}, on: () => {}, once: () => {}, removeHandler: () => {}, removeAllListeners: () => {} }
export const session = {
  fromPartition: () => ({ setProxy: async () => {}, clearStorageData: async () => {}, cookies: { get: async () => [] } }),
  defaultSession: { setProxy: async () => {}, clearStorageData: async () => {} },
}
export const shell = { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } }) }
export const dialog = { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export class Notification { show() {} on() {} static isSupported() { return false } }
export const globalShortcut = { register: () => false, unregister: () => {}, unregisterAll: () => {} }
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) }
export const clipboard = { writeText: () => {}, readText: () => '' }
export const powerMonitor = { on: () => {} }
export const Menu = { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} }
export class Tray { constructor(_i?: unknown) {} setToolTip() {} setContextMenu() {} on() {} destroy() {} }
