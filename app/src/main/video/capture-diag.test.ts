import { describe, expect, it } from 'vitest'
import { parseCaptureDiag, summarizeSupply } from './capture-diag'

// 一定間隔で供給された想定の drawnAt を作る（epoch ミリ秒）。
function evenlySpaced(count: number, gapMs: number, start = 1_700_000_000_000): number[] {
  return Array.from({ length: count }, (_, i) => start + i * gapMs)
}

describe('summarizeSupply（供給間隔の要約）', () => {
  it('標本が1枚以下・尺が0なら要約しない', () => {
    expect(summarizeSupply([], 5, 41.7)).toBeNull()
    expect(summarizeSupply([1000], 5, 41.7)).toBeNull()
    expect(summarizeSupply(evenlySpaced(10, 30), 0, 41.7)).toBeNull()
  })

  it('毎秒の供給枚数は「枚数 ÷ 尺」', () => {
    // 5秒で 170 枚 = 34枚/秒（実測レンジの代表値）
    const summary = summarizeSupply(evenlySpaced(170, 29.4), 5, null)
    expect(summary?.drawnPerSec).toBeCloseTo(34, 5)
  })

  it('間隔の中央値・p95・最大を出す', () => {
    // 30ms 間隔の中に 1 回だけ 120ms の谷を混ぜる
    const drawn = evenlySpaced(50, 30)
    for (let i = 25; i < drawn.length; i++) drawn[i] += 90
    const summary = summarizeSupply(drawn, 2, null)
    expect(summary?.medianGapMs).toBe(30)
    expect(summary?.maxGapMs).toBe(120)
  })

  it('素材のコマ1つより長く空いた回数を数える（撮り逃しが起きうる箇所）', () => {
    // 24fps 素材の周期 41.7ms に対し、通常 30ms・谷が 3 回
    const drawn = evenlySpaced(40, 30)
    for (const at of [10, 20, 30]) {
      for (let i = at; i < drawn.length; i++) drawn[i] += 50
    }
    expect(summarizeSupply(drawn, 2, 41.7)?.longGaps).toBe(3)
  })

  it('素材の周期が不明なら longGaps は出さない（推測で数字を作らない）', () => {
    expect(summarizeSupply(evenlySpaced(40, 30), 2, null)?.longGaps).toBeNull()
  })

  it('時刻が逆行した標本は捨てる（captureTime と Date.now() の混在対策）', () => {
    // 3枚目だけ過去へ飛ぶ。負の間隔をそのまま数えると中央値・最小が壊れる
    const drawn = [1000, 1030, 900, 1090]
    const summary = summarizeSupply(drawn, 1, null)
    expect(summary?.maxGapMs).toBe(190)
    expect(summary?.medianGapMs).toBeGreaterThan(0)
  })
})

describe('parseCaptureDiag（レコーダーから届く診断値の検証）', () => {
  const valid = {
    callbacks: 1200,
    presented: 1210,
    skippedByCallback: 10,
    duplicateSuppressed: 96,
    totalVideoFrames: 1400,
    droppedVideoFrames: 3
  }

  it('正常な値はそのまま通す', () => {
    expect(parseCaptureDiag(valid)).toEqual(valid)
  })

  it('getVideoPlaybackQuality が無い環境（null）でも受け入れる', () => {
    const diag = parseCaptureDiag({ ...valid, totalVideoFrames: null, droppedVideoFrames: undefined })
    expect(diag?.totalVideoFrames).toBeNull()
    expect(diag?.droppedVideoFrames).toBeNull()
  })

  it('必須の計数が欠けている・数値でないなら診断なしとして扱う', () => {
    expect(parseCaptureDiag(null)).toBeNull()
    expect(parseCaptureDiag('diag')).toBeNull()
    expect(parseCaptureDiag({ ...valid, callbacks: undefined })).toBeNull()
    expect(parseCaptureDiag({ ...valid, presented: 'many' })).toBeNull()
    expect(parseCaptureDiag({ ...valid, skippedByCallback: NaN })).toBeNull()
  })
})
