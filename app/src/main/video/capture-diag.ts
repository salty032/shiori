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
      ` dropped ${diag.droppedVideoFrames ?? 'n/a'}`
    : ''
  console.log(`[capture-supply] drawn ${summary.drawnPerSec.toFixed(1)}/s (${gaps})${supply}`)
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
    totalVideoFrames: num(v.totalVideoFrames),
    droppedVideoFrames: num(v.droppedVideoFrames)
  }
}
