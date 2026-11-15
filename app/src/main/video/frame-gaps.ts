// 表に入っているコマ列から、通知が来なかった区間（抜け）の場所と枚数を出す。
// 受信（frame-feed.ts）から分けた。DB（db-video-frames.ts）がこれを使うので、ここは
// ws-server などの受信側を読み込まない。
import { medianInterval } from './frame-series'

/** 表から抜けている区間。afterIndex のコマの「次」に missing コマぶん無い */
export interface FrameGap {
  afterIndex: number
  missing: number
  /**
   * 枚数が実測で裏付けられたか。
   *
   * true は「presentedFrames の差（合成へ送られた枚数）と、時刻から出した推定が一致した」。
   * false は推定だけ——**返さない環境、旧版の拡張で撮ったクリップ、そして「ブラウザが
   * そもそも描かなかった」場合**が含まれる。最後のものは presentedFrames にも入らないので、
   * 枚数は時刻からの推定に頼るしかない。
   *
   * **この違いは画面に出す。** 枚数が 1 違うと、そこから下のコマ番号が全部ずれる
   * （タイムシートは通し番号を記録している）。推定を確定として出すと、黙って誤らせる。
   */
  measured: boolean
}

/** frameGaps の入力。コマ表（StoredFrame）と録画直後の突き合わせ結果の両方が満たす形。 */
export interface GapSample {
  mediaTime: number
  presentedFrames?: number | null
}

// 表に入っているコマ列から、通知が来なかった区間を拾う。
//
// **抜けの「場所」と「合計」は必ずここから出す。** 以前は詳細パネルが fps × 尺 から
// 見積もり、同じ事実にログ 98 コマ／画面 85 コマと 2 つの数字が出ていた。それを潰した後も、
// 場所（コマ送りの表示）と合計（詳細パネル）が別々の計算で出ており、実測 82 本のうち
// 5 本で数字が食い違っていた（2026-08-26）。**同じことを 2 通りに数えない。**
//
// 周期は間隔の中央値。fitGrid の最小二乗は 20 コマ未満で使えず、実際に短いクリップ 4 本で
// 「抜けが無い」ことになっていた。抜けの判定は round(間隔/周期) の丸めしか使わないので、
// 中央値でも結果は変わらない（fitGrid も通し番号は中央値で振っている）。
// **presentedFrames があれば、そちらで裏を取る。**
//
// 時刻からの推定（round(間隔/周期)）は「欠けた区間の刻みは残っている区間と同じ」という
// 仮定に乗っていて、欠けたコマからは検算できない。一方 presentedFrames は合成へ送られた
// コマの累積数なので、通知が飛んでも飛んだぶん増えている。差から 1 を引けば、
// **通知だけが落ちたコマ数が実数で出る。**
//
// ただし **presentedFrames が拾えるのは「画面に出たのに通知が来なかった」ぶんだけ**。
// ブラウザがそもそも合成へ送らなかったコマはこちらにも入らないので、推定の方が大きくなる。
// そこで採る枚数は 2 つの大きい方——**少なく入れると、その下のコマ番号が全部ずれる**ため、
// 足りない側へ倒さない。裏が取れた（両者が一致した）ときだけ measured を立てる。
export function frameGaps(samples: readonly GapSample[]): FrameGap[] {
  if (samples.length < 3) return []
  const diffs: number[] = []
  for (let i = 1; i < samples.length; i++) diffs.push(samples[i].mediaTime - samples[i - 1].mediaTime)
  const median = medianInterval(samples.map((s) => s.mediaTime))
  if (!(median > 0)) return []
  const gaps: FrameGap[] = []
  for (let i = 0; i < diffs.length; i++) {
    const estimated = Math.round(diffs[i] / median) - 1
    const from = samples[i].presentedFrames
    const to = samples[i + 1].presentedFrames
    // 累積数が減る／進まないのは値が壊れている合図。裏取りには使わない。
    const counted = from != null && to != null && to > from ? to - from - 1 : null
    const missing = counted == null ? estimated : Math.max(counted, estimated)
    if (missing >= 1) gaps.push({ afterIndex: i, missing, measured: counted != null && counted === estimated })
  }
  return gaps
}

// 抜けの合計。**場所（frameGaps）の足し算以外で出さない。**
export function countReportDrops(samples: readonly GapSample[]): number {
  let total = 0
  for (const gap of frameGaps(samples)) total += gap.missing
  return total
}
