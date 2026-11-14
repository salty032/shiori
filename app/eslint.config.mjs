// React のフックの書き漏れだけを見る。型や書式は tsc と好みに任せ、ここでは増やさない。
// 依存配列の漏れは型チェックもテストも素通りし、言語切替後も前の言語で出る、のような
// 「古い値のまま動く」不具合になる。わざと省く箇所は、理由を添えて行ごとに外す。
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]
