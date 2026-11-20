// 「このクリップは抜け・撮り逃しが多すぎる」の線。**式はここにしか置かない。**
//
// しきい値（SEVERE_FRAME_RATIO）は 1 つだったが、割る式がビューアのコマ表示・この録画の状態・
// タイムシートの可否・詳細パネルに別々に書かれていた。1 か所だけ母数を変えると、同じ録画が
// 画面ごとに赤かったり白かったりする（docs/SPEC.md の方針：同じ録画で、画面のどこか 1 つだけ
// 赤くなる状態を作らない）。
import { SEVERE_FRAME_RATIO, type ClipGap } from './api.video'

/**
 * 表から抜けているコマ数の合計。**数えるのはアニメとしての抜け（animeMissing）だけ。**
 * 通知欠落数（missing）は混ぜない——2 コマ打ちの境界をまたぐと 1 多く出る（api.video.ts の ClipGap）。
 * 枚数を推定できなかった抜けは 0 として数える。
 */
export function missingFrameCount(gaps: readonly Pick<ClipGap, 'animeMissing'>[] | null | undefined): number {
  return (gaps ?? []).reduce((sum, gap) => sum + (gap.animeMissing ?? 0), 0)
}

/**
 * 抜けが多すぎるか。**母数は「表の行数＋抜け」**（＝元の動画のコマ数）。
 * 行数だけで割ると、抜けが多い録画ほど母数が小さくなって割合が水増しされる。
 */
export function isMissingSevere(rows: number, missing: number): boolean {
  return missing > 0 && missing / (rows + missing) > SEVERE_FRAME_RATIO
}

/**
 * 撮り逃し（表に行はあるが、専用の絵が無く直前の絵を出しているコマ）が多すぎるか。
 * **母数は表の行数。** 行数が分からない（0）ときは「多すぎる」とは言わない。
 */
export function isReuseSevere(reused: number, rows: number): boolean {
  return rows > 0 && reused / rows > SEVERE_FRAME_RATIO
}

/**
 * コマの精度を保証する素材 fps の上限（2026-11-20 本人の判断）。29.97 / 30fps を含むよう幅を持たせる。
 * これを超える素材は、今の撮り方では毎秒の供給がコマ数に届かず全部は撮れない（docs/ANIME-FRAMES.md
 * 「コマ送りが保証すべきこと」）うえ、作画のコマを数える対象でもない（タイムシートは 24fps 前後だけ）。
 * 判定（要注意・撮り逃し・抜け）を出しても意味が無いので出さず、「精度保証外」とだけ出す。
 */
export const PRECISION_FPS_MAX = 30.5

/** この素材 fps でコマの精度を保証するか。fps が分からない録画は今までどおり判定する（true）。 */
export function isPrecisionGuaranteed(fps: number | null | undefined): boolean {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return true
  return fps <= PRECISION_FPS_MAX
}
