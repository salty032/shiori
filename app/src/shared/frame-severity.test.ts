// 式を変えると、同じ録画が画面ごとに赤かったり白かったりする。線の位置を固定する。
import { describe, expect, it } from 'vitest'
import { SEVERE_FRAME_RATIO } from './api.video'
import { isMissingSevere, isPrecisionGuaranteed, isReuseSevere, missingFrameCount } from './frame-severity'

describe('missingFrameCount（表から抜けているコマ数）', () => {
  it('アニメとしての抜け（animeMissing）だけを足す', () => {
    expect(missingFrameCount([{ animeMissing: 2 }, { animeMissing: 1 }])).toBe(3)
  })
  it('枚数を推定できなかった抜けは 0 として数える', () => {
    expect(missingFrameCount([{ animeMissing: 2 }, {}])).toBe(2)
  })
  it('抜けの一覧が無ければ 0', () => {
    expect(missingFrameCount(undefined)).toBe(0)
    expect(missingFrameCount(null)).toBe(0)
    expect(missingFrameCount([])).toBe(0)
  })
})

describe('isMissingSevere（抜けが多すぎるか）', () => {
  it('しきい値は 5% のまま', () => expect(SEVERE_FRAME_RATIO).toBe(0.05))

  // 母数は「行数＋抜け」。95 行＋抜け 5 ＝ 100 コマ中 5 コマはちょうど 5% で、超えていない。
  it('母数は行数＋抜け。ちょうど 5% は多すぎるとしない', () => {
    expect(isMissingSevere(95, 5)).toBe(false)
    expect(isMissingSevere(94, 6)).toBe(true)
  })
  it('抜けが無ければ、行数が 0 でも多すぎるとしない', () => {
    expect(isMissingSevere(100, 0)).toBe(false)
    expect(isMissingSevere(0, 0)).toBe(false)
  })
  it('行が 1 つも無く抜けだけなら多すぎる', () => {
    expect(isMissingSevere(0, 3)).toBe(true)
  })
})

describe('isReuseSevere（撮り逃しが多すぎるか）', () => {
  it('母数は表の行数。ちょうど 5% は多すぎるとしない', () => {
    expect(isReuseSevere(5, 100)).toBe(false)
    expect(isReuseSevere(6, 100)).toBe(true)
  })
  // 詳細パネルは行数が DB に無い行（fps も尺も無い）で 0 を渡す。そのとき赤にしない。
  it('行数が分からないときは多すぎるとしない', () => {
    expect(isReuseSevere(10, 0)).toBe(false)
  })
})

// 精度を保証するのは 30fps 以下（29.97 を含む）。fps が分からない録画は今までどおり判定する。
describe('isPrecisionGuaranteed（精度を保証する素材か）', () => {
  it('23.976・29.97・30 は保証し、59.94・38 は保証しない', () => {
    expect([23.976, 29.97, 30].map(isPrecisionGuaranteed)).toEqual([true, true, true])
    expect([59.94, 38.28].map(isPrecisionGuaranteed)).toEqual([false, false])
  })
  it('fps が分からなければ判定する側に倒す', () => {
    expect([null, undefined, 0, Number.NaN].map(isPrecisionGuaranteed)).toEqual([true, true, true, true])
  })
})
