import { describe, expect, it } from 'vitest'
import { sliceFrameTable, type FrameMatch } from './frame-feed'

// 元クリップ: 24fps 相当のフレーム表を、33fps 前後で撮れた実ファイルに対して持つ想定。
// トリムすると先頭が削られてフレーム番号がずれ、再エンコードで枚数も変わりうるため、
// 一度時刻へ戻してから新ファイルのフレームへ対応付け直せているかを検証する。
const ORIG_PTS = Array.from({ length: 200 }, (_, i) => i * 0.03)     // 元ファイル: 約33fps
const SRC_PERIOD = 1 / 23.976

function makeTable(count: number, everyNthUncaptured = 0): FrameMatch[] {
  return Array.from({ length: count }, (_, i) => ({
    mediaTime: i * SRC_PERIOD,
    // 素材の各コマが元ファイルのどのフレームに写っているか（約1.4倍のオーバーサンプリング）
    frameIndex: Math.round((i * SRC_PERIOD) / 0.03),
    captured: everyNthUncaptured === 0 || i % everyNthUncaptured !== 0
  }))
}

describe('sliceFrameTable（トリム後のフレーム表の作り直し）', () => {
  const table = makeTable(100)

  it('切り出し範囲内のコマだけを残す', () => {
    const trimmed = Array.from({ length: 67 }, (_, i) => i * 0.03)   // 2.0 秒ぶん
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 1.0)
    expect(out.length).toBeGreaterThan(0)
    // 元の時刻が 1.0〜3.0 秒に入るコマだけが残る
    const first = out[0].mediaTime
    const last = out[out.length - 1].mediaTime
    expect(first).toBeGreaterThanOrEqual(1.0 - SRC_PERIOD)
    expect(last).toBeLessThanOrEqual(3.0 + SRC_PERIOD)
  })

  it('振り直した後も、各コマが指す時刻が元と一致する', () => {
    // これが本質。番号は変わってよいが、指している瞬間がずれてはいけない。
    // ずれると、コマ送りで出る絵が素材のコマと食い違う。
    const trimmed = Array.from({ length: 67 }, (_, i) => i * 0.03)
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 1.0)
    expect(out.length).toBeGreaterThan(0)
    out.forEach((f) => {
      const original = table.find((o) => o.mediaTime === f.mediaTime)!
      const expectedTime = ORIG_PTS[original.frameIndex] - 1.0
      // 新ファイルのフレーム間隔（0.03秒）の半分以内に収まっていれば、同じ絵を指している
      expect(Math.abs(trimmed[f.frameIndex] - expectedTime)).toBeLessThanOrEqual(0.015 + 1e-9)
    })
  })

  it('新しいファイルの範囲内の番号だけを返す', () => {
    const trimmed = Array.from({ length: 67 }, (_, i) => i * 0.03)
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 1.0)
    // 元の番号（33 前後から始まる）のままではなく、先頭付近へ戻っていること
    expect(out[0].frameIndex).toBeLessThan(5)
    out.forEach((f) => expect(f.frameIndex).toBeLessThan(trimmed.length))
  })

  it('フレーム番号は後戻りしない（コマ送りの単調性）', () => {
    const trimmed = Array.from({ length: 67 }, (_, i) => i * 0.03)
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 1.0)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].frameIndex).toBeGreaterThanOrEqual(out[i - 1].frameIndex)
    }
  })

  it('素材の時刻（mediaTime）はそのまま保つ', () => {
    const trimmed = Array.from({ length: 67 }, (_, i) => i * 0.03)
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 1.0)
    const original = table.find((f) => Math.abs(f.mediaTime - out[0].mediaTime) < 1e-9)
    expect(original).toBeDefined()
  })

  it('未取得の印を引き継ぐ', () => {
    const withGaps = makeTable(100, 5)
    const trimmed = Array.from({ length: 67 }, (_, i) => i * 0.03)
    const out = sliceFrameTable(withGaps, ORIG_PTS, trimmed, 1.0)
    expect(out.some((f) => !f.captured)).toBe(true)
    expect(out.some((f) => f.captured)).toBe(true)
  })

  it('先頭から切り出す場合は全コマが残る', () => {
    const trimmed = [...ORIG_PTS]
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 0)
    expect(out).toHaveLength(table.length)
    expect(out[0].frameIndex).toBe(table[0].frameIndex)
  })

  it('再エンコードでフレーム数が変わっても対応付けられる', () => {
    // 新ファイルが 60fps で吐かれた場合（元は 33fps）。番号は変わるが時刻で対応する。
    const trimmed = Array.from({ length: 120 }, (_, i) => i * (1 / 60))
    const out = sliceFrameTable(table, ORIG_PTS, trimmed, 1.0)
    expect(out.length).toBeGreaterThan(0)
    out.forEach((f) => expect(f.frameIndex).toBeLessThan(trimmed.length))
    for (let i = 1; i < out.length; i++) {
      expect(out[i].frameIndex).toBeGreaterThanOrEqual(out[i - 1].frameIndex)
    }
  })

  it('入力が空なら空を返す（呼び出し側は保存しない）', () => {
    expect(sliceFrameTable([], ORIG_PTS, ORIG_PTS, 0)).toEqual([])
    expect(sliceFrameTable(table, [], ORIG_PTS, 0)).toEqual([])
    expect(sliceFrameTable(table, ORIG_PTS, [], 0)).toEqual([])
  })

  it('範囲外を指すフレーム番号は捨てる（壊れた表で落ちない）', () => {
    const broken: FrameMatch[] = [
      { mediaTime: 0, frameIndex: -1, captured: true },
      { mediaTime: 0.04, frameIndex: 9999, captured: true },
      { mediaTime: 0.08, frameIndex: 2, captured: true }
    ]
    const out = sliceFrameTable(broken, ORIG_PTS, [...ORIG_PTS], 0)
    expect(out).toHaveLength(1)
    expect(out[0].mediaTime).toBe(0.08)
  })
})
