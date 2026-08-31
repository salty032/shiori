import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { RELEASE_NOTES, allReleaseNotes, releaseNotesFor } from './releaseNotes'

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

  // **配る版の番号に文面が無いのは、たいてい版を上げ忘れた方**（1.3.1 のまま 2 回目を
  // 配りかけた）。文面が無いだけならトーストへ落ちて済むが、版が同じままだと拡張が
  // 配布側へコピーされず（バンドルの版が上のときだけ入れ替わる）、直したはずのものが
  // 黙って効かない。上げ忘れをここで落とす。
  it('package.json の version に対応する文面がある（版の上げ忘れ・書き忘れを落とす）', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as {
      version: string
    }
    expect(Object.keys(RELEASE_NOTES), `${pkg.version} の文面が無い`).toContain(pkg.version)
  })

  it('未登録のバージョンは undefined を返す（お知らせモーダルではなくトーストへ落ちる）', () => {
    expect(releaseNotesFor('0.0.0', 'ja')).toBeUndefined()
  })

  // 設定から開く「変更点を見る」は収録分を全部並べる。**書き足す位置を間違えても画面には
  // 「古い版が上に来た」としか出ない**ので、並びはここで見る。文字列順に落ちていると
  // 1.10.0 が 1.9.0 より下へ回る。
  it('全バージョンが新しい順に並ぶ', () => {
    const versions = allReleaseNotes('ja').map((e) => e.version)
    const sorted = [...versions].sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
    })
    expect(versions).toEqual(sorted)
  })
})
