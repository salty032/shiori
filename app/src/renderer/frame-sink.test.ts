// **記録が始まる前のフレームを 1 枚でも数えたら、そのクリップの表は丸ごとずれる。**
// しかもずれても画面には何も出ない（コマ送りは動き、枚数も割合も合ったまま隣のコマが出る）。
// 画面から気づけない壊れ方なので、ここで数値を固定する。
import { describe, expect, it } from 'vitest'
import { createFrameSink } from './frame-sink'

const clock = { now: () => 1_000_000, timeOrigin: 500 }

describe('createFrameSink', () => {
  it('開く前は 1 枚も数えず、送ってよいとも答えない', () => {
    const sink = createFrameSink(clock)
    expect(sink.isOpen).toBe(false)
    expect(sink.record(10)).toBe(false)
    expect(sink.record(20)).toBe(false)
    expect(sink.record(undefined)).toBe(false)
    expect(sink.drawnAt).toEqual([])
    expect(sink.captureTimeMissing).toBe(0)
  })

  it('開いた後だけ数える。**開く前のぶんが遡って入らない**', () => {
    const sink = createFrameSink(clock)
    sink.record(10)
    sink.record(20)
    sink.open()
    expect(sink.record(30)).toBe(true)
    expect(sink.drawnAt).toEqual([530])
  })

  it('captureTime を epoch へ直す（配信ページと突き合わせるため）', () => {
    const sink = createFrameSink(clock)
    sink.open()
    sink.record(100)
    sink.record(141.7)
    expect(sink.drawnAt).toEqual([600, 641.7])
    expect(sink.captureTimeMissing).toBe(0)
  })

  it('captureTime が載らない環境では現在時刻へ退避し、その枚数を残す', () => {
    const sink = createFrameSink(clock)
    sink.open()
    sink.record(undefined)
    sink.record(100)
    sink.record(undefined)
    expect(sink.drawnAt).toEqual([1_000_000, 600, 1_000_000])
    // 退避した枚数は診断に載る。**0 でないこと自体が、時刻の精度が落ちている合図。**
    expect(sink.captureTimeMissing).toBe(2)
  })
})
