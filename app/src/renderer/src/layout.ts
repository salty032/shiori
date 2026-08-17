// 左サイドバー・右パネル（詳細／タイムシート）の幅の取り決め。
// Sidebar / DetailPanel / TimesheetPanel が同じ数字を見る必要があるのでここに集約する。

export const SIDEBAR_MIN_WIDTH = 210
export const SIDEBAR_MAX_WIDTH = 340
export const SIDEBAR_DEFAULT_WIDTH = 210

export const DETAIL_MIN_WIDTH = 300
export const DETAIL_MAX_WIDTH = 600
export const DETAIL_DEFAULT_WIDTH = 300

// 中央の一覧に残したい幅。サムネ最大（220px）が 2 列＋余白で並ぶ下限。
export const MIN_CONTENT_WIDTH = 520

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

// 「今のウィンドウで出してよいパネル幅の上限」。
//
// これが無いと一覧が消せる: 広い画面で両パネルを目一杯広げると、その幅が保存される
// （340 + 600 = 940px）。そのままウィンドウを最小の 960px まで縮めると中央に 20px しか
// 残らず、しかも戻す手段は「見えないパネルの端を掴んでドラッグする」しかない。
//
// 保存済みの幅そのものは書き換えない。返すのは表示上の上限だけなので、窓を広げ直せば
// 元の幅に戻る。
//
// 代償: 右パネルの上限を「サイドバーが上限まで広げられている」前提で決めるため、
// サイドバーが既定(210)のままだと右パネルは実際より狭く制限される
// （1280px なら 420 まで。中央は 650 残るのでもっと広げられるが、そうはしない）。
// 逆にすると両方を広げたときに中央が MIN_CONTENT_WIDTH を割るので、こちらへ倒している。
//
// なお 960px（ウィンドウ最小）では両方が最小幅でも中央は 450px しか残らない。
// そこは幅の取り合いでは解けないので、この関数は何もしない。
export function panelLimits(windowWidth: number): { sidebar: number; detail: number } {
  const sidebar = clamp(windowWidth - MIN_CONTENT_WIDTH - DETAIL_MIN_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
  const detail = clamp(windowWidth - MIN_CONTENT_WIDTH - sidebar, DETAIL_MIN_WIDTH, DETAIL_MAX_WIDTH)
  return { sidebar, detail }
}
