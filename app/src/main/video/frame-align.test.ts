import { describe, expect, it, vi } from 'vitest'

vi.mock('../browser/ws-server', () => ({ onExtensionMessage: () => () => {} }))

import { alignWholeRecording } from './frame-align'
import { matchFrames, type FrameMatch, type SourceFrame } from './frame-feed'
import recordings from './fixtures/frame-align-recordings.json'

// 60Hz の画面で 29.97fps のテスト動画を録った実際の録画 2 本（frame-test.cjs の診断から、時刻と正解だけを抜いたもの）。
//   frames: 素材のコマ [mediaTime, displayAt]  drawnAt: 撮った画像の時刻  changed: 画像ごとに 1 つ前と別の絵か（'0'/'1'）
//   picture: 画像に写っている絵の番号（読めなければ -1）  answer: 素材のコマごとの正しい絵の番号
// 作った録画では撮影の揺れ方が単純すぎて、重みを戻しても外れが出ず、テストにならなかった。
interface Recording { frames: number[][]; drawnAt: number[]; changed: string; picture: number[]; answer: number[] }
const rec = recordings as unknown as Record<'438' | '439', Recording>

// holdEvery コマごとにしか絵が変わらない録画として扱う（時刻は実際のまま。phase は区切りの位置）。
function run(r: Recording, holdEvery = 1, phase = 0) {
  const source: SourceFrame[] = r.frames.map(([mediaTime, displayAt]) => ({ mediaTime, displayAt, receivedAt: NaN }))
  const frameOfPicture = new Map<number, number>()
  r.answer.forEach((p, k) => { if (!frameOfPicture.has(p)) frameOfPicture.set(p, k) })
  const drawing = (p: number): number =>
    holdEvery === 1 ? p : Math.floor(((frameOfPicture.get(p) ?? -1) + phase) / holdEvery)
  const changed = holdEvery === 1
    ? [...r.changed].map((c) => c === '1')
    : r.picture.map((p, i) => i > 0 && drawing(p) !== drawing(r.picture[i - 1]))
  const byTime = matchFrames(source, r.drawnAt, changed)!
  const aligned = alignWholeRecording(byTime.matches, source, r.drawnAt, changed, byTime.searchRangeMs, byTime.sourcePeriodMs)!
  const answerOf = new Map(r.frames.map(([m], k) => [m, r.answer[k]]))
  // 「撮れた」としたのに別の絵の画像を指している行（注記なしの外れ）
  const silentlyWrong = (rows: FrameMatch[]): FrameMatch[] => rows.filter((m) =>
    m.captured && r.picture[m.frameIndex] >= 0 && drawing(r.picture[m.frameIndex]) !== drawing(answerOf.get(m.mediaTime)!))
  return { byTime, aligned, silentlyWrong }
}

describe('alignWholeRecording（録画全体で辻褄を合わせて決める）', () => {
  it('一度も写らなかったコマに、隣のコマの絵を「撮れた」として当てない', () => {
    // 時刻だけだと 7 行。絵が変わらないのに進む重みが 0.3 だと 6 行。残る 3 行は時刻と変わり目だけでは見分けられない。
    const { byTime, aligned, silentlyWrong } = run(rec['438'])
    expect(silentlyWrong(byTime.matches).length).toBe(7)
    expect(silentlyWrong(aligned.matches).length).toBeLessThanOrEqual(3)
  })

  it('60Hz の画面で揺れた境目でも、隣のコマの画像を選ばない', () => {
    const { byTime, aligned, silentlyWrong } = run(rec['439'])
    expect(silentlyWrong(byTime.matches).length).toBe(4)
    expect(silentlyWrong(aligned.matches)).toEqual([])
  })

  it('絵がほとんど動かない録画で、遅れをありえない値に決めて全体をずらさない', () => {
    // 遅れの前提が無いと、遅れを -7〜-9ms に決めて 25〜31 行外れた。
    for (const phase of [0, 3]) {
      const { aligned, silentlyWrong } = run(rec['439'], 6, phase)
      expect(aligned.delayMs).toBeGreaterThan(0)
      expect(silentlyWrong(aligned.matches)).toEqual([])
    }
  })

  it('コマの並びは逆戻りしない', () => {
    for (const r of Object.values(rec)) {
      const idx = run(r).aligned.matches.map((m) => m.frameIndex)
      expect(idx).toEqual([...idx].sort((a, b) => a - b))
    }
  })
})
