// 素材のコマ列を読むときの共通の下ごしらえ。
//
// 同じ計算が frame-feed / frame-verify / frame-align に別々に書かれていて、1 か所だけ直すと
// 同じ録画の素材のコマ長や重複の扱いが経路ごとに食い違う形だった。
// frame-align は frame-feed から型しか読まない（値を読むと ws-server まで連れてくる）ので、ここに置く。
import type { SourceFrame } from './frame-feed'

// 隣り合う時刻の間隔の中央値（偶数個なら上側）。間隔が 1 つも無ければ 0。
// 素材のコマ長は fps 列からではなく、これで表の mediaTime から出す（fps 列は空のことがある）。
//
// positiveOnly は 0 以下と非有限の間隔を捨ててから取る（frame-verify の抜け推定だけがこちら。
// 他と揃えると結果が変わりうるので、違いはここで名乗らせて残してある）。
export function medianInterval(times: readonly number[], opts: { positiveOnly?: boolean } = {}): number {
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1]
    if (opts.positiveOnly && !(d > 0 && Number.isFinite(d))) continue
    gaps.push(d)
  }
  gaps.sort((a, b) => a - b)
  return gaps.length ? gaps[gaps.length >> 1] : 0
}

// 同じ素材コマが 2 回以上通知されることがある（コンポジタが同じフレームを再提示すると
// ページ側の rVFC がもう一度発火する）。mediaTime が同じなら同じコマなので、最初の通知
// ——実際に画面へ出た時刻——だけを残す。
//
// **presentedFrames はここで詰め直す。** あの値は「合成へ送られた回数」なので、同じコマの
// 再提示でも増える。畳んだ後の隣り合うコマで差を取ると、再提示のぶんだけ「通知が来なかった
// コマ」に見えてしまう——**抜けを水増しし、灰色の行を増やす方向の誤り**で、コマ番号が
// 後ろへずれる。ここまでに落とした重複の数を引いておけば、差は「別のコマが何枚送られたか」になる。
export function collapseDuplicateReports(source: readonly SourceFrame[]): SourceFrame[] {
  const frames: SourceFrame[] = []
  let duplicateReports = 0
  for (const f of source) {
    const prev = frames[frames.length - 1]
    if (prev && prev.mediaTime === f.mediaTime) {
      duplicateReports++
      continue
    }
    frames.push(
      f.presentedFrames == null ? f : { ...f, presentedFrames: f.presentedFrames - duplicateReports }
    )
  }
  return frames
}
