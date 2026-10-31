// 各コマの絵の控え（SourceFrame.thumb）が無いとき（DRM の配信）、録画の画像とコマの対応を
// 録画全体で辻褄が一番合うように決め直す。
//
// 時刻だけで 1 コマずつ選ぶと、60Hz の画面ではページが知らせる表示時刻と撮影の時刻の差がコマごとに
// 揺れ、絵が切り替わる境目で隣のコマの画像を選ぶ。ここでは撮った画像ごとに「どのコマが写っているか」を
// 録画の頭から終わりまでまとめて決める（動的計画法。前例は映像の時間合わせ US7366361B2）。
// 不自然な点を 3 つ数え、合計が最も小さい対応を採る。
//   - 画像の時刻が、そのコマが画面に出ている区間から外れている
//   - 絵が変わったのに同じコマに留まる
//   - 絵が変わっていないのに次のコマへ進む
// コマは逆戻りさせない。どの画像も当たらなかったコマは撮り逃し（前の画像を流用）として出す。
// 決めた理由と試して却下したことは docs/SPEC.md「録画全体で辻褄を合わせて決める（frame-align.ts）」。
import type { FrameMatch, SourceFrame } from './frame-feed'

// 時刻が区間から外れた量をこの幅で割って 2 乗する。
const TIME_TOLERANCE_MS = 6
const STAY_ON_CHANGE = 6
// 0.3 だと、一度も写らなかったコマに隣の絵を「撮れた」として当てていた。8 だとコマ打ちで外れが跳ねる。
const ADVANCE_WITHOUT_CHANGE = 1
// 画像ごとに、時刻から推したコマの前後これだけを候補にする。
const CANDIDATE_FRAMES = 3
// 遅れは録画全体で 1 つ。絵の変わり目が少ない録画では点の差が付かず、ありえない短さ（負）に
// 張り付いて外れが今の版の 5〜10 倍になったので、ふつうの値から離れるほど点を足す。
// 絵が毎コマ変わる録画では変わり目の点の方がずっと大きく、結果は変わらない。
const TYPICAL_DELAY_MS = 13
const DELAY_SPREAD_MS = 5
const DELAY_PRIOR = 3
// 遅れは matchFrames の窓の下端より少し下から探す。窓の下端ちょうどからにすると、
// 実アニメの録画で正しい遅れ（窓の 1ms 下）が範囲の外になった。
const SEARCH_BELOW_MS = 10

interface Alignment {
  /** 画像ごとに写っているコマの番号 */
  frameOf: Int32Array
  cost: number
}

function align(
  starts: readonly number[], ends: readonly number[], drawnAt: readonly number[],
  changed: readonly boolean[], delayMs: number
): Alignment {
  const N = starts.length
  const M = drawnAt.length
  const timeCost = (i: number, f: number): number => {
    const x = drawnAt[i] - delayMs
    const d = x < starts[f] ? starts[f] - x : x >= ends[f] ? x - ends[f] : 0
    return (d / TIME_TOLERANCE_MS) ** 2
  }
  const los = new Int32Array(M)
  const costs: Float64Array[] = []
  const backs: Int32Array[] = []
  let guess = 0
  for (let i = 0; i < M; i++) {
    while (guess + 1 < N && starts[guess + 1] <= drawnAt[i] - delayMs) guess++
    let lo = Math.max(0, guess - CANDIDATE_FRAMES)
    const hi = Math.min(N - 1, guess + CANDIDATE_FRAMES)
    let cost = new Float64Array(hi - lo + 1).fill(Infinity)
    let back = new Int32Array(hi - lo + 1).fill(-1)
    let reached = false
    for (let f = lo; f <= hi; f++) {
      if (i === 0) {
        cost[f - lo] = timeCost(0, f)
        reached = true
        continue
      }
      const plo = los[i - 1]
      const prev = costs[i - 1]
      let best = Infinity
      let from = -1
      for (let pf = plo; pf <= Math.min(f, plo + prev.length - 1); pf++) {
        if (!Number.isFinite(prev[pf - plo])) continue
        const step = changed[i] && pf === f ? STAY_ON_CHANGE : !changed[i] && f > pf ? ADVANCE_WITHOUT_CHANGE * (f - pf) : 0
        if (prev[pf - plo] + step < best) {
          best = prev[pf - plo] + step
          from = pf
        }
      }
      if (from >= 0) {
        cost[f - lo] = best + timeCost(i, f)
        back[f - lo] = from
        reached = true
      }
    }
    // 前の画像の候補がすべてこの画像の候補より後ろなら（時刻が大きく揺れた）、前と同じコマに留める。
    if (!reached) {
      lo = los[i - 1]
      const prev = costs[i - 1]
      cost = prev.map((c, k) => c + timeCost(i, lo + k))
      back = Int32Array.from(prev, (_, k) => lo + k)
    }
    los[i] = lo
    costs.push(cost)
    backs.push(back)
  }
  const last = costs[M - 1]
  let end = 0
  for (let k = 1; k < last.length; k++) if (last[k] < last[end]) end = k
  const frameOf = new Int32Array(M)
  let f = los[M - 1] + end
  for (let i = M - 1; i >= 0; i--) {
    frameOf[i] = f
    f = backs[i][f - los[i]]
  }
  return { frameOf, cost: last[end] }
}

export interface AlignResult<T extends FrameMatch> {
  matches: T[]
  delayMs: number
  /** 時刻で選んだ表から別の画像へ移した行 */
  moved: number
}

/**
 * @param rows matchFrames が時刻と絵で決めた表（録画範囲外のコマを除いた行）。行の集合はそのまま使う
 * @param source 録画中に届いた素材のコマ通知
 * @param changed 録画ファイルの各画像が 1 つ前と別の絵か
 * @param searchRangeMs matchFrames が探した遅れの窓
 */
export function alignWholeRecording<T extends FrameMatch>(
  rows: readonly T[], source: readonly SourceFrame[], drawnAt: readonly number[],
  changed: readonly boolean[], searchRangeMs: readonly [number, number], periodMs: number
): AlignResult<T> | null {
  if (rows.length === 0 || drawnAt.length === 0 || changed.length !== drawnAt.length) return null
  const frames: SourceFrame[] = []
  for (const f of source) if (frames[frames.length - 1]?.mediaTime !== f.mediaTime) frames.push(f)
  const starts = frames.map((f) => f.displayAt)
  const ends = starts.map((s, k) => k + 1 < starts.length ? starts[k + 1] : s + (s - (starts[k - 1] ?? s) || periodMs))

  let best: (Alignment & { delayMs: number }) | null = null
  for (let delayMs = searchRangeMs[0] - SEARCH_BELOW_MS; delayMs <= searchRangeMs[1]; delayMs++) {
    const a = align(starts, ends, drawnAt, changed, delayMs)
    const cost = a.cost + DELAY_PRIOR * ((delayMs - TYPICAL_DELAY_MS) / DELAY_SPREAD_MS) ** 2
    if (!best || cost < best.cost) best = { ...a, cost, delayMs }
  }
  if (!best) return null

  // コマごとに、そのコマとされた画像の真ん中の 1 枚を使う（端の 1 枚は隣のコマとの境目に近い）。
  const capturesOf = new Map<number, number[]>()
  best.frameOf.forEach((f, i) => {
    const list = capturesOf.get(f)
    if (list) list.push(i)
    else capturesOf.set(f, [i])
  })
  const frameOfTime = new Map(frames.map((f, k) => [f.mediaTime, k]))
  let moved = 0
  const matches: T[] = []
  for (const row of rows) {
    const list = capturesOf.get(frameOfTime.get(row.mediaTime) ?? -1)
    const prev = matches[matches.length - 1]
    const next = list
      ? { ...row, frameIndex: list[(list.length - 1) >> 1], captured: true }
      : { ...row, frameIndex: prev ? prev.frameIndex : row.frameIndex, captured: false }
    if (next.frameIndex !== row.frameIndex || next.captured !== row.captured) moved++
    matches.push(next)
  }
  return { matches, delayMs: best.delayMs, moved }
}
