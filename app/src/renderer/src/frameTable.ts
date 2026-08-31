// クリップの実フレーム時刻（PTS）テーブルを扱う共通ロジック。
//
// 録画クリップは可変フレームレートで記録されるうえ、素材そのものが 2コマ打ち・3コマ打ちを
// 混在させているため、フレームの間隔は一定ではない。1/fps の固定刻みでシークすると
// 「間隔より刻みが小さければ同じコマに留まり、大きければ 2 コマ飛ぶ」ことになり、
// コマを数えたい用途では使い物にならない。実 PTS を辿ることでその両方を防ぐ。
//
// トリマー（video/）とビューアのプレーヤー（components/）の双方から使うため、
// どちらにも寄せずコア側の独立モジュールに置く。
import { FRAME_QUALITY, SEVERE_FRAME_RATIO } from '../../shared/api.video'

export const FRAME_EPS = 0.0005  // 0.5ms: mediaTime と framePts の浮動小数点誤差を吸収

// 実体は shared/api.video.ts。タイムシートの可否（shared 側）が同じ数字で決まるよう
// 共通側へ移したが、読み手はここを見ているのでそのまま出し直す。
export { SEVERE_FRAME_RATIO } from '../../shared/api.video'

// このクリップのコマ送りが、どこを見ても当てにならないか。
//
// **抜けが 1 つでもあれば赤、にはしない**（docs/ANIME-FRAMES.md 0 章）。ずれ（misaligned）は
// 崩れた位置から末尾まで続くので 1 コマでもあれば全体の話、抜けは割合で見る。
export function isClipUnreliable(
  frames: { pts: number[]; quality?: number[]; gaps?: { missing: number }[] } | null
): boolean {
  if (!frames) return false
  if ((frames.quality ?? []).some((q) => q === FRAME_QUALITY.misaligned)) return true
  const missing = (frames.gaps ?? []).reduce((sum, g) => sum + g.missing, 0)
  return missing > 0 && missing / (frames.pts.length + missing) > SEVERE_FRAME_RATIO
}

// idx 番目のフレームを確実に表示させるためのシーク先。
//
// フレームの開始時刻ちょうどを指すと、浮動小数点の丸めやデコーダの解釈差で隣のフレームに
// 着地することがあり、「1 回押したのに動かない／2 コマ進む」の原因になる。表示区間の中央を
// 狙えば必ずそのフレームに入る（拡張側のコマ送りが ±1.5/0.5 コマずらすのと同じ考え方）。
//
// **中央は「そのコマ自身の長さ」から出す（dur）。次の行までの中央ではない。**
//
// 行と行の間は、抜け（ページからコマの知らせが来なかった区間）があると広く空く。そこの
// 中央を狙うと**抜けの中のファイルコマに着地し、番号と違う絵が出る。** id=297 の番号 323 が
// 実例で、13.404 と 13.559 の中央 13.4815 はファイルのコマ 687（別の絵）だった——画面には
// 「323」と出たまま、コマ表からは到達できないはずの絵が映っていた（2026-08-31）。
//
// dur は録画ファイル側の実測（ipc-video.ts の fileFrameDur）。**無い場合は従来どおり
// 次の行までの中央で代用する**——古い取得結果や、dur を持たない呼び出し元があるため。
// 末尾フレームは次の PTS が無いので、直前の間隔を継続すると見なす。
export function frameSeekTarget(pts: number[], idx: number, fallbackDur: number, dur?: number[]): number {
  const start = pts[idx]
  const own = dur?.[idx]
  if (own !== undefined && own > 0) return start + own / 2
  if (idx + 1 < pts.length) return (start + pts[idx + 1]) / 2
  const prevGap = idx > 0 ? start - pts[idx - 1] : fallbackDur
  return start + prevGap / 2
}

// pts[i] <= t + EPS を満たす最大の i を返す（表示中フレームのインデックス）
export function findFrameIdx(pts: number[], t: number): number {
  if (pts.length === 0) return 0
  if (t <= pts[0]) return 0
  const last = pts.length - 1
  if (t >= pts[last]) return last
  let lo = 0, hi = last
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid] <= t + FRAME_EPS) lo = mid
    else hi = mid
  }
  return lo
}
