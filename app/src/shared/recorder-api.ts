// レコーダーウィンドウ（renderer/recorder.ts）と main の間の窓口（recorder:*）の型。
// preload/recorder.ts がこの形で公開し、main の送信側（recording.ts / supply-bench.ts）も
// これに合わせる。**型の原本はここだけ**（以前は 3 か所が別々に持っていて、ずれても
// 型検査で気づけなかった）。
import type { CaptureDiag } from './capture-diag'

export type CropRect = { x: number; y: number; w: number; h: number }

// 供給レートの計測（開発時のみ。supply-bench.ts 参照）。
// 「キャプチャ本体」「canvas への描画」「エンコード」のどれが上限を決めているかを
// 切り分けるため、段階を変えながら一定時間の供給枚数を数える。
export type BenchStage = 'capture' | 'draw' | 'encode'
// ticker: 画面の隅を毎フレーム書き換えてキャプチャを誘発する。透明度だけを変えた3段階を
// 比べることで、「キャプチャが反応するのは目に見える変化なのか、ウィンドウ内容の書き換え
// そのものなのか」を切り分ける。invisible で効くなら、記録に一切写り込まずに供給を増やせる。
export type TickerMode = 'visible' | 'faint' | 'invisible'
export type BenchVariant = { name: string; stage: BenchStage; maxWidth?: number; maxFrameRate?: number; ticker?: TickerMode }
export type BenchResult = {
  name: string
  seconds: number
  /** rVFC が呼ばれた回数 */
  frames: number
  /** そのうち mediaTime が直前と異なったもの＝別フレームとして届いた枚数 */
  distinct: number
  /** video 要素が受け取った総数（getVideoPlaybackQuality） */
  totalVideoFrames: number | null
  /** 実際に得られたストリームの解像度 */
  width: number
  height: number
  error?: string
}

export type BenchRequest = { variants: BenchVariant[]; seconds: number }

// 画面キャプチャの立ち上げに要るぶんだけ（recorder:prepare）。
export interface PrepareData {
  sourceId: string
  fps: number
  sessionId: number
}

// 記録を始めるときに決まっているもの（recorder:start）。**ビットレートの根拠は準備時点では
// 確定していない**ので、こちらで受ける。
export interface StartData {
  supplyFps: number
  sourceFps: number | null
  maxSeconds: number
  /** 準備表示の消去が画面合成まで届くよう、ページ描画 ACK に余裕を足した境界。 */
  cleanAfter: number | null
  /** cleanAfter より後のキャプチャフレームを待つ絶対期限（epoch ミリ秒）。 */
  cleanFrameDeadline: number
}

// レコーダーウィンドウとの窓口（recorder:*）のチャンネル名。ShioriApi の CH とは別の契約
// （main 側の検証も isTrustedRecorderSender と別方式）なので別の表にしてあるが、**名前は両側ともここから読む**
// ——片方だけ綴りを変えると、録画が黙って始まらない・終わらない。
export const RECORDER_CH = {
  prepare: 'recorder:prepare',
  ready: 'recorder:ready',
  startBoundary: 'recorder:startBoundary',
  start: 'recorder:start',
  stop: 'recorder:stop',
  getCrop: 'recorder:getCrop',
  done: 'recorder:done',
  stopped: 'recorder:stopped',
  error: 'recorder:error',
  bench: 'recorder:bench',
  benchResult: 'recorder:benchResult',
} as const

// レコーダーが main へ知らせる失敗の符丁。main は一部を見分けて画面の文言を変え、残りは
// 「録画エラー: 符丁」と出す。**送る側はこの型でしか送れない**ので、打ち間違いは typecheck で落ちる。
export type RecorderErrorCode =
  | 'aborted'
  | 'audio_unavailable_fallback'
  | 'media_recorder_error'
  | 'no_data'
  | 'finalize_failed'
  | 'getUserMedia_not_allowed'
  | 'getUserMedia_failed'
  | 'canvas_unavailable'
  | 'crop_unavailable'
  | 'media_recorder_failed'
  | 'recorder_start_failed'
  | 'video_play_failed'

export interface RecorderApi {
  onPrepare: (cb: (data: PrepareData) => void) => void
  onStart: (cb: (data: StartData) => void) => void
  reportReady: (sessionId: number) => void
  /** 動画の先頭に使う、準備表示消去後のフレームを確認できたかを main へ返す。 */
  reportStartBoundary: (sessionId: number, confirmed: boolean) => void
  onStop: (cb: () => void) => void
  getCrop: (streamW: number, streamH: number) => Promise<CropRect | null>
  sendDone: (webm: ArrayBuffer, duration: number, sessionId: number, drawnAt: number[], diag: CaptureDiag) => void
  reportStopped: (sessionId: number) => void
  reportError: (msg: RecorderErrorCode, sessionId: number) => void
  onBench: (cb: (data: BenchRequest) => void) => void
  sendBenchResult: (results: BenchResult[]) => void
}

// ここから下は録画の画面（renderer/recorder.ts）と main の両方が読む値。**別々に書かない**
// （切り出し・書き出しの ffmpeg と録画で同じでないと、トリムした瞬間にコマ送りが重くなる・音が変わる）。

// キーフレームを入れる間隔（コマ数）。
//
// キーフレームを詰めて録る。**録画は「見る」ためではなく「1 コマずつ止めて見る」ための
// 素材なので、編集向きの入れ方にする**（業務用の編集ソフトがロングGOPの素材に対して
// 全イントラのプロキシを作るのと同じ理由。こちらは自分で録っているので元から詰められる）。
//
// 既定に任せると約 100 コマに 1 回しか入らず、コマを 1 つ表示するのに直前のキーフレーム
// から全部デコードし直すため、**キーフレームから遠いコマほど重くなる**。実測（2026-08-28・
// 手元の録画を同じ Chromium で 400 コマ送った）:
//
//   キーフレームからの距離  0-9   10-19  30-39  50-59  70-79  90-99
//   1 コマ進めるのにかかる  30ms   54ms  110ms  152ms  286ms  294ms
//
// キーフレームごとに 10ms 台へ戻るので、コマ再生の速さがのこぎり状に揺れる（むらの正体）。
// 10 コマごとに入れると最悪でも 10 コマぶんのデコードで済み、実測は 9〜40ms に収まった
// （中央値 85→19ms）。**素材 1 コマの長さ（24fps で 41.7ms）より短い**ので、待ち時間に隠れる。
//
// 値の根拠：5 コマごとにしても 19→17ms とほぼ変わらずサイズだけ増えたので 10 で止める。
// 代償はファイルサイズ +27%（実測）。画質は落ちない——同じビットレート要求で
// キーフレームだけ増やして比べたところ SSIM 0.9984→0.9979（差 0.04%）で、
// ファイルはむしろ小さくなった＝他のコマからビットを奪ってはいない。
//
// **単位はコマ数**（時間ではない）。決めたいのは「最悪どれだけデコードするか」で、
// それはコマ数そのものだから。供給レートが変わっても意味が変わらない。
export const RECORDING_KEYFRAME_INTERVAL_FRAMES = 10

// 音声ビットレートも明示する。未指定だと Chromium の控えめな既定値が使われ、
// 映像に十数 Mbps 割いているのに音だけ痩せる。Opus 192kbps はステレオ音楽が
// 十分に持つ水準で、映像側と比べれば誤差のサイズにしかならない。
export const RECORDING_AUDIO_BITS_PER_SECOND = 192_000

// 取得フレームレートの上限の上限（枚/秒）。素材のコマ 1 つに撮影 1 枚以上を確保するには
// 素材の 2 倍が要るので、対応上限の 60fps 素材に対して 120。これ以上はコマ精度に効かず、
// ソフトウェアエンコード（ハードウェアアクセラレーション OFF が必須）の負荷と
// ファイルサイズだけが増える。recorder-ipc.ts の MAX_FRAME_RATE_FOR_VALIDATION より小さいこと。
export const MAX_CAPTURE_FPS = 120
