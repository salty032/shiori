import { describe, expect, it } from 'vitest'
import { findFrameIdx, frameSeekTarget } from './frameTable'

// 録画クリップの PTS は等間隔とは限らない（可変フレームレート記録）。
// 24fps 相当（≒0.0417）の区間と、その倍・半分が混ざったテーブルで検証する。
const unevenPts = [0, 0.0417, 0.0834, 0.1668, 0.2502, 0.2919, 0.3336]

describe('findFrameIdx（表示中フレームの特定）', () => {
  it('フレーム境界ちょうどならそのフレーム', () => {
    expect(findFrameIdx(unevenPts, 0)).toBe(0)
    expect(findFrameIdx(unevenPts, 0.0834)).toBe(2)
    expect(findFrameIdx(unevenPts, 0.3336)).toBe(6)
  })

  it('境界の途中なら手前のフレーム', () => {
    expect(findFrameIdx(unevenPts, 0.12)).toBe(2)
    expect(findFrameIdx(unevenPts, 0.2)).toBe(3)
    expect(findFrameIdx(unevenPts, 0.29)).toBe(4)
  })

  it('全フレームについて、その時刻で引くと自分自身が返る', () => {
    // 二分探索の境界条件（lo/hi の詰め方）を全点で押さえる。
    unevenPts.forEach((t, i) => {
      expect(findFrameIdx(unevenPts, t)).toBe(i)
    })
  })

  it('先頭より前・末尾より後ろは端に丸める', () => {
    expect(findFrameIdx(unevenPts, -1)).toBe(0)
    expect(findFrameIdx(unevenPts, 999)).toBe(unevenPts.length - 1)
  })

  it('浮動小数点の微小な誤差ではフレームがずれない', () => {
    // mediaTime が PTS より 0.1ms だけ手前に返ってきても同じフレームと見なす
    expect(findFrameIdx(unevenPts, 0.0834 - 0.0001)).toBe(2)
  })

  it('空のテーブルでも落ちない', () => {
    expect(findFrameIdx([], 1.23)).toBe(0)
  })
})

describe('frameSeekTarget（コマ送りのシーク先）', () => {
  it('フレームの表示区間の中央を返す', () => {
    // 境界ちょうどを指すと丸めで隣に着地しうるため、必ず区間の内側を狙う。
    expect(frameSeekTarget(unevenPts, 2, 1 / 24)).toBeCloseTo((0.0834 + 0.1668) / 2, 6)
  })

  it('間隔が広い区間でも狭い区間でも、狙った先はそのフレームに属する', () => {
    unevenPts.forEach((_, i) => {
      const target = frameSeekTarget(unevenPts, i, 1 / 24)
      expect(findFrameIdx(unevenPts, target)).toBe(i)
    })
  })

  it('末尾フレームは直前の間隔を継続すると見なす', () => {
    const last = unevenPts.length - 1
    const prevGap = unevenPts[last] - unevenPts[last - 1]
    expect(frameSeekTarget(unevenPts, last, 1 / 24)).toBeCloseTo(unevenPts[last] + prevGap / 2, 6)
  })

  it('1 フレームしかないときは渡された既定の尺を使う', () => {
    expect(frameSeekTarget([0], 0, 1 / 24)).toBeCloseTo(1 / 48, 6)
  })
})
