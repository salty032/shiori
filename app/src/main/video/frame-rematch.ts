// 録画ファイルの絵を見て、フレーム表を作り直す手順（1 か所だけに置く）。
//
// 録画直後の確かめ（verify-clip.ts）と、テスト動画の採点（scripts/frame-test.cjs の --rematch）が
// 同じこれを呼ぶ。**以前は採点の側が手順を写して持っていて**、照合を直しても採点だけが古い手順の
// 表を採点し、「直したら良くなった」を誤って読む作りだった。
//
// electron を読み込まないこと（frame-test.cjs が .ts をそのまま読む）。
import type { SourceFrame } from './frame-feed'
import { matchFrames, type FrameMatch } from './frame-match'
import { signaturesDiffer } from './frame-verify'
import { refineByThumbnails } from './frame-thumbs'
import { alignWholeRecording } from './frame-align'

export interface RematchResult {
  matches: FrameMatch[]
  /** 時刻の照合で採ったオフセット（ミリ秒） */
  offsetMs: number
  /** 同点だったオフセットの範囲 */
  tiedRangeMs: readonly [number, number]
  /** 時刻で選んだ後、どう決め直したか（ログ用）。決め直せなかったら null */
  refined:
    | { by: 'thumbnails'; decided: number; moved: number }
    | { by: 'whole-recording'; delayMs: number; moved: number }
    | null
}

// 枚数がファイルと合うときだけ作り直す——合わないと drawnAt の添字がファイルのフレームを指さず、
// 絵を見ても別のフレームを見ることになる。作り直せなければ null。
//
// 時刻で選んだ 1 枚を、拡張が控えた各コマの絵があれば録画の画像と照合して決め直す（frame-thumbs.ts）。
// 無ければ（DRM の配信は絵が読めない）、録画全体で辻褄が合うように決め直す（frame-align.ts）。
// useThumbs: false は、控えの絵があっても無いものとして扱う（採点で DRM の決め方を試すため）。
export function rematchFromPictures(
  source: SourceFrame[], drawnAt: number[], signatures: readonly Uint8Array[],
  options: { useThumbs?: boolean } = {}
): RematchResult | null {
  if (source.length === 0 || signatures.length !== drawnAt.length) return null
  const changed = signatures.map((s, k) => k > 0 && signaturesDiffer(signatures[k - 1], s))
  const rematched = matchFrames(source, drawnAt, changed)
  if (!rematched) return null

  let matches = rematched.matches
  let refined: RematchResult['refined'] = null
  if (options.useThumbs !== false && source.some((f) => f.thumb)) {
    const r = refineByThumbnails(matches, new Map(source.map((f) => [f.mediaTime, f.thumb])), signatures)
    matches = r.matches
    refined = { by: 'thumbnails', decided: r.decided, moved: r.moved }
  } else {
    const r = alignWholeRecording(matches, source, drawnAt, changed, rematched.searchRangeMs, rematched.sourcePeriodMs)
    if (r) {
      matches = r.matches
      refined = { by: 'whole-recording', delayMs: r.delayMs, moved: r.moved }
    }
  }
  return { matches, offsetMs: rematched.offsetMs, tiedRangeMs: rematched.tiedRangeMs, refined }
}
