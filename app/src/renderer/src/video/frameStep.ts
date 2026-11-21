// コマ送りで「どの行へ動き、どこへシークするか」の計算。ビューア（useFramePosition）とトリミング画面
// （VideoTrimmer）の両方がこれだけを使う。
//
// **画面ごとに書かない。** 以前は 2 つの画面が別々に書いていて、撮り逃しの行で −1 コマが止まる
// 不具合がトリミング画面にだけ残った（2026-11-02。.claude/rules/frames.md「ビューアのコマ送り」）。
//
// 2 つの画面で違うのは**抜けで止まるかだけ**で、それは呼ぶ側が渡す。
// - ビューアは止まる。抜けたコマも番号に数えるので、止まらないと番号がタイムシートと食い違う。
// - トリミング画面は止まらない。抜けの位置から切っても ffmpeg は手前の絵を捨てて次の絵から始め、
//   表の引き継ぎもずれる（docs/SPEC.md「切り出し」）。切れる場所は絵のある行だけ。
import { frameSeekTarget } from './frameTable'
import { walkFrames } from './frameReadout'

/** コマ送りの位置。idx は表の行、gap はその行の後ろの抜けの何コマ目か（0 は行そのもの） */
export interface FramePos {
  idx: number
  gap: number
}

/** 抜けでも止まる（ビューア）。その行の後ろに抜けが何コマあるかを返す */
interface StopInGaps {
  missingAfter: (idx: number) => number
}

/** 絵のある行だけを渡る（トリミング画面）。動ける行の範囲を両端込みで狭められる */
interface RowsOnly {
  lo?: number
  hi?: number
}

// pos から delta コマ動いた先。total は表の行数。端で止まる。
//
// 範囲（lo / hi）は抜けで止まらないときだけ渡せる（開始を終了より前に保つのに使う）。抜けの中の
// 位置まで含めた範囲は要らないので、型で混ぜられないようにしてある。
export function stepFramePos(pos: FramePos, delta: number, total: number, mode: StopInGaps | RowsOnly): FramePos {
  if ('missingAfter' in mode) return walkFrames(pos.idx, pos.gap, delta, total, mode.missingAfter)
  const lo = mode.lo ?? 0
  const hi = mode.hi ?? total - 1
  return { idx: Math.max(lo, Math.min(pos.idx + delta, hi)), gap: 0 }
}

// idx 行の絵を映すために <video> へ渡す時刻。そのコマの長さの真ん中（frameSeekTarget）を、
// 0〜limitSec に収める。limitSec は動画の長さ（分からなければ十分大きい数）。
export function frameSeekSec(
  table: { pts: number[]; dur?: number[] }, idx: number, fallbackDur: number, limitSec: number
): number {
  return Math.max(0, Math.min(frameSeekTarget(table.pts, idx, fallbackDur, table.dur), limitSec))
}
