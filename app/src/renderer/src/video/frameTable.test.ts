import { describe, expect, it } from 'vitest'
import { addPendingStep, estimatedStepTarget, findFrameIdx, frameSeekTarget, isClipUnreliable, MAX_PENDING_STEPS } from './frameTable'
import { FRAME_QUALITY } from '../../../shared/api.video'

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

  // 抜け（ページからコマの知らせが来なかった区間）をまたぐ行の回帰テスト。
  //
  // **次の行までの中央を狙うと、抜けの中のファイルコマに着地する。** 画面には手前の行の
  // 番号が出たまま、その番号とは別の絵が映る——コマ打ちを数える用途では最悪の壊れ方で、
  // しかも番号が出ている以上その場では気づけない（docs/ANIME-FRAMES.md「コマ送りが保証すべきこと」）。
  //
  // 数値は id=297（『まどか☆マギカ〈ワルプルギスの廻天〉』本予告）の実測。番号 323 は
  // ファイルのコマ 683（13.404）、次の行 324 はコマ 691（13.559）で、間の 684〜690 は
  // どの行からも指されていない。中央 13.4815 はコマ 687 に当たり、683 とは別の絵だった。
  describe('抜けをまたぐ行（id=297 の実測）', () => {
    const start = 13.404       // 行 323 ＝ ファイルのコマ 683
    const next = 13.559        // 行 324 ＝ ファイルのコマ 691
    const own = 0.020          // コマ 683 の長さ（次のファイルコマ 684 は 13.424）
    const pts = [13.369, start, next]
    const dur = [0.035, own, 0.020]

    it('長さを渡せば、そのコマの中に着く', () => {
      const target = frameSeekTarget(pts, 1, 1 / 24, dur)
      expect(target).toBeGreaterThan(start)
      expect(target).toBeLessThan(start + own)
    })

    it('長さを渡さないと、抜けの中へ落ちる（従来の壊れ方）', () => {
      const target = frameSeekTarget(pts, 1, 1 / 24)
      expect(target).toBeCloseTo(13.4815, 6)
      expect(target).toBeGreaterThan(start + own)   // 自分のコマを通り越している
    })
  })

  it('長さがあるときは、すべての行で自分のコマの中に着く', () => {
    const dur = unevenPts.map((t, i) => (i + 1 < unevenPts.length ? unevenPts[i + 1] - t : 0.04))
    unevenPts.forEach((t, i) => {
      const target = frameSeekTarget(unevenPts, i, 1 / 24, dur)
      expect(target).toBeGreaterThan(t)
      expect(target).toBeLessThan(t + dur[i])
    })
  })

  it('長さが 0 や欠けている行は、従来の出し方に落ちる', () => {
    const dur = [0, 0, 0]
    expect(frameSeekTarget([0, 0.04, 0.08], 1, 1 / 24, dur)).toBeCloseTo(0.06, 6)
    expect(frameSeekTarget([0, 0.04, 0.08], 1, 1 / 24, [])).toBeCloseTo(0.06, 6)
  })
})

describe('addPendingStep（コマ表の取得中に押されたコマ送りを溜める）', () => {
  it('押した手は捨てずに、正味の量で溜める', () => {
    expect(addPendingStep(0, 1)).toBe(1)
    expect(addPendingStep(2, 1)).toBe(3)
    // 行って戻れば同じコマ。
    expect(addPendingStep(1, -1)).toBe(0)
  })

  // 押しっぱなしまで積むと、取得できた瞬間に何十コマも飛ぶ。
  it('上限で頭打ちにする（進む側も戻る側も）', () => {
    expect(addPendingStep(MAX_PENDING_STEPS, 1)).toBe(MAX_PENDING_STEPS)
    expect(addPendingStep(-MAX_PENDING_STEPS, -1)).toBe(-MAX_PENDING_STEPS)
    expect(addPendingStep(MAX_PENDING_STEPS, -1)).toBe(MAX_PENDING_STEPS - 1)
  })
})

describe('estimatedStepTarget（コマの時刻が分からないときの fps 換算のコマ送り）', () => {
  const s24 = 1 / 24
  const frameOf = (t: number): number => Math.floor(t / s24 + 1e-6)

  it('何回進めても 1 コマずつ進む（1 コマおきに飛ばない）', () => {
    let t = 0.027 // 0 コマ目の途中
    const seen: number[] = []
    for (let i = 0; i < 6; i++) { t = estimatedStepTarget(t, s24, 1, 3); seen.push(frameOf(t)) }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('戻るときも 1 回目から 1 コマずつ戻る', () => {
    let t = (9 + 0.5) * s24
    const seen: number[] = []
    for (let i = 0; i < 3; i++) { t = estimatedStepTarget(t, s24, -1, 3); seen.push(frameOf(t)) }
    expect(seen).toEqual([8, 7, 6])
  })

  it('着くのはコマの真ん中', () => {
    expect(estimatedStepTarget(0, s24, 1, 3)).toBeCloseTo(1.5 * s24, 9)
  })

  it('端より先へは行かない', () => {
    expect(frameOf(estimatedStepTarget(0.01, s24, -1, 3))).toBe(0)
    expect(frameOf(estimatedStepTarget(3 - 0.01, s24, 1, 3))).toBe(71)
  })
})

// 「要注意」（このクリップは数えられない）の条件。詳細パネル・タイムシートの可否と同じ線。
describe('isClipUnreliable（要注意）', () => {
  const C = FRAME_QUALITY.captured, R = FRAME_QUALITY.reused, M = FRAME_QUALITY.misaligned
  const clip = (quality: number[], gaps: { animeMissing?: number }[] = []) => ({ pts: quality.map((_, i) => i / 24), quality, gaps })
  const rows = (n: number, fill: number, at: number[] = []) => Array.from({ length: n }, (_, i) => (at.includes(i) ? fill : C))

  it('ずれは 1 コマでも要注意', () => {
    expect(isClipUnreliable(clip(rows(100, M, [50])))).toBe(true)
  })
  it('撮り逃しが 5% を超えたら要注意、5% 以下なら出さない', () => {
    expect(isClipUnreliable(clip(rows(100, R, [1, 2, 3, 4, 5, 6])))).toBe(true)
    expect(isClipUnreliable(clip(rows(100, R, [1, 2, 3, 4, 5])))).toBe(false)
  })
  it('抜けが元のコマ数の 5% を超えたら要注意、5% 以下なら出さない', () => {
    expect(isClipUnreliable(clip(rows(100, C), [{ animeMissing: 6 }]))).toBe(true)
    expect(isClipUnreliable(clip(rows(100, C), [{ animeMissing: 5 }]))).toBe(false)
  })
})
