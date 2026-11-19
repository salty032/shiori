// アプリとの接続（再生位置の送信・アプリからのメッセージの受け口）と、読み込んだ瞬間に動き出す部分。
// ほかの役目は content-*.js に分けてある（manifest.json の content_scripts の順に読み込まれ、関数と変数を共有する）。
// **読み込み時に実行される行はこのファイルの末尾に置く**——先に読み込まれるファイルの関数を呼ぶため。

let settingsFps = 24
let settingsFpsAuto = true
// ホットキーのメインキー（例 "Alt+S" なら "S"）。Prime Video 等でのキー抑止（suppressCaptureKey）を
// 実際のキャプチャホットキーに追随させるため、main から settings メッセージで受け取る。
let settingsCaptureKey = 'S'

// shared/hotkey.ts の NAMED_KEYS と対になる、名前付きメインキーの KeyboardEvent.code。
const NAMED_CAPTURE_KEY_CODES = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Return: 'Enter', Escape: 'Escape',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight'
}
// event.key の綴りが正規化済みキー名と一致しないケースのみ個別マップする
// （それ以外の名前付きキーは event.key の綴りがそのまま一致する）。
const NAMED_CAPTURE_KEY_VALUES = { Space: ' ', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }
function isValidCaptureKey(k) {
  return /^[A-Za-z0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || Object.prototype.hasOwnProperty.call(NAMED_CAPTURE_KEY_CODES, k)
}

let port = null
let timecodeInterval = null
let ytNavPoll = null
let reconnectScheduled = false
let hiddenEls = []
let passiveHiddenEls = []
let restorePlayerUITimer = null
let passiveRestoreTimer = null
let hiddenWatchdogTimer = null
let suppressKeyTimer = null
const MAX_HIDDEN_ELEMENTS = 300
const DEFAULT_POST_CAPTURE_RESTORE_DELAY_MS = 2400
// post-capture が WS 切断・SW 再起動・main クラッシュ等で届かないと、隠したプレーヤー UI が
// 復元されずページリロードまで固着する。最後の砦として一定時間後に必ず強制復元する。正規フロー
// （pre→post→ホスト別遅延 最大3200ms＋キャプチャ往復）の最悪値より十分長く取り、誤発火を防ぐ。
//
// これはスクリーンショット前提の長さ。クリップ録画は最長 30 秒 UI を隠し続けるため、
// この既定のままだと撮影中に UI が戻ってしまう。録画側は pre-capture の holdMs で
// 必要な長さを明示してくる（app/src/main/video/recording.ts）。
const HIDDEN_UI_WATCHDOG_MS = 8000
// ==== ここから自動生成: limits ====
// 以下は app/src/shared/wire-limits.ts が原本。**手で書き換えない**（verify が落とす）。
// 直すときは wire-limits.ts を変えてから app/ で `npm run ext:limits` を実行する。
// pre-capture で受け取る holdMs の上限（ms）。
const MAX_UI_HOLD_MS = 120000
const MAX_TITLE_LENGTH = 500
const MAX_URL_LENGTH = 2048
const MAX_REQUEST_ID_LENGTH = 80
const MAX_NOTICE_MESSAGE_LENGTH = 240
// アプリから配られるコマ送りの文言の上限（ja.ts が原本）。
const MAX_STEP_LABEL_LENGTH = 120
// タイムコードの定期送信の間隔（ms）。
const TIMECODE_POLL_MS = 5000
// コマ通知に添えるコマの絵の一辺。
const THUMB_SIZE = 32
// ==== ここまで自動生成: limits ====
// app から届く表示文言を丸める。**拡張は文言を1つも持たない**ので、落とすと画面から
// 文字が消える（機能は動いたまま）。長さだけ切って、型が違えば空にする。
function stepLabel(v) {
  return typeof v === 'string' ? v.slice(0, MAX_STEP_LABEL_LENGTH) : ''
}

const MIN_FORCED_SEND_INTERVAL_MS = 250
let lastPayloadKey = ''
let lastSentAt = 0
let observedVideo = null

function clampNumber(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function getVideo() {
  const all = Array.from(document.querySelectorAll('video'))
  const vis = all.filter(v => {
    const r = v.getBoundingClientRect()
    return r.width > 50 && r.height > 50
      && r.bottom > 0 && r.right > 0
      && r.top < window.innerHeight && r.left < window.innerWidth
  })
  return (vis.length > 0 ? vis : all)
    .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0] ?? null
}

function buildPayload() {
  const target = detectVideoCaptureTarget()
  observeVideo(target.video)
  return {
    type: 'timecode',
    // アプリ側でバンドル済み拡張のバージョンと比較し、再読み込み待ちを検出する（UX-9）。
    version: chrome.runtime.getManifest().version,
    currentTime: target.currentTime,
    title: getPageTitleCached().slice(0, MAX_TITLE_LENGTH),
    url: window.location.href.slice(0, MAX_URL_LENGTH),
    focused: document.hasFocus(),
    windowLeft: window.screenLeft,
    windowTop: window.screenTop,
    windowWidth: window.outerWidth,
    windowHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    videoRect: target.videoRect,
    videoSize: target.videoSize,
    fullscreen: !!document.fullscreenElement,
    // 素材のコマ間隔（ミリ秒）。**録画開始時のビットレートを決めるために送る。**
    //
    // 画質を決めるのは 1 秒あたりのビット数ではなく「素材のコマ 1 つに何ビット割けたか」
    // なのに、アプリ側のビットレートは供給レート（内容によらず約 50枚/秒で一定）にしか
    // 連動していなかった。結果、60fps 素材は 24fps の倍の枚数を撮ることになり、素材 1 コマ
    // あたりが半分になる（実測: 60fps 150kbit に対し、目視合格した 24fps は 391kbit）。
    //
    // **この値はページ側でしか測れず、録画開始前に main が知る経路はここしか無い**
    // （コマ通知は録画中しか流れないので、開始時のビットレート決定には間に合わない）。
    // 未測定（再生直後でサンプルが MIN_FRAME_SAMPLES 未満）は null。**推定値では埋めない**
    // ——外れた値でビットレートを決めるより、従来どおりの固定値の方がよい。
    frameDurMs: measuredFrameDur != null ? measuredFrameDur * 1000 : null
  }
}

function payloadKey(payload) {
  const rect = payload.videoRect
  return JSON.stringify({
    t: payload.currentTime == null ? null : Math.floor(payload.currentTime),
    title: payload.title,
    url: payload.url,
    focused: payload.focused,
    win: [payload.windowLeft, payload.windowTop, payload.windowWidth, payload.windowHeight],
    inner: [payload.innerWidth, payload.innerHeight],
    dpr: payload.devicePixelRatio,
    rect: rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null,
    // 画質の切り替わりも「変化」として送る。ここに入れないと、他が全部同じ間は
    // 送信が抑制され、アプリ側が古い画質のまま縮める窓ができる。
    size: payload.videoSize ? [payload.videoSize.width, payload.videoSize.height] : null
  })
}

function postTimecode(payload, { force = false, bypassThrottle = false } = {}) {
  if (!port) return
  const now = Date.now()
  if (force && !bypassThrottle && now - lastSentAt < MIN_FORCED_SEND_INTERVAL_MS) return
  const key = payloadKey(payload)
  if (!force && key === lastPayloadKey) return
  lastPayloadKey = key
  lastSentAt = now
  port.postMessage(payload)
}

const VIDEO_EVENTS = ['play', 'pause', 'seeked', 'loadedmetadata']
let observedHandler = null
let fpsMetaHandler = null
function observeVideo(video) {
  if (!video) return
  // 同じ要素でも、トラッカーが止まっていれば張り直す（startFrameTracker は冪等）。
  // rVFC ループは要素が一時的に DOM から外れる（レイアウト移動・全画面切替）だけでも
  // 自分で止まるが、ここで早期 return していた頃は observedVideo が変わらないため
  // **二度と復帰しなかった**。コマ送りの基準（lastFrameTime）ごと黙って死ぬ経路だった。
  if (video === observedVideo) { startFrameTracker(video); return }
  if (observedVideo && observedHandler) {
    for (const eventName of VIDEO_EVENTS) observedVideo.removeEventListener(eventName, observedHandler)
    if (fpsMetaHandler) observedVideo.removeEventListener('loadedmetadata', fpsMetaHandler)
  }
  observedVideo = video
  observedHandler = () => sendTimecode({ force: true })
  for (const eventName of VIDEO_EVENTS) {
    video.addEventListener(eventName, observedHandler, { passive: true })
  }
  // メディア差し替え時は実測フレーム情報をリセットし、トラッカーを張り直す
  fpsMetaHandler = () => { resetFrameTracking(); stopFrameTracker(); startFrameTracker(video) }
  video.addEventListener('loadedmetadata', fpsMetaHandler, { passive: true })
  resetFrameTracking()
  startFrameTracker(video)
}

// 定期送信 — 動画が再生中なら送信、フォーカスがなくて動画も止まっているタブはスキップ
function sendTimecode(options = {}) {
  if (!port) return
  const video = getVideo()
  if (!document.hasFocus() && (!video || video.paused)) return
  postTimecode(buildPayload(), options)
}

// Electron の request-timecode に応答 — フォーカス不問
// immediate=false（スクリーンショット用）: rAF を2回重ねて
//   1回目: スタイル変更がレイアウト・ペイントに反映されるフレームを消費
//   2回目: ペイント後に発火 → その時点でタイムコードを返す
// immediate=true（録画用）: rAF なしで即時応答（UI 変更がないため rAF 不要）
function sendTimecodeNow(requestId, immediate) {
  if (!port) return
  const payload = buildPayload()
  if (requestId != null) {
    payload.requestId = requestId
    if (immediate) {
      postTimecode(payload, { force: true, bypassThrottle: true })
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => postTimecode(payload, { force: true, bypassThrottle: true })))
    }
  } else {
    postTimecode(payload, { force: true })
  }
}

// SW の WS が切れたとき、または SW 自体が死んだときにポートを張り直す
// これにより SW が再起動して WS も再接続される
function scheduleReconnect() {
  if (reconnectScheduled) return
  reconnectScheduled = true
  const dying = port
  port = null
  clearInterval(pingInterval)
  try { dying?.disconnect() } catch {}
  setTimeout(() => {
    reconnectScheduled = false
    connectPort()
  }, 1000)
}

function normalizePortMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.type === 'ws-connected') return { type: 'ws-connected' }
  if (msg.type === 'ws-disconnected') return { type: 'ws-disconnected' }
  if (msg.type === 'pre-capture') {
    const holdMs = Number(msg.holdMs)
    return {
      type: 'pre-capture',
      holdMs: Number.isFinite(holdMs) && holdMs > 0 ? Math.min(holdMs, MAX_UI_HOLD_MS) : undefined,
      video: msg.video === true
    }
  }
  if (msg.type === 'clip-arming') return { type: 'clip-arming', label: stepLabel(msg.label) }
  if (msg.type === 'clip-armed') {
    return {
      type: 'clip-armed',
      requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, MAX_REQUEST_ID_LENGTH) : undefined
    }
  }
  if (msg.type === 'post-capture') return { type: 'post-capture', immediate: msg.immediate === true }
  if (msg.type === 'notice') {
    const level = ['info', 'success', 'warning', 'error'].includes(msg.level) ? msg.level : 'info'
    const message = typeof msg.message === 'string' ? msg.message.slice(0, MAX_NOTICE_MESSAGE_LENGTH) : ''
    // id: ページに出したら同じ id で notice-shown を返す（出せなかったときだけアプリ側に出すため）。
    const id = typeof msg.id === 'string' && msg.id ? msg.id.slice(0, MAX_REQUEST_ID_LENGTH) : undefined
    return message ? { type: 'notice', level, message, pending: msg.pending === true, id } : null
  }
  if (msg.type === 'request-timecode') {
    return {
      type: 'request-timecode',
      requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, MAX_REQUEST_ID_LENGTH) : undefined,
      immediate: msg.immediate === true
    }
  }
  if (msg.type === 'settings') {
    const rawKey = typeof msg.captureKey === 'string' ? msg.captureKey : ''
    return {
      type: 'settings',
      frameFps: clampNumber(Number(msg.frameFps), 24, 1, 240),
      frameFpsAuto: msg.frameFpsAuto !== false,
      captureKey: isValidCaptureKey(rawKey) ? rawKey : 'S',
      // コマ送りの読み取り表示に出す文言。拡張は文言を持たない（原本は app の ja.ts）。
      stepLabels: {
        blocked: stepLabel(msg.stepLabels?.blocked),
        dropped: stepLabel(msg.stepLabels?.dropped)
      }
    }
  }
  return null
}

// 動画が一時停止中かつタブ非フォーカスだと sendTimecode が送られず port/WS が無通信になり、
// Chrome が MV3 Service Worker をアイドル停止 → port 切断 → SW 再起動というチャーンが起きる。
// 無通信を防ぐため、接続中は一定間隔で ping を送って SW/WS 双方のアイドルタイマーを更新する。
const PING_INTERVAL_MS = 20000
let pingInterval = null

function connectPort() {
  if (port) return

  try {
    port = chrome.runtime.connect({ name: 'shiori' })
  } catch {
    return  // 拡張コンテキスト無効
  }

  clearInterval(pingInterval)
  pingInterval = setInterval(() => {
    try { port?.postMessage({ type: 'ping' }) } catch {}
  }, PING_INTERVAL_MS)

  port.onMessage.addListener((msg) => {
    const safeMsg = normalizePortMessage(msg)
    if (!safeMsg) return

    if (safeMsg.type === 'ws-connected') {
      console.log('[Shiori] connected')
      clearInterval(timecodeInterval)
      lastPayloadKey = ''
      timecodeInterval = setInterval(sendTimecode, TIMECODE_POLL_MS)
      sendTimecode({ force: true })
    } else if (safeMsg.type === 'ws-disconnected') {
      // **ポートは張り直さない。** これが届く＝SW は生きているので、WS の再接続は SW の
      // バックオフに任せる。以前はここで張り直しており、SW の onConnect が待ちを最短に
      // 戻すため、アプリを起動していない間ずっと約 1 秒ごとに接続を試し続けていた
      // （タブの数だけ）。SW が死んだときは onDisconnect 側で張り直す。
      console.log('[Shiori] disconnected')
      clearInterval(timecodeInterval)
      // 準備中の表示を消す合図（clip-armed / post-capture）はもう来ない。残すと映像の上に
      // 出たままになる。コマ通知は止めない——アプリは繋ぎ直した後も録画を続けうる。
      hideArmingOverlay()
    } else if (safeMsg.type === 'request-timecode') {
      sendTimecodeNow(safeMsg.requestId, safeMsg.immediate)
    } else if (safeMsg.type === 'settings') {
      settingsFps = safeMsg.frameFps
      settingsFpsAuto = safeMsg.frameFpsAuto
      settingsCaptureKey = safeMsg.captureKey
      stepLabels = safeMsg.stepLabels
    } else if (safeMsg.type === 'pre-capture') {
      clearShioriNotice()
      hidePlayerUI(safeMsg.holdMs, safeMsg.video)
      cleanVideoFrame()
      // 動画クリップ録画のときだけコマ通知を出す（スクショは1枚なので不要）
      if (safeMsg.video) startFrameReporting()
    } else if (safeMsg.type === 'clip-arming') {
      showArmingOverlay(safeMsg.label)
    } else if (safeMsg.type === 'clip-armed') {
      hideArmingOverlay()
      // remove() は DOM を変えるだけで、まだペイントされていない。2 回目の rAF を越えて
      // から返し、録画側が captureTime でも消去後のフレームを確認できるようにする。
      const requestId = safeMsg.requestId
      if (requestId && port) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { port?.postMessage({ type: 'clip-armed-painted', requestId, paintedAt: Date.now() }) } catch {}
        }))
      }
    } else if (safeMsg.type === 'post-capture') {
      stopFrameReporting()
      hideArmingOverlay()
      scheduleRestorePlayerUI(safeMsg.immediate)
    } else if (safeMsg.type === 'notice') {
      showShioriNotice(safeMsg.level, safeMsg.message, safeMsg.pending)
      // 出したことをアプリへ返す。**返らなかった知らせはアプリの画面に回る**（別のタブを見ていた等）。
      if (safeMsg.id && port) {
        try { port.postMessage({ type: 'notice-shown', requestId: safeMsg.id }) } catch {}
      }
    }
  })

  port.onDisconnect.addListener(() => {
    port = null
    clearInterval(timecodeInterval)
    hideArmingOverlay()
    clearInterval(pingInterval)
    scheduleReconnect()  // SW が死んだ → 同様に再接続
  })
}

window.addEventListener('focus', () => sendTimecode({ force: true }))
window.addEventListener('pagehide', () => {
  clearInterval(timecodeInterval)
  clearInterval(ytNavPoll)
  clearInterval(pingInterval)
  restorePlayerUI()
})

// YouTube SPA ナビゲーション後、動画要素とタイトルが揃うまでポーリングして再送
document.addEventListener('yt-navigate-finish', () => {
  clearInterval(ytNavPoll)
  cachedTitle = '' // 前の動画のタイトルを新しい動画に持ち越さない
  let ticks = 0
  ytNavPoll = setInterval(() => {
    ticks++
    const video = getVideo()
    const titleReady = document.title && document.title !== 'YouTube'
    if ((video && titleReady) || ticks >= 50) {
      clearInterval(ytNavPoll)
      ytNavPoll = null
      sendTimecodeNow()
    }
  }, 100)
})

// 動画のあるページでは作品名を 1 秒おきに読んで覚えておく（getPageTitleCached）。撮った瞬間だけ
// 読めないことがある（Prime Video で、プレーヤーの作品名が取れずタブ名もサイト共通の文だった）。
// 定期送信（TIMECODE_POLL_MS）にも読む機会はあるが 5 秒おきで、再生してすぐ撮ると覚えた名前がまだ無い。
setInterval(() => { if (getVideo()) getPageTitleCached() }, 1000)

// Netflix の一時停止広告を常に消す（中身は content-capture.js の hideNetflixPauseAd）。
hideNetflixPauseAd()
connectPort()
