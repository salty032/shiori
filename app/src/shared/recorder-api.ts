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
}

export interface RecorderApi {
  onPrepare: (cb: (data: PrepareData) => void) => void
  onStart: (cb: (data: StartData) => void) => void
  reportReady: (sessionId: number) => void
  onStop: (cb: () => void) => void
  getCrop: (streamW: number, streamH: number) => Promise<CropRect | null>
  sendDone: (webm: ArrayBuffer, duration: number, sessionId: number, drawnAt: number[], diag: CaptureDiag) => void
  reportStopped: (sessionId: number) => void
  reportError: (msg: string, sessionId: number) => void
  onBench: (cb: (data: BenchRequest) => void) => void
  sendBenchResult: (results: BenchResult[]) => void
}
