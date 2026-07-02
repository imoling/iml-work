import js from '@eslint/js'
import globals from 'globals'

// 纯 JS(JSX) 项目：eslint 基础规则 + React 浏览器/Node 全局。存量问题一律 warn，不阻塞。
// 类型护栏后续随「FDE 迁移 TypeScript」补齐。
export default [
  { ignores: ['dist/**', 'node_modules/**', 'out/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
      'prefer-const': 'warn',
      'no-useless-assignment': 'off',
      'no-unused-expressions': 'off',
      'preserve-caught-error': 'off',
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipComments: true, skipTemplates: true, skipJSXText: true }],
    },
  },
]
