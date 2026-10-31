// 録画の画像を、拡張が控えた各コマの絵（SourceFrame.thumb）と照合して、どの画像がそのコマかを決め直す。
//
// 時刻だけで選ぶと、絵が切り替わる境目で隣のコマの画像を選ぶ。ページが知らせる表示時刻はブラウザの
// 目安で、画面の撮影が拾う時刻との差はコマごとに揺れる（60Hz の画面では 0〜17ms）。映像品質の測定で
// 撮った映像を元の映像に揃える一般的なやり方は、元の各コマと絵で照合し、コマの並びを逆戻りさせない
// ことで（WebRTC の frame_analyzer / video_temporal_aligner）、ここでもそれに倣う。
//
// **何コマずれるかは今までどおり時刻が決める。** 候補は時刻で選んだ画像の前後 CANDIDATE_SPAN 枚だけ。
// 絵が決めるのはその中のどれか、だけ（docs/ANIME-FRAMES.md「絵の差分をフレーム対応の土台にしない」）。
//
// 決めきれないときは動かさない。同じ絵が続くコマ（コマ打ち）はどの画像でも同じ絵なので照合しない。
// 口パクのように差が録画の圧縮の乱れと同じくらいしかないときも、近い方を決められないので動かさない。
import type { FrameMatch } from './frame-feed'

const CANDIDATE_SPAN = 2
// 隣のコマの控えとの近さの差がこれ以下なら、どちらのコマの画像か決めない。
const DECIDE_MARGIN = 0.02
// 隣り合うコマの控えどうしがこれより近ければ同じ絵（コマ打ち）とみなし、照合しない。
const SAME_PICTURE = 0.995

export function decodeThumb(base64: string | null | undefined): Uint8Array | null {
  if (!base64) return null
  try {
    return new Uint8Array(Buffer.from(base64, 'base64'))
  } catch {
    return null
  }
}

// 平均を引いて長さ 1 にする。録画と控えでは明るさの幅（色空間・圧縮）が違うので、形だけを比べる。
function normalize(pixels: Uint8Array): Float64Array | null {
  const n = pixels.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += pixels[i]
  mean /= n
  const out = new Float64Array(n)
  let norm = 0
  for (let i = 0; i < n; i++) {
    out[i] = pixels[i] - mean
    norm += out[i] * out[i]
  }
  if (norm === 0) return null
  norm = Math.sqrt(norm)
  for (let i = 0; i < n; i++) out[i] /= norm
  return out
}

function similarity(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export interface ThumbRefineResult<T extends FrameMatch> {
  matches: T[]
  /** 照合で別の画像へ移した行 */
  moved: number
  /** 照合で決められた行（動かさなかった行も含む） */
  decided: number
}

/**
 * @param matches 時刻で決めた表（mediaTime 順）
 * @param thumbs mediaTime → そのコマの控えの絵（base64）
 * @param signatures 録画ファイルの各画像の署名（ffmpeg.ts の getFrameSignatures。控えと同じ大きさ）
 */
export function refineByThumbnails<T extends FrameMatch>(
  matches: readonly T[], thumbs: ReadonlyMap<number, string | null | undefined>, signatures: readonly Uint8Array[]
): ThumbRefineResult<T> {
  const own = matches.map((m) => {
    const t = decodeThumb(thumbs.get(m.mediaTime))
    return t && t.length === signatures[0]?.length ? normalize(t) : null
  })
  const sig = new Map<number, Float64Array | null>()
  const sigAt = (i: number): Float64Array | null => {
    if (!sig.has(i)) sig.set(i, normalize(signatures[i]))
    return sig.get(i) ?? null
  }
  const out = matches.map((m) => ({ ...m }))
  let moved = 0
  let decided = 0
  for (let k = 0; k < out.length; k++) {
    const t = own[k]
    if (!t) continue
    // 隣のコマのうち、自分と違う絵のものだけを比べる相手にする。どちらも同じ絵ならコマ打ちの途中で、
    // どの画像を選んでも同じ絵なので照合しない。
    const rivals = [own[k - 1], own[k + 1]].filter(
      (r): r is Float64Array => r != null && similarity(r, t) < SAME_PICTURE
    )
    if (rivals.length === 0) continue
    const floor = k > 0 ? out[k - 1].frameIndex : 0
    const cur = out[k].frameIndex
    const marginAt = (c: number): number => {
      const s = sigAt(c)
      return s ? similarity(s, t) - Math.max(...rivals.map((r) => similarity(s, r))) : -Infinity
    }
    // 時刻で選んだ画像がすでにこのコマの絵なら動かさない（同じ絵の別の画像へ移しても見える絵は変わらない）。
    if (cur >= floor && marginAt(cur) > DECIDE_MARGIN) {
      decided++
      continue
    }
    let best = -1
    let bestMargin = -Infinity
    for (let c = Math.max(floor, cur - CANDIDATE_SPAN); c <= Math.min(signatures.length - 1, cur + CANDIDATE_SPAN); c++) {
      const margin = marginAt(c)
      if (margin > bestMargin) {
        bestMargin = margin
        best = c
      }
    }
    if (best < 0 || bestMargin <= DECIDE_MARGIN) continue
    decided++
    if (best !== cur || !out[k].captured) {
      out[k].frameIndex = best
      out[k].captured = true
      moved++
    }
  }
  // 照合で後ろへ移した行より手前を指す行が残らないようにする（コマの並びは逆戻りしない）。
  // 追い付かれた行は自分の画像を持たないので、撮り逃し（前の絵を流用）として出す。
  for (let k = 1; k < out.length; k++) {
    if (out[k].frameIndex < out[k - 1].frameIndex) {
      out[k].frameIndex = out[k - 1].frameIndex
      out[k].captured = false
      moved++
    }
  }
  return { matches: out, moved, decided }
}
