// 画面キャプチャの供給を実測するための集計。
//
// コマ送りの精度を決めているのは「素材の1コマぶんの表示区間(24fps なら 41.7ms)に、
// こちらのキャプチャが1枚でも撮れているか」で、撮れなかったコマは直前の絵を流用する
// （frame-feed.ts の captured=false）。実測では 5〜7% のコマがこれに当たる。
//
// 供給を増やせるのかを判断するには、まず「どこで枚数が減っているか」を切り分ける必要がある。
//   1. キャプチャ本体が寄越していない        → 供給を増やす余地なし。撮り逃しの補正で戦う
//   2. 寄越しているのに rVFC が観測を飛ばした → 観測経路を替えれば増える
// この 2 つは録画後の drawnAt だけでは区別できないため、レコーダー側で rVFC の
// presentedFrames の飛びと video 要素が受け取った総数を数えて持ち帰る（CaptureDiag）。
//
// ここはその数値を1行のログにまとめるための計算だけを持つ純関数。
import type { ReportDelay } from './frame-feed'

/** レコーダーウィンドウが録画中に数えた供給の内訳（recorder.ts が組み立てる） */
export interface CaptureDiag {
  /** rVFC が呼ばれた回数 */
  callbacks: number
  /** 供給側が提示したフレーム数（rVFC の presentedFrames の増分。取れなければ 0） */
  presented: number
  /** 提示されたのに rVFC が呼ばれなかった枚数（presentedFrames の飛びの合計） */
  skippedByCallback: number
  /** 同じ動画フレームの重複提示として供給を見送った回数 */
  duplicateSuppressed: number
  /**
   * captureTime が rVFC のメタデータに載らず Date.now() へ退避した枚数
   * （取れなければ null。診断が無いだけで録画には影響しない）。
   *
   * 素材のコマとの対応付けは「ページがコマを出した時刻」と「こちらが取り込んだ時刻」の差を
   * 一定と見なして補正している。captureTime は取り込み時刻そのものだが、Date.now() は
   * コールバック実行時刻で意味が違う。混ざると「遅延が一定」という前提が崩れるため、
   * 0 か全数かのどちらかであることを確かめる。
   */
  captureTimeMissing: number | null
  /**
   * レコーダーウィンドウの performance 時刻（epoch 換算）と壁時計の差（ミリ秒。取れなければ null）。
   * `logClockDiag` の説明を参照。
   */
  clockSkewMs: number | null
  /** video 要素が受け取ったフレーム総数（getVideoPlaybackQuality。取れなければ null） */
  totalVideoFrames: number | null
  /** そのうち表示に間に合わず捨てられた枚数 */
  droppedVideoFrames: number | null
}

export interface SupplySummary {
  /** 録画ファイルへ実際に供給した毎秒の枚数 */
  drawnPerSec: number
  /** 供給間隔（ミリ秒）の中央値・95パーセンタイル・最大 */
  medianGapMs: number
  p95GapMs: number
  maxGapMs: number
  /**
   * 素材のコマ1つぶんより長く空いた回数。撮り逃しはここでしか起きないので、
   * 「撮り逃したコマ数」の説明変数になる（平均レートより直接的な指標）。
   * 素材の周期が不明なら null。
   */
  longGaps: number | null
}

// 昇順に並べた配列から p（0〜1）の位置の値を線形補間なしで取る。
// 標本数が数百〜千程度なので、補間の有無で結論は変わらない。
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[idx]
}

// drawnAt（供給した各フレームの取り込み時刻・epoch ミリ秒）から供給の性質を要約する。
// 平均レートだけでは「たまたま長く空いた瞬間」が見えず、撮り逃しの原因を説明できない。
export function summarizeSupply(
  drawnAt: number[],
  duration: number,
  sourcePeriodMs: number | null
): SupplySummary | null {
  if (drawnAt.length < 2 || !(duration > 0)) return null
  const gaps: number[] = []
  for (let i = 1; i < drawnAt.length; i++) {
    const gap = drawnAt[i] - drawnAt[i - 1]
    // 時刻が逆行している標本は捨てる（captureTime が無く Date.now() へ退避した箇所と
    // 混在すると、経路の違いで前後することがある）。
    if (gap >= 0) gaps.push(gap)
  }
  if (gaps.length === 0) return null
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    drawnPerSec: drawnAt.length / duration,
    medianGapMs: percentile(sorted, 0.5),
    p95GapMs: percentile(sorted, 0.95),
    maxGapMs: sorted[sorted.length - 1],
    longGaps: sourcePeriodMs && sourcePeriodMs > 0
      ? gaps.filter((g) => g > sourcePeriodMs).length
      : null
  }
}

// 供給の実測を1行だけ残す。出力は英語（dev.bat のコンソールは Shift-JIS のため）。
//
// 読み方:
//   received ≈ drawn  → キャプチャ本体が寄越していない。供給を増やす余地は無い
//   received >> drawn → 観測経路（rVFC）で落としている。読み出し方を替えれば増える
export function logSupplyDiag(summary: SupplySummary | null, diag: CaptureDiag | null): void {
  if (!summary) {
    console.log('[capture-supply] no timing samples')
    return
  }
  const gaps =
    `gap p50 ${summary.medianGapMs.toFixed(1)}ms p95 ${summary.p95GapMs.toFixed(1)}ms max ${summary.maxGapMs.toFixed(1)}ms` +
    (summary.longGaps === null ? '' : `, ${summary.longGaps} gaps longer than one source frame`)
  const supply = diag
    ? ` | rVFC callbacks ${diag.callbacks} (presented ${diag.presented}, skipped ${diag.skippedByCallback},` +
      ` duplicate ${diag.duplicateSuppressed}), element received ${diag.totalVideoFrames ?? 'n/a'}` +
      ` dropped ${diag.droppedVideoFrames ?? 'n/a'}` +
      // 0 なら全フレームが取り込み時刻（captureTime）を持てている＝対応付けの前提が成り立つ。
      // 全数なら Date.now()（コールバック実行時刻）に落ちており、遅延の性質が変わる。
      // 途中の値なら 2 種類の時刻が混ざっていて最も悪い（一定オフセットで補正できない）。
      ` | captureTime missing ${diag.captureTimeMissing ?? 'n/a'}`
    : ''
  console.log(`[capture-supply] drawn ${summary.drawnPerSec.toFixed(1)}/s (${gaps})${supply}`)
}

// 2 つの時計の基準を 1 行にまとめる（1録画1行。出力は英語）。
//
// **オフセット（frame-feed.ts の offsetMs）が録画ごとに振れる理由を切り分けるための実測。**
// 突き合わせている 2 つの時刻は、どちらも別プロセスの単調時計を各々の epoch へ直した値：
//   displayAt = 配信ページ(Chrome)の timeOrigin + expectedDisplayTime
//   drawnAt   = レコーダー(Electron)の timeOrigin + captureTime
// timeOrigin は文書の生成時刻で固定される一方 now() は単調時計で進むため、壁時計との差は
// 文書の寿命ぶん開く。**両者で差が違えば、その差はそのまま offsetMs に乗る。**
//
// 読み方:
//   report delay min が -30ms より負に大きい → ページ側の時計がずれている
//     （転送の遅れは 0 以上、expectedDisplayTime が未来を指すぶんも 1〜2 vsync ＝ 16〜33ms まで。
//      それを超える負値はこの 2 つでは説明できない）
//   recorder skew が 0 から離れている        → レコーダー側の時計がずれている
//   両者の差が録画ごとの offset の振れと一致  → 振れの正体は時計の基準差。実遅延は定数として
//                                             確定でき、探索は ±(素材コマ/2) に絞れる
export function logClockDiag(delay: ReportDelay | null, diag: CaptureDiag | null): void {
  const page = delay
    ? `page report delay min ${delay.minMs.toFixed(1)}ms p50 ${delay.medianMs.toFixed(1)}ms (${delay.count} reports)`
    : 'page report delay n/a'
  const rec = diag && diag.clockSkewMs !== null
    ? `recorder perf-epoch - wall clock ${diag.clockSkewMs.toFixed(1)}ms`
    : 'recorder perf-epoch - wall clock n/a'
  console.log(`[clock-base] ${page} | ${rec}`)
}

// レコーダー（別プロセス）から届く診断値の検証。壊れていても録画の保存は続けたいので、
// 例外にはせず「診断が無い」ものとして null を返す。
export function parseCaptureDiag(value: unknown): CaptureDiag | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const callbacks = num(v.callbacks)
  const presented = num(v.presented)
  const skippedByCallback = num(v.skippedByCallback)
  const duplicateSuppressed = num(v.duplicateSuppressed)
  if (callbacks === null || presented === null || skippedByCallback === null || duplicateSuppressed === null) return null
  return {
    callbacks,
    presented,
    skippedByCallback,
    duplicateSuppressed,
    // 診断の補助項目なので、欠けていても診断全体は捨てない（totalVideoFrames と同じ扱い）。
    captureTimeMissing: num(v.captureTimeMissing),
    clockSkewMs: num(v.clockSkewMs),
    totalVideoFrames: num(v.totalVideoFrames),
    droppedVideoFrames: num(v.droppedVideoFrames)
  }
}
