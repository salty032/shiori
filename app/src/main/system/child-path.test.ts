import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { isChildPath } from './child-path'

// アプリが開いてよい・消してよいファイルの境界。外れると、保存フォルダの外のファイルを
// 開いたり消したりできてしまう。
describe('isChildPath', () => {
  const base = resolve('/lib/captures')

  it('中のファイル・下の階層は中', () => {
    expect(isChildPath(base, join(base, 'a.png'))).toBe(true)
    expect(isChildPath(base, join(base, '2026-11', 'a.png'))).toBe(true)
  })

  it('base そのものは中に含めない', () => {
    expect(isChildPath(base, base)).toBe(false)
  })

  it('親・隣は外', () => {
    expect(isChildPath(base, resolve('/lib'))).toBe(false)
    expect(isChildPath(base, resolve('/lib/other/a.png'))).toBe(false)
  })

  it('名前の頭だけ同じ隣のフォルダは外（文字列の前方一致で判定しない）', () => {
    expect(isChildPath(base, resolve('/lib/captures2/a.png'))).toBe(false)
  })

  it('.. を挟んで外へ出るパスは外', () => {
    expect(isChildPath(base, join(base, '..', 'other', 'a.png'))).toBe(false)
  })

  it('「..」で始まる名前のフォルダは中（.. という区切りではない）', () => {
    expect(isChildPath(base, join(base, '..cache', 'a.png'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('別のドライブは外', () => {
    expect(isChildPath('C:\\lib\\captures', 'D:\\lib\\captures\\a.png')).toBe(false)
  })
})
