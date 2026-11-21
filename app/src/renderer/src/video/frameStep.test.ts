import { describe, expect, it } from 'vitest'
import { frameSeekSec, stepFramePos, type FramePos } from './frameStep'

const S = 1 / 24
// 6 行目は撮り逃し（5 行目と同じ時刻）。10 行目の後ろに 2 コマの抜け。
const pts = [0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 12, 13].map((f) => f * S)
const total = pts.length
const missingAfter = (idx: number): number => (idx === 10 ? 2 : 0)
const viewer = { missingAfter }
const trimmer = {}

function walk(start: FramePos, delta: number, times: number, mode: Parameters<typeof stepFramePos>[3]): FramePos[] {
  const seen: FramePos[] = []
  let pos = start
  for (let i = 0; i < times; i++) { pos = stepFramePos(pos, delta, total, mode); seen.push(pos) }
  return seen
}

describe('stepFramePos - ビューアとトリミング画面のコマ送り', () => {
  it('抜けが無ければ、2 つの画面は同じ行へ動く（違うのは抜けで止まるかだけ）', () => {
    const noGaps = { missingAfter: () => 0 }
    for (let idx = 0; idx < total; idx++) {
      for (const delta of [-30, -3, -1, 1, 3, 30]) {
        expect(stepFramePos({ idx, gap: 0 }, delta, total, noGaps))
          .toEqual(stepFramePos({ idx, gap: 0 }, delta, total, trimmer))
      }
    }
  })

  it('ビューアは抜けでも止まり、トリミング画面は絵のある行だけを渡る', () => {
    const start = { idx: 9, gap: 0 }
    expect(walk(start, 1, 4, viewer)).toEqual([
      { idx: 10, gap: 0 }, { idx: 10, gap: 1 }, { idx: 10, gap: 2 }, { idx: 11, gap: 0 },
    ])
    expect(walk(start, 1, 2, trimmer)).toEqual([{ idx: 10, gap: 0 }, { idx: 11, gap: 0 }])
    // 戻るときも同じ。ビューアは抜けの最後のコマから入る。
    expect(walk({ idx: 11, gap: 0 }, -1, 2, viewer)).toEqual([{ idx: 10, gap: 2 }, { idx: 10, gap: 1 }])
    expect(walk({ idx: 11, gap: 0 }, -1, 1, trimmer)).toEqual([{ idx: 10, gap: 0 }])
  })

  it('撮り逃しの行（同じ時刻の行）には、どちらの画面でも 1 行ずつ止まる', () => {
    // 時刻から引き直すと同じ時刻の並びの最後へ飛ぶ（2026-11-02 にトリミング画面で −1 コマが止まった）。
    expect(walk({ idx: 7, gap: 0 }, -1, 3, trimmer).map((p) => p.idx)).toEqual([6, 5, 4])
    expect(walk({ idx: 7, gap: 0 }, -1, 3, viewer).map((p) => p.idx)).toEqual([6, 5, 4])
  })

  it('まとめて動かしても端で止まる（読み込み中に溜めたコマ送り）', () => {
    expect(stepFramePos({ idx: 2, gap: 0 }, -30, total, trimmer)).toEqual({ idx: 0, gap: 0 })
    expect(stepFramePos({ idx: 2, gap: 0 }, 30, total, trimmer)).toEqual({ idx: total - 1, gap: 0 })
    expect(stepFramePos({ idx: 2, gap: 0 }, -30, total, viewer)).toEqual({ idx: 0, gap: 0 })
    expect(stepFramePos({ idx: 2, gap: 0 }, 30, total, viewer)).toEqual({ idx: total - 1, gap: 0 })
  })

  it('開始は終了の 1 行前まで、終了は開始の 1 行後ろまでしか動かない', () => {
    expect(stepFramePos({ idx: 4, gap: 0 }, 1, total, { hi: 4 })).toEqual({ idx: 4, gap: 0 })
    expect(stepFramePos({ idx: 5, gap: 0 }, -1, total, { lo: 5 })).toEqual({ idx: 5, gap: 0 })
    expect(stepFramePos({ idx: 2, gap: 0 }, 5, total, { hi: 4 })).toEqual({ idx: 4, gap: 0 })
    // 終了が先頭の行にあって範囲が空でも、開始は 0 行目に留まる（負の行へ行かない）。
    expect(stepFramePos({ idx: 0, gap: 0 }, 1, total, { hi: -1 })).toEqual({ idx: 0, gap: 0 })
  })
})

describe('frameSeekSec - 映すためのシーク先', () => {
  it('そのコマ自身の長さの真ん中。抜けの手前の行でも次の行との中間にしない', () => {
    const dur = pts.map(() => S)
    // 10 行目（9 枚目）の次の行は 12 枚目。中間（10.5 枚目）を狙うと抜けの中の別の絵に着く。
    expect(frameSeekSec({ pts, dur }, 10, S, 100)).toBeCloseTo(9 * S + S / 2, 9)
  })

  it('動画の長さを超えない・負にならない', () => {
    expect(frameSeekSec({ pts, dur: pts.map(() => S) }, total - 1, S, 13 * S)).toBeCloseTo(13 * S, 9)
    expect(frameSeekSec({ pts: [0], dur: [S] }, 0, S, 0)).toBe(0)
  })
})
