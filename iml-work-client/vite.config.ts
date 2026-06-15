import { defineConfig } from 'vite'
import { builtinModules } from 'module'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// electron + better-sqlite3 + all node builtins must stay external (required at
// runtime), so the main bundle can be emitted as plain CommonJS.
const mainExternals = [
  'electron',
  'better-sqlite3',
  // pdfjs is ESM-only and heavy; keep external and load via runtime import().
  'pdfjs-dist',
  'pdfjs-dist/legacy/build/pdf.mjs',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Main process entry. Emit CommonJS (.cjs) so Electron can require the
        // `electron` builtin — the package is "type": "module", so a .js main
        // would be treated as ESM and `import { BrowserWindow } from 'electron'`
        // fails at runtime.
        entry: 'src/main/main.ts',
        vite: {
          build: {
            lib: {
              entry: 'src/main/main.ts',
              formats: ['cjs'],
              fileName: () => 'main.cjs',
            },
            rollupOptions: {
              external: mainExternals,
            },
          },
        },
      },
      preload: {
        // Preload entry
        input: 'src/main/preload.ts',
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: '[name].js',
              },
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
