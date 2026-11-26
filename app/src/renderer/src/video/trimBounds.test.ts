import { describe, expect, it } from 'vitest'
import { boundaryRow, inRowWithin, outRowWithin, snapToFrameStart, trimEndSec } from './trimBounds'

// 24fps の表。行 3 は撮り逃し（行 2 と同じ時刻）、行 4 の後ろに 2 コマの抜け（4/24・5/24 が無い）。
const f = (n: number): number => n / 24
const pts = [f(0), f(1), f(2), f(2), f(3), f(6), f(7)]
const duration = f(8)

describe('trimEndSec（ffmpeg に渡す終了時刻）', () => {
  it('終了のコマを含める＝次のコマの頭', () => {
    expect(trimEndSec(pts, duration, f(1))).toBe(f(2))
  })
  it('撮り逃しの行を終了にしても、映っている絵の手前で切らない（次に時刻が進む行の頭）', () => {
    expect(trimEndSec(pts, duration, f(2))).toBe(f(3))
  })
  it('抜けの手前のコマを終了にすると、抜けの後ろのコマの頭まで（抜けの中で切らない）', () => {
    expect(trimEndSec(pts, duration, f(3))).toBe(f(6))
  })
  it('最後のコマなら動画の終わり', () => {
    expect(trimEndSec(pts, duration, f(7))).toBe(duration)
  })
  it('表の先頭に同じ時刻が並ぶときも、並びの後ろの時刻の進む行まで進める', () => {
    const head = [f(0), f(0), f(1), f(2)]
    expect(trimEndSec(head, f(3), f(0))).toBe(f(1))
  })
})

describe('boundaryRow（開始・終了の行）', () => {
  it('撮り逃しの並びの中の行は、時刻が合っていればその行のまま', () => {
    expect(boundaryRow(pts, 2, f(2))).toBe(2)
    expect(boundaryRow(pts, 3, f(2))).toBe(3)
  })
  it('時刻だけ動いたら（ドラッグ等）時刻から引き直す', () => {
    expect(boundaryRow(pts, 2, f(6))).toBe(5)
  })
})

describe('snapToFrameStart（タイムライン上の位置をコマの頭へ）', () => {
  it('近い方のコマの頭へ寄せる', () => {
    expect(snapToFrameStart(pts, f(1) + 0.01)).toBe(f(1))
    expect(snapToFrameStart(pts, f(2) - 0.01)).toBe(f(2))
  })
  it('抜けの中は、前後どちらか近い方の実在するコマへ（抜けの時刻は返さない）', () => {
    expect(snapToFrameStart(pts, f(4))).toBe(f(3))
    expect(snapToFrameStart(pts, f(5.5))).toBe(f(6))
  })
  it('返すのは必ず表にある時刻', () => {
    for (let t = 0; t <= duration; t += 0.004) expect(pts).toContain(snapToFrameStart(pts, t))
  })
})

describe('開始・終了の範囲', () => {
  it('開始は終了より 1 行前まで、終了は開始より 1 行後ろまで', () => {
    expect(inRowWithin(6, 4)).toBe(3)
    expect(inRowWithin(-1, 4)).toBe(0)
    expect(outRowWithin(1, 3, pts.length)).toBe(4)
    expect(outRowWithin(99, 3, pts.length)).toBe(pts.length - 1)
  })
})
