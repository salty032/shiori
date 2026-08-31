import fixWebmDuration from 'fix-webm-duration'
import { createFrameSink } from './frame-sink'

export {}

type CropRect = { x: number; y: number; w: number; h: number }

// 供給の内訳（main の capture-diag.ts が受け取って1行のログにする）。
// 「キャプチャ本体が寄越していないのか、寄越しているのに rVFC が観測を飛ばしたのか」を
// 切り分けるための計測値で、録画の成否には一切関与しない。
type CaptureDiag = {
  callbacks: number
  presented: number
  skippedByCallback: number
  duplicateSuppressed: number
  /**
   * captureTime が rVFC のメタデータに載らず Date.now() へ退避した枚数。
   *
   * 素材のコマとファイル内フレームの対応付けは「ページ側がコマを出した時刻」と
   * 「こちらがそのコマを取り込んだ時刻」の差を一定と見なして補正している
   * （frame-feed.ts の offsetMs）。captureTime はフレームが取り込まれた時刻そのものだが、
   * getDisplayMedia 経由で載るかは実装依存で、載らなければコールバック実行時刻へ落ちる。
   * この2つは意味が違うので、混在すると「遅延が一定」という前提自体が崩れる。
   * 0 か全数かのどちらかであることを確かめるために数える。
   */
  captureTimeMissing: number
  /**
   * このウィンドウの performance 時刻を epoch へ直した値と、壁時計との差（ミリ秒）。
   * `(performance.timeOrigin + performance.now()) - Date.now()`。
   *
   * drawnAt はここの `timeOrigin + captureTime`、配信ページ側の displayAt は Chrome 側の
   * `timeOrigin + expectedDisplayTime` で、**別プロセスの単調時計を各々の epoch へ直した値**。
   * timeOrigin は文書の生成時刻で固定される一方 now() は単調時計で進むので、壁時計との差は
   * 文書の寿命ぶん開く。両プロセスでこの差が違えば、差はそのまま offsetMs に乗る
   * （録画ごとにオフセットが振れる理由の候補。frame-feed.ts の ReportDelay と対で読む）。
   */
  clockSkewMs: number
  totalVideoFrames: number | null
  droppedVideoFrames: number | null
  /** ティッカーが画面を書き換えた回数。供給の天井の切り分けに使う（main の CaptureDiag 参照） */
  tickerTicks: number | null
  /** MediaRecorder に要求した映像ビットレート（bps） */
  videoBitsPerSecond: number | null
  /**
   * キャプチャストリームが実際に返したフレームの画素数。
   *
   * getDisplayMedia には解像度の制約を付けていない（frameRate だけ）ので、Chromium が
   * 画面の物理解像度より小さいストリームを返しても**こちらは気付けない**——クロップ計算は
   * `screenshotDpr = frameW / bounds.width` で吸収してしまうため、黙って低解像度で
   * 録れてしまう。画面の物理解像度と並べて出すためにここで測る。
   *
   * **`track.getSettings()` ではなく `<video>` の実寸を使うこと。** 前者が返すのは
   * 実フレームではなく公称の最大枠で、実測では 1920x1080 の画面に対し **1920x1920**
   * （回転を許す正方形の枠）が返った。そのまま比べると毎回「画面と違う」と言うことになる。
   */
  streamWidth: number | null
  streamHeight: number | null
  /**
   * 実際に記録した画素数（クロップ後）。**画質を語るときの母数**。
   *
   * プレーヤーの動画領域そのものなので、全画面かウィンドウか・モニタの DPI で大きく変わる。
   * 要求ビットレートはこれに連動していないため、同じ 12Mbps でも 1 画素あたりは何倍も違う。
   */
  cropWidth: number | null
  cropHeight: number | null
}

// 供給レートの計測（開発時のみ。supply-bench.ts 参照）。
// 「キャプチャ本体」「canvas への描画」「エンコード」のどれが上限を決めているかを
// 切り分けるため、段階を変えながら一定時間の供給枚数を数える。
type BenchStage = 'capture' | 'draw' | 'encode'
// ticker: 画面の隅を毎フレーム書き換えてキャプチャを誘発する。透明度だけを変えた3段階を
// 比べることで、「キャプチャが反応するのは目に見える変化なのか、ウィンドウ内容の書き換え
// そのものなのか」を切り分ける。invisible で効くなら、記録に一切写り込まずに供給を増やせる。
type TickerMode = 'visible' | 'faint' | 'invisible'
type BenchVariant = { name: string; stage: BenchStage; maxWidth?: number; maxFrameRate?: number; ticker?: TickerMode }
type BenchResult = {
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

// 画面キャプチャの立ち上げに要るぶんだけ（recorder:prepare）。
interface PrepareData {
  sourceId: string
  fps: number
  sessionId: number
}

// 記録を始めるときに決まっているもの（recorder:start）。**ビットレートの根拠は準備時点では
// 確定していない**ので、こちらで受ける。
interface StartData {
  supplyFps: number
  sourceFps: number | null
  maxSeconds: number
}

interface RecorderApi {
  onPrepare: (cb: (data: PrepareData) => void) => void
  onStart: (cb: (data: StartData) => void) => void
  reportReady: (sessionId: number) => void
  onStop: (cb: () => void) => void
  getCrop: (streamW: number, streamH: number) => Promise<CropRect | null>
  sendDone: (webm: ArrayBuffer, duration: number, sessionId: number, drawnAt: number[], diag: CaptureDiag) => void
  reportStopped: (sessionId: number) => void
  reportError: (msg: string, sessionId: number) => void
  onBench: (cb: (data: { variants: BenchVariant[]; seconds: number }) => void) => void
  sendBenchResult: (results: BenchResult[]) => void
}

declare global {
  interface Window {
    recorderApi: RecorderApi
  }
}

// requestVideoFrameCallback が渡すメタデータのうち、ここで使う可能性のあるもの。
// 標準では captureTime（そのフレームが取り込み元で撮られた時刻）が定義されているが、
// getDisplayMedia 経由の画面キャプチャで実際に載るかは実装依存なので optional で受ける。
type CaptureFrameMeta = {
  mediaTime: number
  captureTime?: number
  expectedDisplayTime?: number
  presentationTime?: number
  presentedFrames?: number
}

let recorder: MediaRecorder | null = null
let rVfcRunning = false
// 供給を引き上げるためのティッカー（下の startCaptureTicker 参照）。
let tickerRaf: number | null = null
let tickerEl: HTMLCanvasElement | null = null
// ティッカーが実際に画面を書き換えた回数。
//
// **供給が頭打ちになっている原因を切り分けるための実測。** 供給は「画面が変化した回数」で
// 決まるので、天井が（1）ティッカーの rAF が回っていないことなのか、（2）画面キャプチャ側の
// 上限なのかで対処が真逆になる。ここが 120 前後なのに供給が 51 なら（2）、ここも 51 前後なら（1）。
let tickerTicks = 0
let mediaStream: MediaStream | null = null
let canvasStream: MediaStream | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null
let frameTimer: ReturnType<typeof setInterval> | null = null
let recordingToken = 0
// main（recording.ts）が recorder:start ごとに発行する sessionId。renderer 内部の
// recordingToken とは別の値空間（main 側のセッション識別用）なので、reportError/sendDone に
// 載せて送り返す用に直近の値を保持しておく。
let currentSessionId = 0

// frameTimer/stopTimer/rVfcRunning はモジュール変数だが、常に「最新の recordingToken を
// 持つセッション」だけが所有する。呼び出し元セッションの token が現在の recordingToken と
// 一致しないとき（＝自分より新しいセッションが既に走り出しているとき）はこれらを
// 一切触らない。それをせずに一律クリアすると、旧セッションの中断処理が新セッションの
// 描画ループ・自動停止タイマーを巻き込んで止めてしまうレースになる。
// 画面キャプチャの供給を引き上げる。
//
// キャプチャの枚数は「画面が変化した回数」で決まる（supply-bench.ts で実測。パイプラインの
// 段階を外しても解像度を 1/3 にしても増えず、画面の変化が少ないほど減る）。素材 24fps に
// 必要なのは 2 倍の約 48枚/秒だが、プレーヤーUIを隠して録画している間は 26〜33枚/秒しか
// 出ず、5〜8% のコマが自分の絵を持てなかった。
//
// このウィンドウ（1x1 px・最前面）の中身を毎フレーム書き換えるだけで、ブラウザの描画回数と
// 無関係にキャプチャを走らせられる。実測 29.2 → 50.2枚/秒。
//
// **塗るのは完全に透明（alpha=0）にすること。** 反応しているのは合成後の見た目ではなく
// ウィンドウ内容の書き換えそのもので、不透明(50.8)・微か(50.6)・透明(50.2)で効果は変わらない。
// 不透明にすると全画面再生時の切り出し範囲に入り、記録の左上に点滅が残ってしまう。
function startCaptureTicker(): void {
  stopCaptureTicker()
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px'
  document.body.appendChild(canvas)
  tickerEl = canvas
  const ctx = canvas.getContext('2d')
  let on = false
  tickerTicks = 0
  const tick = (): void => {
    tickerTicks++
    on = !on
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = on ? 'rgba(255,255,255,0)' : 'rgba(0,0,0,0)'
      ctx.fillRect(0, 0, 1, 1)
    }
    tickerRaf = requestAnimationFrame(tick)
  }
  tickerRaf = requestAnimationFrame(tick)
}

function stopCaptureTicker(): void {
  if (tickerRaf !== null) cancelAnimationFrame(tickerRaf)
  tickerRaf = null
  tickerEl?.remove()
  tickerEl = null
}

// 停止を決めた瞬間に、コマの供給と記録を止める。
//
// **cleanup（onstop の中）まで待ってはいけない。** MediaRecorder は stop() を呼んでから
// 実際に閉じるまでに時間があり、その間も rVFC は回り続ける。そこで供給した 1〜2 枚は
// ファイルに入らないのに供給側の記録には残るので、毎回「末尾が足りない」になる
// （実測 2026-08-26・6 本すべてで発生。素材の最後の 1 コマが表から落ちていた）。
//
// ここで止めても録画そのものは影響を受けない —— ティッカーはキャプチャの枚数を稼ぐための
// もので、映像は画面キャプチャのストリームから直接エンコードされている。
function stopFrameSupply(token: number): void {
  if (token !== recordingToken) return
  rVfcRunning = false
  stopCaptureTicker()
}

function cleanup(stream: MediaStream | null, cs: MediaStream | null, token: number): void {
  if (token === recordingToken) {
    rVfcRunning = false
    stopCaptureTicker()
    if (frameTimer) {
      clearInterval(frameTimer)
      frameTimer = null
    }
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
  }
  cs?.getTracks().forEach((t) => t.stop())
  stream?.getTracks().forEach((t) => t.stop())
}

function resetState(): void {
  mediaStream = null
  canvasStream = null
  recorder = null
}

// 画面キャプチャの取得。撮る対象（main が選んだディスプレイ）はどの経路でも同じ。
//
// getDisplayMedia を先に試す。ソースは main の setDisplayMediaRequestHandler が固定して
// いるため、ここでは選択 UI は出ない。getDisplayMedia が拒否される環境（ユーザー操作を
// 伴わない呼び出しが弾かれる等）でも録画そのものは失わせたくないので、旧来の
// getUserMedia({ chromeMediaSource: 'desktop' }) を退避先として残す。
//
// カーソル除外はここでは達成できない。cursor:'never' は仕様上の制約だが Chromium が
// 未実装で、未知の制約は例外にならず黙って無視される（crbug 41456762）。つまりどの経路
// でもカーソルは合成される。実際の除外は拡張機能側（content.js の hideCursor）が
// ページに cursor:none を当てて OS カーソル自体を消すことで行っている。制約自体は仕様
// 準拠で無害なため、将来 Chromium が実装したときにそのまま効くよう残してある。
//
// fps: 取得フレームレートの上限。以前はどの経路にも制約が無く、実 fps は Chromium 任せ
// だった（main から渡る fps は rVFC 非対応時のフォールバック interval でしか使われて
// いなかった）。上限を明示しないと 24fps 素材でもコマの取りこぼしが起きうる。
//
// 下限（minFrameRate / frameRate.min）は敢えて指定しない。下限を付けると画面に変化が
// 無い間もキャプチャが同じ絵を複製して吐き続け、ファイルサイズだけが膨らむ。上限だけ
// 上げれば「変化したぶんは確実に拾い、変化しなければ吐かない」になる。
// 実際に要求する取得フレームレート。main（recording.ts）が録画対象ディスプレイの Hz から
// 決めて渡すが、renderer 側でも上限を持つ（main の MAX_CAPTURE_FPS と同じ値。壊れた値が
// 来ても録画を巻き込まないための多層防御）。
//
// **ここで 60 に潰していた頃は、高リフレッシュレート環境でもこの上限が天井になっていた。**
// 「上限を上げても供給は増えない」という実測記録があったが、その実測自体が 60 上限の下で
// 取られていた（供給間隔 p50 17.6ms ≒ 57Hz は、まさに 60 上限に張り付いた形）。
function captureFps(fps: number): number {
  return Math.min(120, Math.max(1, fps || 60))
}

// ビットレート算出に使う供給レートの上限。main から届く実測値が壊れていても、要求ビットレートが
// 青天井にならないようにするための多層防御（取得上限と同じ値でよい。それ以上供給されることは無い）。
const MAX_SUPPLY_FPS_FOR_BITRATE = 120

// 素材の fps に応じてビットレートを引き上げるときの基準（この fps を 1 倍とする）。
//
// **画質を決めるのは 1 秒あたりのビット数ではなく「素材のコマ 1 つに何ビット割けたか」**
// （SPEC 7章）。ところが上の supplyFps は内容によらず約 50枚/秒で一定なので、そこだけに
// 連動させると素材の fps が倍になった分だけ 1 コマが痩せる。実測（2026-08-13、いずれも
// 1920x1080）：目視合格した 24fps アニメ 391kbit/コマ・30fps アニメ 301kbit/コマ に対し、
// 粗が見えた 60fps は 150kbit/コマ。**解像度ではなく、素材の fps で半分になっていた。**
//
// 基準を 30 に置くのは、合格している 2 本のうち低い方に合わせるため。こうすると
// **24 / 30fps は 1 ビットも変わらない**（保証範囲で退行が起きない）。
const BITRATE_BASE_SOURCE_FPS = 30

// 引き上げの上限（60fps 相当）。**理由は物理**：画面キャプチャの供給は約 50枚/秒が天井で
// （SPEC 7章・PENDING 11）、素材が 60fps を超えても記録できる別の絵はもう増えない。増やしても
// ファイルが太るだけになる。24Mbps は過去に実測済みの 22.4Mbps の近傍でもあり、そこでは
// エンコードが破綻しないことが分かっている（未知の水準へ踏み込まない）。
const MAX_SOURCE_FPS_BITRATE_FACTOR = 2

async function acquireScreenStream(sourceId: string, fps: number): Promise<{ stream: MediaStream; audioFailed: boolean }> {
  const maxFrameRate = captureFps(fps)
  // ideal も併記しているが、実測では供給レートは変わらなかった（23.976fps の素材に対し
  // 33.6 → 33.7 枚/秒）。この環境の実力値は 33〜41枚/秒で、描画とエンコードを止めても
  // 41.5枚/秒までしか出ない＝詰まっているのはキャプチャ本体側。ハードウェア
  // アクセラレーション OFF が必須（SPEC）なことによるソフトウェア合成の負荷と見られる。
  //
  // 素材 24fps に対し供給が 34枚/秒では 2 倍に届かないため、素材 1 コマぶんの表示区間に
  // 1 枚も撮れない箇所が 5〜7% 生じる。避けられないので、フレーム表側で「未取得」として
  // 印を付けてユーザーへ見せる（frame-feed.ts の captured を参照）。
  const videoConstraints = { cursor: 'never', frameRate: { ideal: maxFrameRate, max: maxFrameRate } } as any
  const videoMandatory = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate } } as any

  // 音声処理は全て切る。既定（audio: true）だと音声通話向けの処理チェーン
  // （エコーキャンセル・ノイズ抑制・自動ゲイン）が有効になり、その過程でステレオが
  // モノラルに落とされ、BGM や環境音が「雑音」として削られて音質が明確に劣化する。
  // 作品の音をそのまま残したいので、加工のかからない生のループバックを要求する。
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  }

  try {
    return { stream: await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: audioConstraints }), audioFailed: false }
  } catch (err) {
    console.warn('[recorder] getDisplayMedia with audio failed', err)
  }
  // 音声制約が通らない環境向けに、加工なし指定を落として一度だけ再試行する
  // （モノラルでも音が残る方が、音が無いより実用に足りる）。
  try {
    return { stream: await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: true }), audioFailed: false }
  } catch (err) {
    console.warn('[recorder] getDisplayMedia with plain audio failed', err)
  }
  // V-5 と同じ理由: ループバック音声はオーディオデバイス構成次第で失敗し、
  // audio 同時要求だと映像まで巻き添えで録れなくなる。映像のみで一度リトライする。
  try {
    return { stream: await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints }), audioFailed: true }
  } catch (err) {
    console.warn('[recorder] getDisplayMedia video-only failed, falling back to desktop capture', err)
  }

  try {
    return {
      stream: await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } } as any,
        video: videoMandatory,
      }),
      audioFailed: false,
    }
  } catch (err) {
    console.warn('[recorder] audio+video getUserMedia failed, retrying video only', err)
  }
  return {
    stream: await navigator.mediaDevices.getUserMedia({ video: videoMandatory }),
    audioFailed: true,
  }
}

// コーデック選択。アニメの線画・ベタ塗りは輪郭にモスキートノイズが出やすく、同じ
// ビットレートなら VP9 の方が明確に有利なので VP9 を先に試す。VP9 が使えない環境
// （ソフトウェアエンコーダ無効等）では従来どおり VP8 に落ちる。
// キーフレームを入れる間隔（コマ数）。理由と実測は下の MediaRecorder 生成箇所を参照。
const KEYFRAME_INTERVAL_FRAMES = 10

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
]

function pickMimeType(): string {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
}

// main から開始の合図が届くまで待つ口。**準備（画面キャプチャの立ち上げ）と記録開始の間に
// 落ち着き待ちが入る**ため、1 本のハンドラを途中で止める形で受ける。
// 解決値が null なら「始めずに畳む」（停止を押された・main が見切った）。
let pendingStart: ((data: StartData | null) => void) | null = null

function waitForStart(): Promise<StartData | null> {
  return new Promise((resolve) => { pendingStart = resolve })
}

window.recorderApi.onStart((data) => {
  const resolve = pendingStart
  pendingStart = null
  // 準備を送っていないのに開始だけ届くことは無い（main は必ず prepare → start の順で送る）。
  // 届いたら状態が食い違っているので、始めずに捨てる。
  if (!resolve) {
    console.warn('[recorder] recorder:start arrived without a prepared session')
    return
  }
  resolve(data)
})

// 画面キャプチャを立ち上げ、切り抜きの下ごしらえまで済ませてから main へ「用意できた」と返す。
//
// **重いのはここで、記録開始ではない。** 立ち上げの瞬間、配信ページは素材のコマを描き落とす
// （実測: YouTube 1080p 23.976fps で開始から 1.2 秒に 30 コマ）。以前はこの立ち上げが
// 落ち着き待ちの**後ろ**にあり、待ちは負荷のかかっていないページを見ていた——つまり何も
// 見ていないのと同じで、荒れは録画の頭にそのまま入っていた。準備を先に済ませ、本番と同じ
// 負荷がかかった状態で待たせる。
window.recorderApi.onPrepare(async ({ sourceId, fps, sessionId }) => {
  if (recorder && recorder.state !== 'inactive') return
  const token = ++recordingToken
  currentSessionId = sessionId

  let stream: MediaStream
  let audioFailed = false
  try {
    const acquired = await acquireScreenStream(sourceId, fps)
    stream = acquired.stream
    audioFailed = acquired.audioFailed
  } catch (err) {
    console.error('[recorder] all screen capture paths failed', err)
    window.recorderApi.reportError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'getUserMedia_not_allowed'
        : 'getUserMedia_failed',
      sessionId
    )
    return
  }
  if (token !== recordingToken) {
    cleanup(stream, null, token)
    window.recorderApi.reportError('aborted', sessionId)
    return
  }
  if (audioFailed) window.recorderApi.reportError('audio_unavailable_fallback', sessionId)

  mediaStream = stream
  const track = stream.getVideoTracks()[0]
  const settings = track.getSettings()
  const streamW = settings.width ?? 1920
  const streamH = settings.height ?? 1080

  const crop = await window.recorderApi.getCrop(streamW, streamH)
  if (token !== recordingToken) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('aborted', sessionId)
    return
  }
  if (!crop) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('crop_unavailable', sessionId)
    return
  }

  const canvas = document.createElement('canvas')
  canvas.width = crop.w
  canvas.height = crop.h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('canvas_unavailable', sessionId)
    return
  }

  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  try {
    await video.play()
  } catch (err) {
    console.error('[recorder] video play failed', err)
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('video_play_failed', sessionId)
    return
  }
  if (token !== recordingToken) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('aborted', sessionId)
    return
  }

  // captureStream(0) disables automatic sampling. We request frames manually so
  // the cropped output follows the captured source frame timing.
  const cs = canvas.captureStream(0)
  canvasStream = cs
  const csTrack = cs.getVideoTracks()[0] as any

  rVfcRunning = true
  // 供給を引き上げるティッカーを回す。録画中だけで十分なのでここで開始し、cleanup で止める。
  startCaptureTicker()
  // 供給した各フレームが「いつ画面から取り込まれたか」（epoch ミリ秒）を数える口。
  //
  // 録画後に、配信ページ側が知っている素材のコマ時刻と突き合わせて「素材のコマ N は
  // このファイルの何枚目か」を決めるために使う。時刻の変換と、**記録が始まる前の 1 枚も
  // 数えない**という一点は frame-sink.ts が持つ（そこだけはテストから駆動できる）。
  const sink = createFrameSink()
  // **絵は準備中から作り続ける。** 記録に送るのと数えるのだけを開始まで止める——
  // 描画を止めると準備中の負荷が本番と変わってしまい、落ち着き待ちが見ている状態が
  // 記録中の状態とずれる（それでは待つ意味が無い）。
  const drawFrame = (captureTime?: number): void => {
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
    if (!sink.record(captureTime)) return
    csTrack.requestFrame()
  }
  // 直前に供給した動画フレームの mediaTime。同じ値なら供給しない。
  //
  // rVFC は「フレームが表示された」ごとに呼ばれるが、同じ動画フレームが複数回 present
  // されること（コンポジタの再合成、表示リフレッシュが素材の fps より速い場合など）が
  // ある。そのたびに requestFrame すると、録画ファイルに同じ絵が何枚も積まれ、コマ送りで
  // 数えたときに 2 コマ打ちが 3 コマ打ち・4 コマ打ちに化ける。
  //
  // 2 コマ打ちの「同じ絵が 2 枚」は素材上で別フレーム（mediaTime が異なる）なので、
  // この判定では落ちない。落ちるのは同一フレームの重複供給だけ。
  let lastDrawnMediaTime = -1
  // 供給の実測（診断専用。録画そのものには影響しない）。
  //
  // rVFC は「フレームが提示された」ごとに呼ばれる建前だが、提示が詰まるとコールバックは
  // 飛ばされ、presentedFrames だけが一気に進む。つまり「rVFC が呼ばれた回数」は
  // キャプチャが寄越した枚数とは限らない。飛んだぶんを数えておけば、撮り逃しの原因が
  // 供給不足なのか観測漏れなのかを録画1本で切り分けられる。
  let callbacks = 0
  let presentedFirst: number | null = null
  let presentedLast: number | null = null
  let skippedByCallback = 0
  let duplicateSuppressed = 0
  const scheduleFrame = (now?: number, meta?: CaptureFrameMeta): void => {
    if (!rVfcRunning) return
    callbacks++
    const presented = meta?.presentedFrames
    if (typeof presented === 'number') {
      if (presentedFirst === null) presentedFirst = presented
      else if (presentedLast !== null && presented > presentedLast + 1) skippedByCallback += presented - presentedLast - 1
      presentedLast = presented
    }
    const mediaTime = meta?.mediaTime
    if (mediaTime === undefined || mediaTime !== lastDrawnMediaTime) {
      if (mediaTime !== undefined) lastDrawnMediaTime = mediaTime
      drawFrame(meta?.captureTime)
    } else {
      duplicateSuppressed++
    }
    ;(video as any).requestVideoFrameCallback(scheduleFrame)
  }
  if ('requestVideoFrameCallback' in video) {
    ;(video as any).requestVideoFrameCallback(scheduleFrame)
  } else {
    const intervalMs = Math.max(16, Math.round(1000 / Math.min(60, Math.max(1, fps || 30))))
    drawFrame()
    frameTimer = setInterval(() => { if (rVfcRunning) drawFrame() }, intervalMs)
  }

  // ── ここまでが準備 ───────────────────────────────────────────────
  // 画面キャプチャは既に走っており、ページへの負荷は記録中と同じ。main はこの合図を
  // 受けてから落ち着くのを待つ（recording.ts）。**待っている間のフレームは 1 枚も
  // 数えない**——sink はまだ開いていない。
  window.recorderApi.reportReady(sessionId)
  const startData = await waitForStart()
  // 停止を押された／main が見切った。片付けと中断の通知は onStop 側が済ませている
  // （ここで二重に送ると、始まったばかりの次の録画を巻き込む）。
  if (!startData || token !== recordingToken) return
  const { supplyFps, sourceFps, maxSeconds } = startData

  const mimeType = pickMimeType()

  const audioTracks = stream.getAudioTracks()
  const recordStream = audioTracks.length > 0
    ? new MediaStream([...cs.getVideoTracks(), ...audioTracks])
    : cs

  // 要求した映像ビットレート。診断（CaptureDiag）に載せて main のログへ出すため、
  // MediaRecorder を作る try の外で受ける。**要求値と、ファイルから逆算した実効値の両方を
  // 見たい**——エンコーダは要求どおりに出すとは限らず、判断材料になるのは実際に出た方。
  let videoBitsPerSecond: number | null = null
  let rec: MediaRecorder
  try {
    // 映像のビットレートは供給レートに合わせて上げる。1 秒あたりのビット数は同じでも、
    // 枚数が増えれば 1 フレームあたりは痩せ、アニメの線画にモスキートノイズが出るため。
    // ただし枚数の比ほどは要らない——フレームレートが上がると隣接フレームが似て、
    // フレーム間予測が効くぶん安くなる。実測では供給 1.7 倍（29→50枚/秒）に対し
    // ビットレート 1.5 倍（8→12Mbps）で元の画質水準に戻った。その比（枚数比の約 0.9 乗）
    // をそのまま延長する。
    //
    // **基準にするのは実測の供給（supplyFps）で、取得上限（fps）ではない。** 上限を 120 に
    // 上げても供給は 50.8枚/秒のままだったため（2026-08-12 実測）、上限に連動させると
    // 枚数が増えていないのにビットレートだけ 1.9 倍要求することになる（実測でファイルが
    // 45→64MB に太り、画質は変わらなかった）。main 側の recording.ts に同じ注記あり。
    //
    // 音声ビットレートも明示する。未指定だと Chromium の控えめな既定値が使われ、
    // 映像に十数 Mbps 割いているのに音だけ痩せる。Opus 192kbps はステレオ音楽が
    // 十分に持つ水準で、映像側と比べれば誤差のサイズにしかならない。
    const bitrateFps = Math.min(MAX_SUPPLY_FPS_FOR_BITRATE, Math.max(1, supplyFps || 60))
    // 素材のコマが細かいほど 1 コマあたりが痩せる分を補う（BITRATE_BASE_SOURCE_FPS 参照）。
    // **測れていなければ 1 倍＝従来どおり。推定で埋めない。** また下げる方向には効かせない
    // ——24fps 未満で減らしてよいという根拠（目視）が無く、減らす側は黙って画質を損なう。
    const sourceFactor = sourceFps && sourceFps > 0
      ? Math.min(MAX_SOURCE_FPS_BITRATE_FACTOR, Math.max(1, sourceFps / BITRATE_BASE_SOURCE_FPS))
      : 1
    videoBitsPerSecond = Math.round(12_000_000 * Math.pow(Math.max(1, bitrateFps / 60), 0.9) * sourceFactor)
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
    rec = new MediaRecorder(recordStream, {
      mimeType, videoBitsPerSecond, audioBitsPerSecond: 192_000,
      videoKeyFrameIntervalCount: KEYFRAME_INTERVAL_FRAMES,
    })
  } catch (err) {
    console.error('[recorder] MediaRecorder create failed', err)
    cleanup(stream, cs, token)
    resetState()
    window.recorderApi.reportError('media_recorder_failed', sessionId)
    return
  }

  recorder = rec
  // このセッション専用のローカル資源。MediaRecorder のエラー後、onstop が発火する前に
  // 次の録画が滑り込むレースに備え、モジュール変数（次セッションの状態）を一切参照せず
  // クロージャで束縛したこのセッションの stream/cs/chunks/開始時刻だけを扱う。
  const localChunks: Blob[] = []
  const sessionStartedAt = Date.now()
  let recorderFailed = false

  rec.ondataavailable = (e) => {
    if (e.data.size > 0) localChunks.push(e.data)
  }

  rec.onerror = (event) => {
    recorderFailed = true
    console.error('[recorder] MediaRecorder error', event)
    window.recorderApi.reportError('media_recorder_error', sessionId)
    if (rec.state === 'recording') {
      stopFrameSupply(token)
      rec.stop()
    }
  }

  rec.onstop = async () => {
    const duration = (Date.now() - sessionStartedAt) / 1000
    cleanup(stream, cs, token)
    // resetState はモジュール変数（recorder/mediaStream/canvasStream）を消す。
    // 既に次のセッションが始まっていて recorder が入れ替わっていたら、
    // 新セッションの状態を消してしまわないよう何もしない。
    if (recorder === rec) resetState()

    // 画面キャプチャはこの時点で完全に終わっている（MediaRecorder は停止済み、
    // ストリームも cleanup で解放済み）。この下の尺補正・ArrayBuffer 化・IPC 転送は
    // 数十MB を相手にするため実測で数秒かかるので、**その前に**プレーヤー UI の復帰を
    // main へ知らせる。エラー系（この後 return する経路）でも復帰は要るので、
    // recorderFailed の判定より前に出す。
    window.recorderApi.reportStopped(sessionId)

    if (recorderFailed) return

    if (localChunks.length === 0) {
      window.recorderApi.reportError('no_data', sessionId)
      return
    }

    try {
      const rawBlob = new Blob(localChunks, { type: mimeType })

      // MediaRecorder WebM output may lack duration metadata, which breaks seeking.
      const blob = await fixWebmDuration(rawBlob, duration * 1000)

      // video 要素が「受け取った枚数」。rVFC 越しに観測した枚数と比べることで、
      // キャプチャ本体の供給量そのものが分かる（受け取り ≈ 供給 なら増やす余地は無い）。
      const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null
      const webmBuf = await blob.arrayBuffer()
      window.recorderApi.sendDone(webmBuf, duration, sessionId, sink.drawnAt, {
        callbacks,
        presented: presentedFirst !== null && presentedLast !== null ? presentedLast - presentedFirst + 1 : 0,
        skippedByCallback,
        duplicateSuppressed,
        captureTimeMissing: sink.captureTimeMissing,
        clockSkewMs: performance.timeOrigin + performance.now() - Date.now(),
        totalVideoFrames: quality?.totalVideoFrames ?? null,
        droppedVideoFrames: quality?.droppedVideoFrames ?? null,
        tickerTicks,
        videoBitsPerSecond,
        // 上のビットレートを決めた根拠。届かなかった録画をログから見分けるために持ち帰る。
        bitrateSourceFps: sourceFps ?? null,
        // 実フレームの画素数（getSettings の公称枠ではない。CaptureDiag の注記参照）。
        streamWidth: video.videoWidth || null,
        streamHeight: video.videoHeight || null,
        cropWidth: crop.w,
        cropHeight: crop.h
      })
    } catch (err) {
      console.error('[recorder] finalize failed', err)
      window.recorderApi.reportError('finalize_failed', sessionId)
    }
  }

  try {
    rec.start(100)
  } catch (err) {
    console.error('[recorder] start failed', err)
    cleanup(stream, cs, token)
    resetState()
    window.recorderApi.reportError('recorder_start_failed', sessionId)
    return
  }
  // **記録が動き出した後にだけ開く。** ここから rec.start() までの間に await を挟まないこと
  // ——挟んだぶんだけ「ファイルに入っていないフレームを数える」窓になり、表が丸ごとずれる
  // （frame-sink.ts）。開く前に供給したフレームは requestFrame もされていないので、
  // ファイルの 1 枚目は必ずこの直後に供給する 1 枚になる。
  sink.open()
  // 供給の実測は録画そのものについて出す。準備中のぶんを混ぜると、立ち上がりの荒れが
  // 録画の診断に化けて「供給が足りていない」と読めてしまう。
  callbacks = 0
  presentedFirst = null
  presentedLast = null
  skippedByCallback = 0
  duplicateSuppressed = 0
  tickerTicks = 0

  if (maxSeconds > 0) {
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (rec.state === 'recording') {
        stopFrameSupply(token)
        rec.stop()
      }
    }, maxSeconds * 1000)
  }
})

// ── 供給レートの計測 ────────────────────────────────────────────────
//
// 録画もファイル保存も伴わない。段階（capture / draw / encode）を変えながら一定時間
// 供給枚数を数え、上限を決めているのがどこかを切り分ける。
//
// 実測で分かっていること: rVFC の観測漏れは 0、video 要素が受け取った総数も
// コールバック回数とほぼ同数（capture-diag.ts）。つまり「読み出し方」ではないところまでは
// 絞れているが、キャプチャ本体・描画・エンコード・そもそも画面が変化していない、の
// どれなのかはまだ分かっていない。ここを埋めるための計測。
async function runBenchVariant(variant: BenchVariant, seconds: number): Promise<BenchResult> {
  const base: BenchResult = {
    name: variant.name, seconds, frames: 0, distinct: 0, totalVideoFrames: null, width: 0, height: 0
  }
  let stream: MediaStream | null = null
  let cs: MediaStream | null = null
  let rec: MediaRecorder | null = null
  // 録画本体のティッカー（モジュール変数）とは別物。計測はそれ自体が条件なので独立に持つ。
  let benchTickerRaf: number | null = null
  let benchTickerEl: HTMLCanvasElement | null = null
  const video = document.createElement('video')
  try {
    // 画面の隅（このレコーダーウィンドウは 1x1 px で画面左上に常駐している）を毎フレーム
    // 書き換える。キャプチャが画面の変化に駆動されているなら、ブラウザの描画回数とは無関係に
    // キャプチャを走らせられる——そのフレームには動画領域の最新状態も一緒に写る。
    //
    // 変えるのは不透明度だけにして、他の条件を揃える。alpha=0（完全に透明）でも供給が増えるなら、
    // 記録に一切写り込まずに済む。増えないなら、目に見える変化が必要だと分かる。
    if (variant.ticker) {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px'
      document.body.appendChild(canvas)
      benchTickerEl = canvas
      const tctx = canvas.getContext('2d')
      const alpha = variant.ticker === 'visible' ? 1 : variant.ticker === 'faint' ? 0.02 : 0
      let on = false
      const tick = (): void => {
        on = !on
        if (tctx) {
          tctx.clearRect(0, 0, 1, 1)
          tctx.fillStyle = on ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`
          tctx.fillRect(0, 0, 1, 1)
        }
        benchTickerRaf = requestAnimationFrame(tick)
      }
      benchTickerRaf = requestAnimationFrame(tick)
    }
    // 録画時と同じ経路（getDisplayMedia）。解像度・フレームレートだけ変えて比較する。
    // 音声は要求しない — 計測したいのは映像の供給枚数で、音声の有無で失敗要因を増やしたくない。
    const videoConstraints: any = { frameRate: { ideal: variant.maxFrameRate ?? 60, max: variant.maxFrameRate ?? 60 } }
    if (variant.maxWidth) videoConstraints.width = { max: variant.maxWidth }
    stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints })

    const track = stream.getVideoTracks()[0]
    const settings = track.getSettings()
    base.width = settings.width ?? 0
    base.height = settings.height ?? 0

    video.srcObject = stream
    video.muted = true
    await video.play()

    let ctx: CanvasRenderingContext2D | null = null
    let csTrack: any = null
    if (variant.stage !== 'capture') {
      const crop = await window.recorderApi.getCrop(base.width, base.height)
      const w = crop?.w ?? base.width
      const h = crop?.h ?? base.height
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      ctx = canvas.getContext('2d')
      cs = canvas.captureStream(0)
      csTrack = cs.getVideoTracks()[0]
      if (variant.stage === 'encode') {
        rec = new MediaRecorder(cs, { mimeType: pickMimeType(), videoBitsPerSecond: 8_000_000 })
        // 溜め込まないよう捨てる。計測したいのはエンコードの負荷であって出力ではない。
        rec.ondataavailable = () => {}
        rec.start(100)
      }
      // 描画は録画時と同じ「切り出して等倍で描く」形にする（拡大縮小のコストを混ぜない）。
      const sx = crop?.x ?? 0
      const sy = crop?.y ?? 0
      ;(video as any).__benchDraw = () => {
        ctx?.drawImage(video, sx, sy, w, h, 0, 0, w, h)
        csTrack?.requestFrame()
      }
    }

    await new Promise<void>((resolve) => {
      let lastMediaTime = -1
      let running = true
      const tick = (_now?: number, meta?: CaptureFrameMeta): void => {
        if (!running) return
        base.frames++
        if (meta?.mediaTime === undefined || meta.mediaTime !== lastMediaTime) {
          base.distinct++
          if (meta?.mediaTime !== undefined) lastMediaTime = meta.mediaTime
          ;(video as any).__benchDraw?.()
        }
        ;(video as any).requestVideoFrameCallback(tick)
      }
      if ('requestVideoFrameCallback' in video) {
        ;(video as any).requestVideoFrameCallback(tick)
      }
      setTimeout(() => { running = false; resolve() }, seconds * 1000)
    })

    base.totalVideoFrames = typeof video.getVideoPlaybackQuality === 'function'
      ? video.getVideoPlaybackQuality().totalVideoFrames
      : null
  } catch (err) {
    base.error = String(err instanceof Error ? err.message : err).slice(0, 120)
  } finally {
    if (benchTickerRaf !== null) cancelAnimationFrame(benchTickerRaf)
    benchTickerEl?.remove()
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch {}
    cs?.getTracks().forEach((t) => t.stop())
    stream?.getTracks().forEach((t) => t.stop())
    video.srcObject = null
  }
  return base
}

window.recorderApi.onBench(async ({ variants, seconds }) => {
  // 録画中は触らない（ストリームを二重に掴んで録画を壊さない）。
  if (recorder && recorder.state !== 'inactive') {
    window.recorderApi.sendBenchResult([])
    return
  }
  const results: BenchResult[] = []
  for (const variant of variants) {
    results.push(await runBenchVariant(variant, seconds))
  }
  window.recorderApi.sendBenchResult(results)
})

window.recorderApi.onStop(() => {
  recordingToken++
  // 開始待ちで止まっている準備があれば、まず起こす（起こさないと画面キャプチャを
  // 掴んだまま宙づりになる）。片付けと中断の通知はこの下でまとめて行う。
  const waiting = pendingStart
  pendingStart = null
  waiting?.(null)
  if (recorder?.state === 'recording') {
    stopFrameSupply(recordingToken)
    recorder.stop()
  } else {
    // V-1: 録画開始処理中（MediaRecorder.start() 到達前）に停止が来たケース。recorder が
    // まだ無いため onstop も発火せず、ここで main へ aborted を送らないと main 側の
    // isRecording が固着したままになる。この時点で自分がまさに最新セッションなので、
    // 直前でインクリメントした recordingToken を渡してタイマー類も確実にクリアする。
    cleanup(mediaStream, canvasStream, recordingToken)
    resetState()
    window.recorderApi.reportError('aborted', currentSessionId)
  }
})
