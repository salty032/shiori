// 録画に要求する映像ビットレートの決め方。
//
// recorder.ts から切り出してあるのは、あちらが MediaRecorder・getDisplayMedia・canvas を直に触る層で
// テストから駆動できないため（frame-sink.ts と同じ理由）。**決め方を変えると画質が黙って変わる**ので、
// ここだけは数値をテストで固定する。

// ビットレート算出に使う供給レートの上限。main から届く実測値が壊れていても、要求ビットレートが
// 青天井にならないようにするための多層防御（取得上限と同じ値でよい。それ以上供給されることは無い）。
export const MAX_SUPPLY_FPS_FOR_BITRATE = 120

// 素材の fps に応じてビットレートを引き上げるときの基準（この fps を 1 倍とする）。
//
// **画質を決めるのは 1 秒あたりのビット数ではなく「素材のコマ 1 つに何ビット割けたか」**
// （docs/SPEC.md「ビットレートと記録画素数」）。ところが供給（supplyFps）は内容によらず約 50枚/秒で一定なので、そこだけに
// 連動させると素材の fps が倍になった分だけ 1 コマが痩せる。実測（2026-08-13、いずれも
// 1920x1080）：目視合格した 24fps アニメ 391kbit/コマ・30fps アニメ 301kbit/コマ に対し、
// 粗が見えた 60fps は 150kbit/コマ。**解像度ではなく、素材の fps で半分になっていた。**
//
// 基準を 30 に置くのは、合格している 2 本のうち低い方に合わせるため。こうすると
// **24 / 30fps は 1 ビットも変わらない**（保証範囲で退行が起きない）。
export const BITRATE_BASE_SOURCE_FPS = 30

// 引き上げの上限（60fps 相当）。**理由は物理**：画面キャプチャの供給は約 50枚/秒が天井で
// （docs/SPEC.md「取得レートと供給」）、素材が 60fps を超えても記録できる別の絵はもう増えない。増やしても
// ファイルが太るだけになる。24Mbps は過去に実測済みの 22.4Mbps の近傍でもあり、そこでは
// エンコードが破綻しないことが分かっている（未知の水準へ踏み込まない）。
export const MAX_SOURCE_FPS_BITRATE_FACTOR = 2

/**
 * 録画に要求する映像ビットレート（bps）。
 *
 * 映像のビットレートは供給レートに合わせて上げる。1 秒あたりのビット数は同じでも、
 * 枚数が増えれば 1 フレームあたりは痩せ、アニメの線画にモスキートノイズが出るため。
 * ただし枚数の比ほどは要らない——フレームレートが上がると隣接フレームが似て、
 * フレーム間予測が効くぶん安くなる。実測では供給 1.7 倍（29→50枚/秒）に対し
 * ビットレート 1.5 倍（8→12Mbps）で元の画質水準に戻った。その比（枚数比の約 0.9 乗）
 * をそのまま延長する。
 *
 * **基準にするのは実測の供給（supplyFps）で、取得上限ではない。** 上限を 120 に
 * 上げても供給は 50.8枚/秒のままだったため（2026-08-12 実測）、上限に連動させると
 * 枚数が増えていないのにビットレートだけ 1.9 倍要求することになる（実測でファイルが
 * 45→64MB に太り、画質は変わらなかった）。main 側の recording.ts に同じ注記あり。
 *
 * @param supplyFps main が前の録画で測った供給（枚/秒）。壊れた値・0 は 60 として扱う
 * @param sourceFps これから撮る素材の fps の実測。測れていなければ null
 */
export function videoBitrateFor(supplyFps: number, sourceFps: number | null): number {
  const bitrateFps = Math.min(MAX_SUPPLY_FPS_FOR_BITRATE, Math.max(1, supplyFps || 60))
  // 素材のコマが細かいほど 1 コマあたりが痩せる分を補う（BITRATE_BASE_SOURCE_FPS 参照）。
  // **測れていなければ 1 倍＝従来どおり。推定で埋めない。** また下げる方向には効かせない
  // ——24fps 未満で減らしてよいという根拠（目視）が無く、減らす側は黙って画質を損なう。
  const sourceFactor = sourceFps && sourceFps > 0
    ? Math.min(MAX_SOURCE_FPS_BITRATE_FACTOR, Math.max(1, sourceFps / BITRATE_BASE_SOURCE_FPS))
    : 1
  return Math.round(12_000_000 * Math.pow(Math.max(1, bitrateFps / 60), 0.9) * sourceFactor)
}
