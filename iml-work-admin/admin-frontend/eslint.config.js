import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

// 现阶段目标：让 eslint 能跑起来做「护栏」，对存量问题一律 warn（不阻塞构建/CI），
// 后续逐步收敛为 error。类型感知规则未开启以保持快速。
export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'node_modules/**', 'release/**', 'out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
      'prefer-const': 'warn',
      // 以下为新版 recommended 的风格化 error，存量代码有意如此，降级/关闭避免误报为 error：
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'preserve-caught-error': 'off',
      // 中文文案里的全角/不间断空格：跳过字符串/注释/模板，仅对代码中的异常空格 warn。
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipComments: true, skipTemplates: true, skipJSXText: true }],
    },
  },
)
