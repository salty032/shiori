// 決め方を変えると画質が黙って変わる（録画は取り直せない）。数値を固定する。
// 決めた理由は .claude/rules/recording.md「供給とビットレート」と recorder-bitrate.ts のコメント。
import { describe, expect, it } from 'vitest'
import { videoBitrateFor } from './recorder-bitrate'

describe('videoBitrateFor（録画に要求する映像ビットレート）', () => {
  it('供給が 60枚/秒 以下なら 12Mbps のまま（今の供給は約 50枚/秒）', () => {
    expect(videoBitrateFor(60, null)).toBe(12_000_000)
    expect(videoBitrateFor(50.8, null)).toBe(12_000_000)
    expect(videoBitrateFor(29, null)).toBe(12_000_000)
  })

  it('供給が 60枚/秒 を超えたぶんは、枚数の比の 0.9 乗で上げる', () => {
    expect(videoBitrateFor(120, null)).toBe(Math.round(12_000_000 * Math.pow(2, 0.9)))
  })

  it('供給の実測が壊れていても青天井にならない', () => {
    expect(videoBitrateFor(100_000, null)).toBe(videoBitrateFor(120, null))
    expect(videoBitrateFor(0, null)).toBe(12_000_000)
    expect(videoBitrateFor(Number.NaN, null)).toBe(12_000_000)
    expect(videoBitrateFor(-5, null)).toBe(12_000_000)
  })

  // 目視で合格している 24fps・30fps は 1 ビットも変えない。
  it('素材が 30fps 以下なら変えない（下げもしない）', () => {
    expect(videoBitrateFor(50, 30)).toBe(12_000_000)
    expect(videoBitrateFor(50, 23.976)).toBe(12_000_000)
    expect(videoBitrateFor(50, 12)).toBe(12_000_000)
  })

  it('素材が 30fps を超えたら、コマ 1 つあたりが痩せないよう上げる。60fps 相当で頭打ち', () => {
    expect(videoBitrateFor(50, 59.94)).toBe(Math.round(12_000_000 * (59.94 / 30)))
    expect(videoBitrateFor(50, 60)).toBe(24_000_000)
    expect(videoBitrateFor(50, 120)).toBe(24_000_000)
  })

  // 測れていないのは、この経路の典型的な失敗（拡張の再読み込み待ち・再生直後）。
  it('素材の fps が測れていなければ 1 倍のまま。推定で埋めない', () => {
    expect(videoBitrateFor(50, null)).toBe(12_000_000)
    expect(videoBitrateFor(50, 0)).toBe(12_000_000)
    expect(videoBitrateFor(50, Number.NaN)).toBe(12_000_000)
  })
})
