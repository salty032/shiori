// extension/ の JS をテストからテキストとして読むための共有部。
//
// content.js / background.js はバンドラ無しで配布される素の script なので import できない。
// そのため回帰テストは「読み込んで、必要な関数だけ切り出して評価する」形を取る
// （extension-parity / extension-frame-step / extension-step-landing の 3 本が同じことをする）。
//
// **テスト専用。** main の実行時バンドルは index.ts から辿るので、ここは入らない。
import { readFileSync } from 'fs'
import { join } from 'path'

export const contentJs = readFileSync(join(__dirname, '../../../../extension/content.js'), 'utf-8')
export const backgroundJs = readFileSync(join(__dirname, '../../../../extension/background.js'), 'utf-8')

// 名前で関数 1 つ分のソースを切り出す。波括弧の対応で終端を見つけるので、
// 関数内の文字列に `}` が含まれていても数え違えない限りは通る。
export function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function not found in extension source: ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in extension source: ${name}`)
}
