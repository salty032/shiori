// 動画クリップ録画のステートマシン。録画状態（isRecording / isRecordingStarting /
// recordingMeta）を保持し、開始・停止・状態リセット・ホットキー処理を提供する。
import { shell, desktopCapturer, screen as electronScreen } from 'electron'
import { broadcastMessage, onExtensionMessage, type ExtensionMessage } from '../browser/ws-server'
import { canCaptureVideo, getBrowserWindowRect, setBrowserWindowPos, setVideoRect } from '../capture/capture'
import { loadSettings } from '../system/settings'
import { captureRootReachable } from '../system/paths'
import { isMainWindowFocused } from '../system/windows'
import { getRecorderWindow, createRecorderWindow, setPendingDisplaySource } from './recorder-window'
import { startFrameFeed, stopFrameFeed, waitForSteadyFrames } from './frame-feed'
import { setTrayRecording } from '../system/tray'
import { getLastTimecode, getLastTimecodeAt, setLastTimecode } from '../browser/timecode'
import { sendBrowserNotice } from '../browser/browser-notice'
import { t } from '../system/i18n'

interface RecordingMeta {
  title: string | null
  currentTime: number | null
  url: string | null
}

let isRecording = false
let isRecordingStarting = false
let recordingMeta: RecordingMeta | null = null
// V-1: recorder:done/error のどちらも届かない場合（レコーダーのハング等）に備えた保険。
// finishRecordingState() のたびにインクリメントし、古いウォッチドッグを無効化する。
let recordingWatchdogToken = 0
// recorder:start のたびに発行し、recorder:done/error に載せて送り返させるセッションID。
// レコーダーウィンドウ側のレースで旧セッションの完了/エラー通知が遅延して届いても、
// 現在のセッションと一致しない限り recorder-ipc.ts 側で無視し、新しい録画状態を壊さない。
let currentRecordingSessionId = 0
// この録画で UI 復帰（post-capture）を既に送ったか。releaseCaptureUi() で先に送った場合、
// finishRecordingState() の二度目を撥ねるために持つ（content.js の post-capture 処理は
// scheduleRestorePlayerUI がタイマーを張り直すので、二度目を受けると復帰がその分だけ遅れる）。
let uiHoldReleased = false
// 記録を始める前の待ち（waitForSteadyFrames）に入っているか。**この間はレコーダーがまだ
// 録画を始めていないので、停止を送っても空振りする。** 押した人には「止めた」つもりなのに
// 待ちが明けてから録画が始まる、という形になるため、待ち中の停止は開始の取り消しにする。
let awaitingStart = false
let startCanceled = false

export function isCurrentlyRecording(): boolean {
  return isRecording
}

export function isCurrentRecordingSession(sessionId: number): boolean {
  return sessionId === currentRecordingSessionId
}

export function getRecordingMeta(): RecordingMeta | null {
  return recordingMeta
}

type TimecodeMsg = Extract<ExtensionMessage, { type: 'timecode' }>

async function requestRecordingTarget(): Promise<TimecodeMsg | null> {
  const requestId = `${Date.now()}-${Math.random()}`
  return new Promise((resolve) => {
    let done = false
    const finish = (value: TimecodeMsg | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const off = onExtensionMessage((msg) => {
      if (msg.type === 'timecode' && msg.requestId === requestId) {
        finish(msg)
      }
    })
    broadcastMessage({ type: 'request-timecode', requestId, immediate: true })
    // 録画は immediate=true で UI 非表示の描画待ちが不要なため即応答が返る。
    // 取りこぼし保険として短め(700ms)で打ち切る。スクショ側(900ms)より短いのはこの差による。
    const timer = setTimeout(() => { console.warn('[clip] request-timecode timeout'); finish(null) }, 700)
  })
}

// 録画開始時のデスクトップソース解決。capture.ts が保持するブラウザウィンドウ位置
// （コア state）を読み取り専用アクセサ経由で参照する。
// 直近の録画対象ディスプレイのリフレッシュレート（Hz）。取得フレームレートの上限に使う。
// getDesktopSourceId が解決したディスプレイをそのまま覚える（録画対象と別の画面の Hz で
// 上限を決めても意味が無いため）。
let lastDisplayHz: number | null = null
// 同じディスプレイの物理画素数（DIP × scaleFactor）。
//
// **キャプチャストリームが画面をそのまま返しているかを確かめるためだけの値**。
// getDisplayMedia には解像度の制約を付けていないので、Chromium がこれより小さい
// ストリームを返しても、クロップ計算は `screenshotDpr = frameW / bounds.width` で
// 吸収してしまい黙って低解像度で録れる。`[clip-bitrate]` に並べて出す（logBitrateDiag）。
let lastDisplayPixels: { width: number; height: number } | null = null

export function getRecordingDisplayPixels(): { width: number; height: number } | null {
  return lastDisplayPixels
}

// 直近の解決で「どの画面を録るか確定できなかった」か。getDesktopSourceId が立て、
// 録画開始時に警告として画面へ出す（診断ログではなくその場で読めること）。
let lastDisplayAmbiguous = false

export function wasRecordingDisplayAmbiguous(): boolean {
  return lastDisplayAmbiguous
}

async function getDesktopSourceId(): Promise<string | null> {
  const rect = getBrowserWindowRect()
  if (!rect) return null
  const { left: wl, top: wt, width: ww, height: wh } = rect
  const edisp = electronScreen.getDisplayNearestPoint({ x: Math.round(wl + ww / 2), y: Math.round(wt + wh / 2) })
  lastDisplayHz = Number.isFinite(edisp.displayFrequency) && edisp.displayFrequency > 0
    ? edisp.displayFrequency
    : null
  lastDisplayPixels = edisp.size && edisp.size.width > 0 && edisp.size.height > 0
    ? {
        width: Math.round(edisp.size.width * (edisp.scaleFactor || 1)),
        height: Math.round(edisp.size.height * (edisp.scaleFactor || 1))
      }
    : null
  // thumbnailSize を明示しないと Electron は既定で全スクリーンの 150x150 サムネイルを
  // 実際に撮ってから返す。ここで欲しいのは source.id だけで画像は捨てるため、その撮影は
  // 丸ごと無駄な待ち時間になる（ホットキーを押してから録画が始まるまでの遅延に直結する）。
  // 0x0 を指定してサムネイル生成を省く。
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const matched = sources.find(s => s.display_id === String(edisp.id))
  // display_id は環境によって空で返ることがあり、そのとき照合は必ず外れる。
  // 画面が 1 つなら sources[0] はその画面に決まっているので黙って使ってよい。
  // 危ないのは「画面が複数あるのに一致しない」場合だけで、ここで sources[0] を
  // 使うと別のモニターを録った動画が、他と見分けの付かない形でライブラリに並ぶ。
  // 録画自体は続ける（当たっている可能性もあり、止めると確実に撮り逃す）が、
  // 保証できないことは画面に出す。
  lastDisplayAmbiguous = !matched && sources.length > 1
  const source = matched ?? sources[0]
  return source?.id ?? null
}

// 取得フレームレートの上限の上限（枚/秒）。素材のコマ 1 つに撮影 1 枚以上を確保するには
// 素材の 2 倍が要るので、対応上限の 60fps 素材に対して 120。これ以上はコマ精度に効かず、
// ソフトウェアエンコード（ハードウェアアクセラレーション OFF が必須）の負荷と
// ファイルサイズだけが増える。recorder-ipc.ts の MAX_FRAME_RATE_FOR_VALIDATION より小さいこと。
export const MAX_CAPTURE_FPS = 120

// 直近の録画で実際に届いた供給レート（枚/秒）。ビットレートの根拠に使う（recorder:start の
// supplyFps）。既定の 60 は 12Mbps を較正したときの水準で、**上限の見込み値を使わない**ため
// のもの。プロセス内に持つだけで永続化しない——供給は環境で決まり毎回ほぼ同じ値に落ち着くので、
// 起動直後の 1 本が既定値でも実害が無く、DB に測定値のキャッシュを増やす方が割に合わない。
let lastSupplyFps: number | null = null

export function recordMeasuredSupply(drawnPerSec: number): void {
  if (Number.isFinite(drawnPerSec) && drawnPerSec > 0) lastSupplyFps = drawnPerSec
}

const RECORDER_LOAD_TIMEOUT_MS = 4000

// プレーヤー UI を隠したままにする時間に、録画の長さへ上乗せするマージン（秒）。
// 自動停止から post-capture が届くまでの停止処理ぶん。正常に届けばその時点で復元されるので、
// この値が実際に効くのは post-capture を取りこぼした異常時だけ。
const UI_HOLD_MARGIN_SEC = 10

// 記録を始める前に、コマ通知が落ち着くのを待つ上限。**待ち切れなくても必ず始める**
// （待たされ続けるより、保証できないと出して撮れる方がよい）。
// 実測（76 本・SETTLE_WINDOW のコメント参照）で最も遅い 24fps YouTube が 1.04 秒。
// 見切りは 2.0 秒（1.5 秒から引き上げ・2026-08-26）。これを超えるのは荒れが収まって
// いない録画で、そのときは画面に出す。
const CLIP_SETTLE_TIMEOUT_MS = 2000
// 「準備中」の表示が消えるのを待つ時間。ローカルの WS 往復は数 ms だが、消える前に
// 撮り始めると表示が録画に写る。**録画そのものを汚すので、ここは余裕を取る。**
const ARMED_CLEAR_MS = 120

// レコーダーウィンドウを生成し、ロード完了まで待つ。
// 既存ウィンドウ（起動時生成）がまだロード中でも待つことで、起動直後の初回録画で
// recorder:start が未ロードのページに送られて取りこぼされるのを防ぐ。
// ロード失敗・ハング時に isRecordingStarting が固着しないよう必ずタイムアウトで抜ける。
async function ensureRecorderReady(timeoutMs: number): Promise<boolean> {
  let win = getRecorderWindow()
  if (!win || win.isDestroyed()) {
    createRecorderWindow(finishRecordingState)
    win = getRecorderWindow()
  }
  if (!win || win.isDestroyed()) return false

  const wc = win.webContents
  if (!wc.isLoading()) return true // 既にロード完了済み

  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.off('did-finish-load', onLoad)
      resolve(ok)
    }
    const onLoad = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    wc.once('did-finish-load', onLoad)
  })
}

// レコーダーが画面キャプチャを立ち上げ終えるのを待つ上限。**待ち切れなければ録画しない**
// ——ここで見切って始めても、立ち上がっていないキャプチャからは何も撮れない
// （落ち着き待ちの見切りとは意味が違う。あちらは撮れるが保証できない、こちらは撮れない）。
const RECORDER_PREPARE_TIMEOUT_MS = 4000

type PrepareOutcome = 'ready' | 'aborted' | 'timeout'
let prepareResolver: ((outcome: PrepareOutcome) => void) | null = null

function waitForRecorderPrepared(timeoutMs: number): Promise<PrepareOutcome> {
  return new Promise((resolve) => {
    const settle = (outcome: PrepareOutcome): void => {
      if (prepareResolver === null) return
      prepareResolver = null
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => settle('timeout'), timeoutMs)
    prepareResolver = settle
  })
}

// レコーダーから「用意できた」が届いた（recorder-ipc.ts）。
export function notifyRecorderPrepared(sessionId: number): void {
  if (!isCurrentRecordingSession(sessionId)) return
  prepareResolver?.('ready')
}

// 記録を始める前に停止された時の畳み方。**待ちが 3 か所あるので 1 つにまとめる**
// （どれか 1 つを直し忘れて、プレーヤー UI を隠したまま・キャプチャを掴んだまま残す、
// が起きやすい）。
//
// **recorder:stop を送るのを省かないこと。** この時点でレコーダーは既に画面キャプチャを
// 掴んでいる（準備が先に済んでいる）ので、送らないと録画しないまま掴みっぱなしになる。
// レコーダー側は「まだ録画していない」経路で解放し、中断を返す（recorder.ts の onStop）。
function cancelBeforeStart(): void {
  getRecorderWindow()?.webContents.send('recorder:stop')
  broadcastMessage({ type: 'post-capture', immediate: true })
  finishRecordingState()
}

export async function startRecording(): Promise<void> {
  if (isRecording || isRecordingStarting) return
  isRecordingStarting = true

  try {
    const target = await requestRecordingTarget()
    if (target?.videoRect) {
      setLastTimecode({ title: target.title, currentTime: target.currentTime, url: target.url ?? null })
      setBrowserWindowPos(target.windowLeft, target.windowTop, target.windowWidth, target.windowHeight, target.innerWidth, target.innerHeight)
      setVideoRect(target.videoRect)
    }

    // V-4: target がタイムアウト（拡張無応答）で null のとき、以前の browserWindow/videoRect
    // が残っていると canCaptureVideo() を通過してしまい、古い矩形で誤った領域を録画し、
    // メタデータも getLastTimecode() の古い値のまま付いてしまう。スクショ側の鮮度チェック
    // （bootstrap.ts の CAPTURE_FALLBACK_TIMECODE_MAX_AGE_MS）と同じしきい値で中止する。
    const CLIP_TIMECODE_MAX_AGE_MS = 1500
    if (!target && Date.now() - getLastTimecodeAt() > CLIP_TIMECODE_MAX_AGE_MS) {
      console.warn('[clip] stale timecode after target timeout, aborting recording')
      sendBrowserNotice('warning', t('notice.videoNotDetected'))
      return
    }

    if (!canCaptureVideo()) {
      console.warn('[clip] canCaptureVideo false', { hasTarget: !!target, videoRect: target?.videoRect ?? null })
      sendBrowserNotice('warning', t('notice.videoNotDetected'))
      return
    }
    // **録画を始める前に保存先へ届くか見る。** 録画はファイルを書くのが最後なので、
    // ここで見ないと 30 秒撮り終えてから保存に失敗することになる。
    if (!(await captureRootReachable())) {
      sendBrowserNotice('error', t('error.captureRootUnavailable'))
      return
    }
    if (!(await ensureRecorderReady(RECORDER_LOAD_TIMEOUT_MS))) {
      sendBrowserNotice('error', t('notice.recorderPrepareFailed'))
      return
    }

    const sourceId = await getDesktopSourceId()
    if (!sourceId) {
      sendBrowserNotice('error', t('notice.recordingSourceNotFound'))
      return
    }
    if (lastDisplayAmbiguous) {
      console.warn('[clip] recording display could not be identified among multiple screens')
      sendBrowserNotice('warning', t('notice.recordingDisplayUncertain'))
    }

    const settings = loadSettings()
    const maxSeconds = settings.clipMaxSeconds ?? 30

    isRecording = true
    uiHoldReleased = false
    // pre-capture より先に始める。content.js は pre-capture を受けた時点でコマ通知を
    // 出し始めるため、こちらの受け口が後だと最初の数コマを取りこぼす。
    startFrameFeed()
    // 録画中はプレーヤー UI を隠したままにする。content.js は「post-capture が届かないまま
    // UI が固着する」のを防ぐ強制復元タイマーを持っており、その既定値（8秒）はスクショ
    // 前提の長さなので、録画では途中で UI が戻ってしまう。録画の長さ＋停止処理のぶんを
    // 明示して渡し、正常に撮り切るまで隠したままにする。
    broadcastMessage({ type: 'pre-capture', holdMs: (maxSeconds + UI_HOLD_MARGIN_SEC) * 1000, video: true })
    shell.beep()

    // **キャプチャの立ち上がりでページがコマを描き落とすので、落ち着くまで記録を始めない**
    // （frame-feed.ts の waitForSteadyFrames にコメント）。待っている間だけ映像の上に
    // 「準備中」を出す —— まだ記録していないので写り込まないし、全画面でも見える。
    // 消えた瞬間が記録開始の合図になる。
    broadcastMessage({ type: 'clip-arming', label: t('video.clipArming') })
    awaitingStart = true
    startCanceled = false

    const sessionId = ++currentRecordingSessionId
    // **画面キャプチャを先に立ち上げてから待つ。**
    //
    // 以前はこの順が逆で、落ち着き待ちが済んでから recorder:start を送り、レコーダーが
    // そこで getDisplayMedia を叩いていた。つまり**待ちは負荷のかかっていないページを
    // 見ていた**——見た目は「落ち着くのを待ってから撮る」だが、実際には荒れる前に見て
    // 「落ち着いている」と答えていただけで、立ち上がりの荒れはそのまま録画の頭に入って
    // いた（実測: YouTube 1080p 23.976fps で開始から 1.2 秒に 30 コマが描かれず）。
    //
    // 準備を先に済ませると、待っている間のページは記録中と同じ負荷を受けている。
    // 代償は「準備中」の表示が数百 ms 長くなること。**それと引き換えに、待ちが初めて
    // 実際の状態を見るようになる**（落ち着かないまま見切る録画は増えうるが、それは
    // 悪化ではなく、今まで見えていなかったものが見えるということ）。
    setPendingDisplaySource(sourceId)
    getRecorderWindow()!.webContents.send('recorder:prepare', {
      sourceId,
      // 取得フレームレートの上限（recorder.ts の acquireScreenStream に渡す）。
      //
      // **録画対象ディスプレイのリフレッシュレートに合わせる。** 長らく 60 固定で、
      // 「上限を上げても供給は 33〜41枚/秒で頭打ち」と実測付きで書いていたが、
      // **その実測は全部 60 上限の下で取ったもの**で、上限そのものを動かした実験は無かった。
      // 実際、供給間隔の実測 p50 17.6ms（≒57Hz）は 60 上限に張り付いた形そのもの。
      // 高リフレッシュレートの環境ではここが天井になっていた。
      //
      // 上限の上限は MAX_CAPTURE_FPS。素材のコマ 1 つにつき撮影 1 枚以上を確保するのに
      // 要るのは素材の 2 倍なので、対応上限の 60fps 素材に対して 120 あれば足りる。
      // それ以上はエンコード負荷とファイルサイズが増えるだけで精度には効かない。
      fps: Math.min(MAX_CAPTURE_FPS, Math.max(1, Math.round(lastDisplayHz ?? 60))),
      sessionId
    })
    const prepared = await waitForRecorderPrepared(RECORDER_PREPARE_TIMEOUT_MS)
    if (startCanceled) {
      console.log('[clip] canceled while the capture was starting up')
      cancelBeforeStart()
      return
    }
    if (prepared === 'aborted') {
      // レコーダー側が失敗を報告済み（recorder:error → finishRecordingState）。
      // 通知はそちらが出しているので、ここでは何も足さない。
      console.warn('[clip] recorder aborted while preparing the capture')
      return
    }
    if (prepared === 'timeout') {
      console.error('[clip] recorder did not report ready in time')
      cancelBeforeStart()
      sendBrowserNotice('error', t('notice.recorderPrepareFailed'))
      return
    }

    const settle = await waitForSteadyFrames(CLIP_SETTLE_TIMEOUT_MS)
    broadcastMessage({ type: 'clip-armed' })
    // 待っている間に停止を押されていたら、ここで畳む（記録は始めず、キャプチャは解放する）。
    if (startCanceled) {
      console.log(`[clip] canceled during settle (${settle.waitedMs}ms)`)
      cancelBeforeStart()
      return
    }
    console.log(`[clip] settle ${settle.settled ? 'ok' : 'gave up'} after ${settle.waitedMs}ms (${settle.reports} reports)`)
    // 表示が実際に消えてから撮り始める。往復はローカルの WS で数 ms だが、消える前に
    // 記録を始めると「準備中」が数コマ写る——**録画そのものを汚す**ので余裕を持たせる。
    await new Promise((resolve) => setTimeout(resolve, ARMED_CLEAR_MS))
    // **この待ちも「まだ始めていない」区間。** 以前は落ち着き待ちが明けた時点で
    // awaitingStart を下ろしており、ここで停止を押すと recorder:stop だけが先に飛んだ。
    // レコーダーには止めるものがまだ無いので空振りし、直後に recorder:start が送られて
    // 録画が始まる——押した人からは「止めたのに撮り続けている」に見えた。
    // 印を下ろすのは実際に開始を送る直前（下）まで遅らせ、ここでもう一度見る。
    if (startCanceled) {
      console.log('[clip] canceled while the arming overlay was clearing')
      cancelBeforeStart()
      return
    }
    // 落ち着きを確認できないまま始めたことは、ログではなくその場の画面に出す。
    // 黙って始めると「待ったから大丈夫」と読めてしまう（60fps 素材・高負荷時はこちらに来る）。
    if (!settle.settled) sendBrowserNotice('warning', t('notice.recordingNotSettled'))
    const tc = getLastTimecode()
    recordingMeta = {
      title: tc?.title ?? null,
      currentTime: tc?.currentTime ?? null,
      url: tc?.url ?? null
    }

    // ここから先は recorder:stop が効く（レコーダーが開始の合図を受け取る）。**印を下ろすのは
    // 送信の直前**——間に非同期の待ちを挟まないこと。挟んだぶんがそのまま「停止が空振りする
    // 窓」になる。
    awaitingStart = false
    getRecorderWindow()!.webContents.send('recorder:start', {
      // ビットレートを決めるための「実際に届く枚数」。**上限の見込みとは別物**。
      //
      // 上限を 120 にしても供給は 50.8枚/秒のままだった（2026-08-12 実測）。上限に連動させて
      // いた頃は 22.4Mbps を要求していたが、枚数は 12Mbps を決めたときと同じ約 50枚/秒なので、
      // 増やした分は何も買っていない（実効 17.1Mbps・ファイルが 45→64MB に太っただけ）。
      // ビットレートを上げる根拠は「枚数が増えると 1 枚が痩せる」ことなので、**根拠にすべきは
      // 実測の枚数**。供給が本当に上がればそのまま追従する。
      supplyFps: Math.round(lastSupplyFps ?? 60),
      // 素材の fps。ビットレートを「素材のコマ 1 つに何ビット割けたか」で決めるために渡す
      // （計算は recorder.ts 側）。**前回の録画の値ではなく、これから撮る素材の実測値**——
      // 上の supplyFps と違い、素材は録画ごとに変わりうるので持ち越してはいけない。
      //
      // 出どころは録画開始の直前に拡張から受け取ったタイムコード（requestRecordingTarget）で、
      // ページ側が再生中ずっと rVFC で測っている値。測れていなければ null にして、従来どおりの
      // 固定ビットレートで録る。**推定で埋めない**（images.fps を供給レートで埋めないのと同じ）。
      sourceFps: target?.frameDurMs ? 1000 / target.frameDurMs : null,
      maxSeconds
      // sessionId は載せない。**セッションは準備の時点で決まっている**ので、レコーダーは
      // recorder:prepare で受け取った値を使う。ここでも渡すと 2 つの出どころができる。
    })
    setTrayRecording(true)

    // V-1: レコーダーがクラッシュ以外の形でハングし、recorder:done/error のどちらも
    // 届かないケース（render-process-gone では拾えない）に備えた保険。maxSeconds 経過後の
    // 自動停止（recorder.ts の stopTimer）よりさらに 30 秒待っても復帰しなければ強制リセットする。
    const watchdogToken = ++recordingWatchdogToken
    setTimeout(() => {
      if (watchdogToken !== recordingWatchdogToken) return
      if (!isRecording) return
      console.error('[clip] watchdog: recorder did not report done/error in time, forcing reset')
      finishRecordingState()
      sendBrowserNotice('error', t('notice.recordingTimeout'))
    }, (maxSeconds + 30) * 1000)
  } catch (err) {
    console.error('[clip] startRecording failed', err)
    finishRecordingState()
  } finally {
    isRecordingStarting = false
  }
}

function stopRecording(): void {
  if (!isRecording) return
  // まだ記録を始めていない（落ち着くのを待っている）段階。ここで recorder:stop を送っても
  // レコーダーには止めるものが無く、待ちが明けてから録画が始まってしまう。
  if (awaitingStart) {
    startCanceled = true
    // 画面キャプチャの立ち上げを待っている最中なら、その待ちも今すぐ起こす。
    // **起こさないと、押してから見切りの 4 秒が過ぎるまで畳まれない**——プレーヤーの UI は
    // 隠れたまま、トレイも録画中のままで、押した人には固まったようにしか見えない。
    // 起こした後は startCanceled の側で拾われる（startRecording は待ちの結果より先に
    // 押されたかどうかを見る）。
    prepareResolver?.('aborted')
    return
  }
  getRecorderWindow()?.webContents.send('recorder:stop')
}

// プレーヤー UI の復帰だけを先に流す（録画状態そのものは触らない）。
//
// 録画の停止から finishRecordingState() までの間には、レンダラー側の webm 尺補正・
// 数十MB の arrayBuffer 変換・main への IPC 転送が挟まり、実測で数秒かかる。**画面
// キャプチャ自体は MediaRecorder が止まった時点で終わっている**ので、この待ちは UI を
// 隠しておく理由にならない。動画は意図して撮るぶん撮った直後に確認したくなるため、
// そこでシークバーも再生ボタンも出ないのは操作の妨げになる。
//
// 呼び元はレコーダーウィンドウの rec.onstop（recorder:stopped）。onstop は録画が実際に
// 止まった後にしか発火しないので、復帰が早すぎて最後の数フレームに UI が写り込むことはない。
export function releaseCaptureUi(): void {
  if (!isRecording || uiHoldReleased) return
  uiHoldReleased = true
  broadcastMessage({ type: 'post-capture', immediate: true })
}

export function finishRecordingState(): void {
  // ウォッチドッグを無効化する（正常終了・エラー・クラッシュ検知のどの経路でも、
  // 状態が確定した以上ウォッチドッグの出番はない）。
  recordingWatchdogToken++
  // 準備の返事を待っている最中に終わったなら（レコーダーが立ち上げに失敗した等）、
  // 待ちを起こす。起こさないと上限まで待たされ、既に出ている通知の後からもう一度
  // 「準備に失敗」を出すことになる。
  prepareResolver?.('aborted')
  // 録画中（= recording.ts が pre-capture で UI を隠している）だったときだけ復元を送る。
  // done / error / render-process-gone 監視が重複発火しても、2 回目以降は no-op になり
  // post-capture を空打ちしない（スクショ側の preCaptureSent と同じ対称化）。
  const wasRecording = isRecording
  isRecording = false
  recordingMeta = null
  // 待ち中に異常終了した場合に取り残さない（次の録画が「取り消し済み」で始まらないよう）。
  awaitingStart = false
  startCanceled = false
  if (wasRecording) stopFrameFeed()
  // 預けた画面ソースを解放する。残しておくと、次の録画が何らかの理由で
  // setPendingDisplaySource を通らずに始まったとき、前回の（別ディスプレイかもしれない）
  // 画面をそのまま撮ってしまう。
  setPendingDisplaySource(null)
  // releaseCaptureUi() で先に送っていれば、ここでは送らない。異常系（recorder:stopped が
  // 届かない・レコーダーのクラッシュ・ウォッチドッグ）では未送のままここへ来るので、
  // 保険としての post-capture はこの経路に残っている。
  // immediate: true — 拡張側のホスト別復帰待ち（スクショ用の 1.6〜3.2 秒）を踏ませない。
  // 録画は既に止まっているので、待っても UI が写り込む余地は無い（content.js の restoreDelayFor）。
  if (wasRecording && !uiHoldReleased) broadcastMessage({ type: 'post-capture', immediate: true })
  uiHoldReleased = false
  setTrayRecording(false)
}

export function handleClipHotkey(): void {
  if (isMainWindowFocused()) return
  if (isRecording) stopRecording(); else startRecording()
}
