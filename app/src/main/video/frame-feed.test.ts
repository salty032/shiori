import { describe, expect, it } from 'vitest'
import { matchFrames, type SourceFrame } from './frame-feed'

// 素材のコマ（23.976fps = 41.7083ms 間隔）と、画面キャプチャ（60Hz = 16.667ms 間隔）を
// 合成して、対応付けが 1 対 1 に収まるかを検証する。実機を回さずに固められる部分。
const SRC_PERIOD = 1000 / 23.976
const CAP_PERIOD = 1000 / 60
const T0 = 1_700_000_000_000

function makeSource(count: number, startMs = T0): SourceFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    mediaTime: i * (SRC_PERIOD / 1000),
    displayAt: startMs + i * SRC_PERIOD,
    receivedAt: startMs + i * SRC_PERIOD
  }))
}

// キャプチャ経路の一定遅延 lagMs を挟んだ撮影時刻列。素材より広い範囲を覆う。
function makeDrawn(count: number, lagMs: number, startMs = T0 - 100): number[] {
  return Array.from({ length: count }, (_, i) => startMs + lagMs + i * CAP_PERIOD)
}

// 撮影時刻に現実的なばらつきを乗せる。実測では captureTime のばらつきが
// -4.1〜5.3ms だったので ±4ms 程度を再現する。テストを不安定にしないよう
// 乱数は使わず決定的な数列で作る。
function makeDrawnJittered(count: number, lagMs: number, amplitudeMs = 4): number[] {
  let seed = 12345
  return Array.from({ length: count }, (_, i) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const jitter = ((seed / 0x7fffffff) * 2 - 1) * amplitudeMs
    return T0 - 100 + lagMs + i * CAP_PERIOD + jitter
  })
}

describe('matchFrames（素材のコマと撮影フレームの対応付け）', () => {
  it('素材の全コマに別々の撮影フレームを割り当てる', () => {
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))
    expect(result).not.toBeNull()
    expect(result!.matches).toHaveLength(120)
    expect(result!.capturedRatio).toBe(1)
  })

  it('割り当てたフレーム番号は単調増加する（コマ送りが後戻りしない）', () => {
    const { matches } = matchFrames(makeSource(120), makeDrawn(400, 0))!
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].frameIndex).toBeGreaterThan(matches[i - 1].frameIndex)
    }
  })

  it('キャプチャ経路に一定の遅延があっても 1 対 1 を保つ', () => {
    // 遅延そのものは全コマが等しくずれるだけなので、コマ打ちの数え方を壊さない。
    for (const lag of [-40, -15, 0, 15, 40, 80]) {
      const result = matchFrames(makeSource(120), makeDrawn(400, lag))
      expect(result!.capturedRatio, `lag=${lag}ms`).toBe(1)
    }
  })

  it('推定した固定オフセットが実際の遅延を打ち消す向きに出る', () => {
    // 遅延が大きいほど、素材の時刻へ足すべき補正も大きくなる。
    const a = matchFrames(makeSource(120), makeDrawn(400, 0))!
    const b = matchFrames(makeSource(120), makeDrawn(400, 60))!
    expect(b.offsetMs).toBeGreaterThan(a.offsetMs)
  })

  it('素材の mediaTime をそのまま引き継ぐ（動画時刻の表示に使う）', () => {
    const source = makeSource(30)
    const { matches } = matchFrames(source, makeDrawn(200, 10))!
    matches.forEach((m, i) => expect(m.mediaTime).toBeCloseTo(source[i].mediaTime, 9))
  })

  it('撮影時刻がばらついても 24fps 素材なら 1 対 1 を保つ', () => {
    // 素材のコマ間隔 41.7ms に対し撮影は 16.7ms 間隔。±4ms のばらつきが乗っても
    // 隣の素材コマと同じ撮影フレームを掴むには足りず、余裕が残る。
    const result = matchFrames(makeSource(120), makeDrawnJittered(400, 10))!
    expect(result.capturedRatio).toBe(1)
  })

  it('十分な供給があれば全コマが「撮れた」と判定される', () => {
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))!
    expect(result.capturedRatio).toBe(1)
    expect(result.matches.every((m) => m.captured)).toBe(true)
  })

  it('供給が足りないコマを「撮れていない」と印を付ける', () => {
    // 撮影 30Hz に対し素材 60fps。素材2コマにつき撮影1枚しかないので、約半分のコマは
    // 自分の表示区間内に絵が無く、直前のコマを流用することになる。原理的に避けられない
    // ので、重要なのは黙って壊れず割合として報告することと、どのコマかが分かること。
    const source = Array.from({ length: 120 }, (_, i) => ({
      mediaTime: i / 60,
      displayAt: T0 + i * (1000 / 60),
      receivedAt: T0 + i * (1000 / 60)
    }))
    const drawnAt30Hz = Array.from({ length: 200 }, (_, i) => T0 - 100 + i * (1000 / 30))
    const result = matchFrames(source, drawnAt30Hz)!
    expect(result.capturedRatio).toBeLessThan(0.6)
    expect(result.capturedRatio).toBeGreaterThan(0.4)
    // 流用したコマは、直前のコマと同じフレーム番号を指しているはず
    result.matches.forEach((m, i) => {
      if (!m.captured && i > 0) expect(m.frameIndex).toBe(result.matches[i - 1].frameIndex)
    })
  })

  it('「撮れた」コマは必ず直前とは別のフレームを指す', () => {
    // captured の定義そのものの整合性。ここが破れると、同じ絵しか無いのに
    // 「専用の絵がある」と report してしまい、フラグの意味が失われる。
    for (const lag of [-20, 0, 20, 50]) {
      const { matches } = matchFrames(makeSource(120), makeDrawnJittered(400, lag))!
      matches.forEach((m, i) => {
        if (m.captured && i > 0) {
          expect(m.frameIndex, `lag=${lag}ms i=${i}`).not.toBe(matches[i - 1].frameIndex)
        }
      })
    }
  })

  it('入力が空なら null を返す', () => {
    expect(matchFrames([], makeDrawn(100, 0))).toBeNull()
    expect(matchFrames(makeSource(10), [])).toBeNull()
  })

  it('撮影フレームが素材より早く尽きても破綻せず、以降を未取得として扱う', () => {
    // 録画停止の前後で、素材のコマ通知だけが先に届いて撮影が尽きる状況。
    // 尽きた先を「撮れた」と偽らないことが重要（そこだけ絵が止まる）。
    const result = matchFrames(makeSource(120), makeDrawn(20, 0))!
    expect(result.matches).toHaveLength(120)
    const tail = result.matches.slice(25)
    expect(tail.every((m) => !m.captured)).toBe(true)
    // フレーム番号は範囲内に収まり、後戻りしない
    result.matches.forEach((m, i) => {
      expect(m.frameIndex).toBeLessThan(20)
      expect(m.frameIndex).toBeGreaterThanOrEqual(0)
      if (i > 0) expect(m.frameIndex).toBeGreaterThanOrEqual(result.matches[i - 1].frameIndex)
    })
  })
})
