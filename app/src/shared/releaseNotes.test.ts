import { describe, expect, it } from 'vitest'
import { RELEASE_NOTES, releaseNotesFor } from './releaseNotes'

// 変更点の文面は「日英セットで書く」決まり（SPEC 7章）だが、守られているかを確かめる手段が
// 無かった。**片方だけ書くと、その言語のユーザーにだけ従来のトーストが出る**（お知らせ
// モーダルは notes が空だとフォールバックする）。リリース作業の最中に気付ける形にしておく。

describe('RELEASE_NOTES', () => {
  const versions = Object.keys(RELEASE_NOTES)

  it('キーは package.json の version と同じ形（x.y.z）', () => {
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // 数を揃えるのは訳し忘れを見つけるため。文面そのものは言語ごとに長さが違ってよいが、
  // 項目が片方だけ多いのは「1 項目訳していない」以外の理由が考えにくい。
  it('どのバージョンも日英が同じ項目数で、空文字を含まない', () => {
    for (const v of versions) {
      const { ja, en } = RELEASE_NOTES[v]
      expect(ja.length, `${v} の ja が空`).toBeGreaterThan(0)
      expect(en.length, `${v} の en の項目数が ja と違う`).toBe(ja.length)
      for (const line of [...ja, ...en]) expect(line.trim()).not.toBe('')
    }
  })

  it('未登録のバージョンは undefined を返す（お知らせモーダルではなくトーストへ落ちる）', () => {
    expect(releaseNotesFor('0.0.0', 'ja')).toBeUndefined()
  })
})
