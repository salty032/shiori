import type { FrameMatch } from './frame-match'

// トリムした新クリップ用にフレーム表を作り直す。
//
// フレーム表が持つのは「元ファイルの何枚目か」なので、切り出すとその番号は使えなくなる
// （先頭が削られて全体がずれ、再エンコードで枚数自体も変わりうる）。そこで一度
// 元ファイルの時刻へ戻し、切り出し範囲で絞ってから、新ファイルの時刻列へ対応付け直す。
//
// これをやらないとトリムした瞬間にコマ精度が失われる。切り出した箇所こそ細かく見たい
// はずなので、そこで精度が落ちるのは本末転倒になる。
// 型引数で受けるのは、呼び出し元（トリミング）が渡す表が FrameMatch より広い
// （撮り逃しの検証結果 verified を持つ StoredFrame）ためで、切り出しでその情報まで
// 落とすと、トリムした瞬間に「実害なしと確認済み」だったコマが未検証へ逆戻りする。
export function sliceFrameTable<T extends FrameMatch>(
  table: T[],
  originalPts: number[],
  trimmedPts: number[],
  inSec: number
): T[] {
  if (table.length === 0 || originalPts.length === 0 || trimmedPts.length === 0) return []
  // 境界ちょうどのコマを取りこぼさないための許容幅。1コマ（最短でも 1/120 秒）より
  // 十分小さく、浮動小数点の誤差より十分大きい値。
  const EPS = 0.001
  const lastPts = trimmedPts[trimmedPts.length - 1]

  const out: T[] = []
  for (const f of table) {
    if (f.frameIndex < 0 || f.frameIndex >= originalPts.length) continue
    const shifted = originalPts[f.frameIndex] - inSec
    if (shifted < -EPS || shifted > lastPts + EPS) continue
    out.push({ ...f, frameIndex: nearestPtsIndex(trimmedPts, shifted) })
  }
  return out
}

// pts の中で t に最も近い要素の添字。pts は昇順。
function nearestPtsIndex(pts: number[], t: number): number {
  let lo = 0, hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid] < t) lo = mid + 1
    else hi = mid
  }
  // lo は t 以上の最初の位置。1 つ手前の方が近ければそちらを選ぶ。
  if (lo > 0 && Math.abs(pts[lo - 1] - t) <= Math.abs(pts[lo] - t)) return lo - 1
  return lo
}
