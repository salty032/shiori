import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MEDIA_EXTS } from './media-exts'

// 更新前の確認（build/installer.nsh）は、インストール先に素材があれば更新を止める。素材かどうかは
// 拡張子で見るので、MEDIA_EXTS に形式を足して installer.nsh を忘れると、その形式の素材だけ
// 更新で黙って消える（古い版のアンインストーラがインストール先を丸ごと消すため）。
describe('installer.nsh の更新前の確認', () => {
  it('MEDIA_EXTS と同じ拡張子を見ている', () => {
    const nsh = readFileSync(join(__dirname, '../../../build/installer.nsh'), 'utf8')
    const checked = new Set([...nsh.matchAll(/StrCmp \$R4 "(\.[a-z0-9]+)" found/g)].map((m) => m[1]))
    expect([...checked].sort()).toEqual([...MEDIA_EXTS].sort())
  })
})
