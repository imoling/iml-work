import { fileURLToPath } from 'url'
import { dirname } from 'path'

// In ES Module context, define __filename and __dirname on global scope
// so that CommonJS libraries like bindings (used by better-sqlite3) can resolve them.
const filename = fileURLToPath(import.meta.url)
const dirnameVal = dirname(filename)

;(globalThis as any).__filename = filename
;(globalThis as any).__dirname = dirnameVal
