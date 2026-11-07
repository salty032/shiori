// **ファイルの枚数と数えた枚数が 1 枚でも食い違うと、そのクリップの表は丸ごとずれる。**
// しかもずれても画面には何も出ない（コマ送りは動き、枚数も割合も合ったまま隣のコマが出る）。
// 画面から気づけない壊れ方なので、ここで数値を固定する。
import { describe, expect, it, vi } from 'vitest'
import { createFrameSink } from './frame-sink'

const clock = { now: () => 1_000_000, epochBase: 500 }

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

  it('開いたとき、開く前に描いた**最後の 1 枚だけ**を 1 枚目として数える', () => {
    // MediaRecorder は動き出した瞬間、キャンバスに描いてある絵を 1 枚書く。
    // それを数えないと表全体が 1 枚前へずれる（2026-09-28 実測: 送った 552・ファイル 553）。
    const sink = createFrameSink(clock)
    sink.record(10)
    sink.record(20)
    sink.open()
    expect(sink.drawnAt).toEqual([520])
    expect(sink.record(30)).toBe(true)
    expect(sink.drawnAt).toEqual([520, 530])
  })

  it('開く前に 1 枚も描いていなければ、開いても何も数えない', () => {
    const sink = createFrameSink(clock)
    sink.open()
    expect(sink.drawnAt).toEqual([])
    expect(sink.record(30)).toBe(true)
    expect(sink.drawnAt).toEqual([530])
  })

  it('2 度開いても、最後の 1 枚を 2 度数えない', () => {
    const sink = createFrameSink(clock)
    sink.record(10)
    sink.open()
    sink.open()
    expect(sink.drawnAt).toEqual([510])
  })

  it('開く前の 1 枚に captureTime が無ければ、描いた時点の時刻へ退避して数える', () => {
    let t = 1_000_000
    const sink = createFrameSink({ now: () => t, epochBase: 500 })
    sink.record(undefined)
    t = 2_000_000
    sink.open()
    expect(sink.drawnAt).toEqual([1_000_000])
    expect(sink.captureTimeMissing).toBe(1)
  })

  it('captureTime を epoch へ直す（配信ページと突き合わせるため）', () => {
    const sink = createFrameSink(clock)
    sink.open()
    sink.record(100)
    sink.record(141.7)
    expect(sink.drawnAt).toEqual([600, 641.7])
    expect(sink.captureTimeMissing).toBe(0)
  })

  // 画面を開いた後に Windows が時計を補正すると、timeOrigin 基準の時刻はその幅だけずれる。
  // レコーダーはアプリの起動から開きっぱなしなので、補正後の録画は表の全行がずれていた（2026-11-02、1.86 秒）。
  it('画面を開いた後に時計が補正されていても、作った時点の時計で epoch へ直す', () => {
    const perfNow = vi.spyOn(performance, 'now').mockReturnValue(10_000)
    // timeOrigin + now() より壁時計が 1860ms 進んでいる＝開いた後に時計が進められた
    const wall = vi.spyOn(Date, 'now').mockReturnValue(performance.timeOrigin + 10_000 + 1860)
    try {
      const sink = createFrameSink()
      sink.open()
      sink.record(10_000)
      expect(sink.drawnAt[0]).toBeCloseTo(performance.timeOrigin + 10_000 + 1860, 6)
    } finally {
      perfNow.mockRestore()
      wall.mockRestore()
    }
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
