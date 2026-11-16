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
