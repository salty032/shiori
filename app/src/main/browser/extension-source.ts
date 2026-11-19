// extension/ の JS をテストからテキストとして読むための共有部。
//
// content.js / background.js はバンドラ無しで配布される素の script なので import できない。
// そのため回帰テストは「読み込んで、必要な関数だけ切り出して評価する」形を取る
// （browser/extension-*.test.ts がこの形を共有する）。
//
// **テスト専用。** main の実行時バンドルは index.ts から辿るので、ここは入らない。
import { readFileSync } from 'fs'
import { join } from 'path'

const EXTENSION_DIR = join(__dirname, '../../../../extension')
export const backgroundJs = readFileSync(join(EXTENSION_DIR, 'background.js'), 'utf-8')
export const keyGuardJs = readFileSync(join(EXTENSION_DIR, 'key-guard.js'), 'utf-8')
export const manifestJson = readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf-8')

/** content.js と一緒に読み込まれるファイル（manifest.json の順）。ページでは同じ isolated world で関数と変数を共有する。 */
export const contentScriptFiles: string[] = (JSON.parse(manifestJson) as { content_scripts: { js: string[] }[] })
  .content_scripts.find((entry) => entry.js.includes('content.js'))?.js ?? ['content.js']

/**
 * content.js とその仲間（content-*.js）を manifest の順につないだもの。ページで実行されるのと同じ並び。
 * テストは関数を名前で切り出すので、どのファイルに置いたかに左右されない。
 */
export const contentJs = contentScriptFiles.map((file) => readFileSync(join(EXTENSION_DIR, file), 'utf-8')).join('\n')

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
