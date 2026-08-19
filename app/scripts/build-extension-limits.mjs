// extension/*.js の中の「アプリと同じでなければならない定数」を生成する。
//
// 原本は app/src/shared/wire-limits.ts（キー名だけ shared/hotkey.ts）。拡張は
// バンドラ無しで配るため実行時に import できないので、目印
// （`// ==== ここから自動生成: xxx ====`）の内側へ値を書き込む形にしてある。
//
//   npm run ext:limits
//
// 差し込んだ結果はコミットする（拡張はソースがそのまま配布物なので、生成物も履歴に要る）。
// 生成し忘れ・手での書き換えは extension-parity.test.ts が落とす。
//
// TypeScript を直接 import しているのは Node の型ストリップ頼み。そのため
// wire-limits.ts と hotkey.ts は import を 1 つも持たないこと。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderExtensionBlocks, writeGeneratedBlock } from '../src/shared/wire-limits.ts'
import { NAMED_CAPTURE_KEY_VALUES } from '../src/shared/hotkey.ts'

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '../../extension')

const byFile = new Map()
for (const block of renderExtensionBlocks(NAMED_CAPTURE_KEY_VALUES)) {
  if (!byFile.has(block.file)) byFile.set(block.file, [])
  byFile.get(block.file).push(block)
}

let changed = 0
for (const [file, blocks] of byFile) {
  const path = join(extensionDir, file)
  const before = readFileSync(path, 'utf-8')
  let after = before
  for (const block of blocks) after = writeGeneratedBlock(after, block.id, block.text)
  if (after !== before) {
    writeFileSync(path, after)
    changed++
    console.log(`更新: extension/${file}`)
  } else {
    console.log(`変更なし: extension/${file}`)
  }
}
