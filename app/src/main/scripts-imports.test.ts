import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

// app/scripts のスクリプト（frame-test.cjs など）は、アプリの関数を .ts のパスと名前で読み込む。
// **typecheck もほかのテストもスクリプトを見ない**ので、関数を別のファイルへ移す・名前を変えると、
// 次にそのスクリプトを回したときに初めて落ちる（2026-11-15、matchFrames を frame-match.ts へ移したときに起きた）。
// ここでは、受け取っている名前がその .ts で今も export されているかだけを文字で確かめる。
const scriptsDir = resolve(__dirname, '../../scripts')

const requires = readdirSync(scriptsDir)
  .filter((f) => /\.(c|m)?js$/.test(f))
  .flatMap((f) => {
    const text = readFileSync(join(scriptsDir, f), 'utf8')
    const pattern = /(?:const \{([^}]*)\} = require\('(\.\.\/src\/[^']+\.ts)'\))|(?:import \{([^}]*)\} from '(\.\.\/src\/[^']+\.ts)')/g
    return [...text.matchAll(pattern)].map((m) => ({
      script: f,
      file: m[2] ?? m[4],
      names: (m[1] ?? m[3]).split(',').map((n) => n.trim().split(/[:\s]/)[0]).filter(Boolean)
    }))
  })

describe('app/scripts が読み込むアプリの関数', () => {
  it('読み込みが 1 つ以上見つかる（拾い方が壊れていないこと）', () => {
    expect(requires.length).toBeGreaterThan(0)
  })

  for (const { script, file, names } of requires) {
    it(`${script} → ${file}`, () => {
      const source = readFileSync(resolve(scriptsDir, file), 'utf8')
      for (const name of names) {
        expect(source, `${name} が ${file} で export されていない`).toMatch(
          new RegExp(`export (async )?(function|const|let|class) ${name}[^A-Za-z0-9_$]`)
        )
      }
    })
  }
})
