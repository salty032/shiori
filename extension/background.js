// 平文 ws:// のまま繋ぐ。Firefox の MV3 既定 CSP は upgrade-insecure-requests を含むため、
// manifest.json の content_security_policy.extension_pages でそれを外した CSP を明示している。
// この指定を消すと Firefox だけ wss:// に格上げされ、TLS 非対応のローカルサーバーに繋がらなくなる。
// ==== ここから自動生成: ports ====
// 以下は app/src/shared/wire-limits.ts が原本。**手で書き換えない**（verify が落とす）。
// 直すときは wire-limits.ts を変えてから app/ で `npm run ext:limits` を実行する。
// 接続先ポートの候補。アプリは先頭から順に listen を試し、こちらは先頭から順に
// 接続を試すので、どのポートに落ち着いても合流する。複数ある理由は、Windows の
// Hyper-V / WSL2 / Docker Desktop が起動ごとにポートをブロック単位で予約するため。
const WS_PORTS = [39821, 41821, 43821, 45821]
// ==== ここまで自動生成: ports ====
let portIndex = 0
let ws = null
let reconnectTimer = null
let reconnectDelay = 2000
const RECONNECT_DELAY_MIN = 2000
const RECONNECT_DELAY_MAX = 30000
// 候補から候補へ移るときの待ち。ローカルの接続拒否は即座に返るので短くてよい。
// ここに指数バックオフをかけると、開いているポートに辿り着くまで分単位かかる。
const RECONNECT_DELAY_NEXT_PORT = 300
// ==== ここから自動生成: limits ====
// 以下は app/src/shared/wire-limits.ts が原本。**手で書き換えない**（verify が落とす）。
// 直すときは wire-limits.ts を変えてから app/ で `npm run ext:limits` を実行する。
const MAX_WS_MESSAGE_BYTES = 16384
const MAX_TITLE_LENGTH = 500
const MAX_URL_LENGTH = 2048
const MAX_REQUEST_ID_LENGTH = 80
const MAX_NOTICE_MESSAGE_LENGTH = 240
const MAX_STEP_LABEL_LENGTH = 120
const MAX_TIMECODE_SECONDS = 10000000
const MIN_SCREEN_COORD = -100000
const MAX_SCREEN_COORD = 100000
const MIN_SCREEN_SIZE = 1
const MAX_SCREEN_SIZE = 20000
const MIN_DEVICE_PIXEL_RATIO = 0.25
const MAX_DEVICE_PIXEL_RATIO = 8
// 素材のコマ間隔（ミリ秒）の許容範囲。content.js の startFrameTracker が実測値を
// 採用する条件（10〜120fps）と同じ。
const MIN_SOURCE_FRAME_MS = 8.333333333333334
const MAX_SOURCE_FRAME_MS = 100
// コマ通知の displayAt（epoch ミリ秒）の妥当上限。西暦 2100 年相当。
// 壊れた値・別基準の時刻（performance.now() の生値など）が混ざったまま main 側の
// 時刻計算に入ると、コマの対応付けが黙って狂うため入口で落とす。
const MAX_EPOCH_MS = 4102444800000
// プレーヤー UI を隠したままにできる上限（ms）。クリップの最長 30 秒＋停止処理の
// マージンを十分に超える値だが、壊れた値で UI が延々と隠れたままになるのは防ぐ。
const MAX_UI_HOLD_MS = 120000
// shared/hotkey.ts の NAMED_KEYS と対になる、captureKey として許容する名前付きメインキー。
const NAMED_CAPTURE_KEYS = new Set([
  'Space', 'Tab', 'Enter', 'Return', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'
])
// ==== ここまで自動生成: limits ====
function isValidCaptureKey(k) {
  return /^[A-Za-z0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED_CAPTURE_KEYS.has(k)
}

let cachedSettings = null      // 最後に受信した settings メッセージ（新規タブ接続時に送る）
const portSet = new Set()      // 全 port（ブロードキャスト用）
const portByTab = new Map()    // tabId -> port（アクティブタブ特定用）
let lastActiveTabId = null     // 直近にタイムコードを送ってきたタブ
let lastFocusedTabId = null    // 直近にフォーカス状態でタイムコードを送ってきたタブ

function byteLength(value) {
  return new TextEncoder().encode(value).length
}

// 不正・過大な値は落として content.js 側の既定にフォールバックさせる
function clampHoldMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(Math.round(n), MAX_UI_HOLD_MS)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedNumber(value, min, max) {
  const n = finiteNumber(value)
  return n == null || n < min || n > max ? null : n
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeRect(value) {
  if (!value || typeof value !== 'object') return null
  const left = boundedNumber(value.left, MIN_SCREEN_COORD, MAX_SCREEN_COORD)
  const top = boundedNumber(value.top, MIN_SCREEN_COORD, MAX_SCREEN_COORD)
  const width = boundedNumber(value.width, 0, MAX_SCREEN_SIZE)
  const height = boundedNumber(value.height, 0, MAX_SCREEN_SIZE)
  return left == null || top == null || width == null || height == null
    ? null
    : { left, top, width, height }
}

function normalizePortMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.type === 'ping') return { type: 'ping' }
  // 録画中にコマ通知が途切れたことの知らせ（値は持たない）。content.js の rVFC ループが
  // <video> の差し替えなどで止まると送られる。落とすと「表が録画の途中で終わっているのに
  // 誰も気づかない」状態に戻るので、そのまま中継する。
  if (msg.type === 'frame-gap') return { type: 'frame-gap' }
  // 録画中に content.js が送る素材のコマ通知。mediaTime は素材のタイムライン上の秒、
  // displayAt はそのコマが画面に出る epoch ミリ秒。録画のコマ供給を駆動する値なので、
  // 欠けた値・範囲外は中継せず落とす（黙って 0 を送ると全コマの対応がずれる）。
  if (msg.type === 'frame') {
    const mediaTime = boundedNumber(msg.mediaTime, 0, MAX_TIMECODE_SECONDS)
    const displayAt = boundedNumber(msg.displayAt, 0, MAX_EPOCH_MS)
    return mediaTime == null || displayAt == null ? null : { type: 'frame', mediaTime, displayAt }
  }
  if (msg.type !== 'timecode') return null

  const currentTime = msg.currentTime === null ? null : boundedNumber(msg.currentTime, 0, MAX_TIMECODE_SECONDS)
  const windowLeft = boundedNumber(msg.windowLeft, MIN_SCREEN_COORD, MAX_SCREEN_COORD)
  const windowTop = boundedNumber(msg.windowTop, MIN_SCREEN_COORD, MAX_SCREEN_COORD)
  const windowWidth = boundedNumber(msg.windowWidth, MIN_SCREEN_SIZE, MAX_SCREEN_SIZE)
  const windowHeight = boundedNumber(msg.windowHeight, MIN_SCREEN_SIZE, MAX_SCREEN_SIZE)
  const innerWidth = boundedNumber(msg.innerWidth, MIN_SCREEN_SIZE, MAX_SCREEN_SIZE)
  const innerHeight = boundedNumber(msg.innerHeight, MIN_SCREEN_SIZE, MAX_SCREEN_SIZE)
  const devicePixelRatio = boundedNumber(msg.devicePixelRatio, MIN_DEVICE_PIXEL_RATIO, MAX_DEVICE_PIXEL_RATIO)
  if (
    (currentTime === null && msg.currentTime !== null) ||
    windowLeft == null ||
    windowTop == null ||
    windowWidth == null ||
    windowHeight == null ||
    innerWidth == null ||
    innerHeight == null ||
    devicePixelRatio == null
  ) {
    return null
  }

  return {
    type: 'timecode',
    currentTime,
    title: text(msg.title, MAX_TITLE_LENGTH),
    url: safeUrl(msg.url),
    focused: msg.focused === true,
    requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, MAX_REQUEST_ID_LENGTH) : undefined,
    windowLeft,
    windowTop,
    windowWidth,
    windowHeight,
    innerWidth,
    innerHeight,
    devicePixelRatio,
    videoRect: safeRect(msg.videoRect),
    fullscreen: msg.fullscreen === true,
    // 素材のコマ間隔。**ここに書き足し忘れると content.js が送っていても消える**
    // （この関数は項目を1つずつ書き写して作り直すため）。実際にそれで
    // 「ビットレートが連動しない」ように見えた（2026-08-13）。
    frameDurMs: boundedNumber(msg.frameDurMs, MIN_SOURCE_FRAME_MS, MAX_SOURCE_FRAME_MS)
  }
}

function normalizeServerMessage(data) {
  if (typeof data !== 'string' || byteLength(data) > MAX_WS_MESSAGE_BYTES) return null

  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    return null
  }

  if (!msg || typeof msg !== 'object') return null
  if (msg.type === 'connected') return { type: 'connected' }
  // holdMs: プレーヤー UI を隠したままにする上限（録画では録画の長さぶん伸ばす）。
  // 省略時は content.js 側の既定にフォールバックする。
  // video: true のときだけ content.js は OS カーソルを消す（スクショはカーソルが
  // そもそもキャプチャに写らないため消す必要が無い）。
  if (msg.type === 'pre-capture') {
    return { type: 'pre-capture', holdMs: clampHoldMs(msg.holdMs), video: msg.video === true }
  }
  // immediate: ホスト別の復帰待ちを踏まずにすぐ戻す（クリップ録画のみ。content.js の
  // restoreDelayFor を参照）。
  // 録画の「準備中」表示の出し／消し。記録が始まる前だけ出るので録画には写らない
  // （app 側 recording.ts の waitForSteadyFrames）。**pre-capture と同じくアクティブタブへ送る**
  // —— 全ポートへ配ると、裏のタブにも準備中が出たまま残る。
  if (msg.type === 'clip-arming') return { type: 'clip-arming' }
  if (msg.type === 'clip-armed') return { type: 'clip-armed' }
  if (msg.type === 'post-capture') return { type: 'post-capture', immediate: msg.immediate === true }
  if (msg.type === 'notice') {
    const level = ['info', 'success', 'warning', 'error'].includes(msg.level) ? msg.level : 'info'
    const message = typeof msg.message === 'string' ? msg.message.slice(0, MAX_NOTICE_MESSAGE_LENGTH) : ''
    return message ? { type: 'notice', level, message } : null
  }
  if (msg.type === 'request-timecode') {
    return {
      type: 'request-timecode',
      requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, MAX_REQUEST_ID_LENGTH) : undefined,
      immediate: msg.immediate === true
    }
  }
  if (msg.type === 'settings') {
    const frameFps = boundedNumber(Number(msg.frameFps), 1, 240) ?? 24
    const rawKey = typeof msg.captureKey === 'string' ? msg.captureKey : ''
    const captureKey = isValidCaptureKey(rawKey) ? rawKey : 'S'
    // **ここは項目を1つずつ書き写して作り直す。** 書き足し忘れると content.js まで届かない
    // （過去にビットレートの連動をこれで丸ごと落とした。extension-parity.test.ts が固定）。
    const label = (v) => (typeof v === 'string' ? v.slice(0, MAX_STEP_LABEL_LENGTH) : '')
    const stepLabels = {
      blocked: label(msg.stepLabels?.blocked),
      dropped: label(msg.stepLabels?.dropped)
    }
    return { type: 'settings', frameFps, frameFpsAuto: msg.frameFpsAuto !== false, captureKey, stepLabels }
  }
  return null
}

function sendWsMessage(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const data = JSON.stringify(msg)
  if (byteLength(data) <= MAX_WS_MESSAGE_BYTES) ws.send(data)
}

function notifyAllPorts(msg) {
  for (const port of portSet) {
    try { port.postMessage(msg) } catch {}
  }
}

// request-timecode / pre-capture / post-capture は「最後にフォーカスされた Chrome ウィンドウのアクティブタブ」に送る
// そのタブに port がなければ lastActiveTabId にフォールバック
function notifyActiveTab(msg) {
  chrome.windows.getLastFocused({ windowTypes: ['normal', 'popup'] }, (win) => {
    if (win?.id) {
      chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
        const tabId = tabs[0]?.id
        const port = tabId != null ? portByTab.get(tabId) : null
        if (port) {
          try { port.postMessage(msg) } catch {}
          return
        }
        sendToLastActive(msg)
      })
    } else {
      sendToLastActive(msg)
    }
  })
}

function sendToLastActive(msg) {
  // フォーカスされていたタブを優先、なければ直近送信タブ
  const tabId = lastFocusedTabId ?? lastActiveTabId
  if (tabId == null) return
  const port = portByTab.get(tabId)
  if (port) try { port.postMessage(msg) } catch {}
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return

  const url = `ws://127.0.0.1:${WS_PORTS[portIndex]}`
  // 一度でも open したかを憶えておく。open せずに閉じた＝そのポートにアプリが居ない
  // ので次の候補へ進む。open 後の close はアプリの終了・再起動なので、同じポートで待つ。
  let opened = false

  console.log('[Shiori SW] connecting to', url)
  ws = new WebSocket(url)

  ws.addEventListener('open', () => {
    opened = true
    console.log('[Shiori SW] WS connected on port', WS_PORTS[portIndex])
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    reconnectDelay = RECONNECT_DELAY_MIN
    notifyAllPorts({ type: 'ws-connected' })
  })

  ws.addEventListener('message', (event) => {
    const msg = normalizeServerMessage(event.data)
    if (!msg) return
    if (msg.type === 'settings') cachedSettings = msg
    if (['request-timecode', 'pre-capture', 'post-capture', 'notice', 'clip-arming', 'clip-armed'].includes(msg.type)) {
      notifyActiveTab(msg)
    } else {
      notifyAllPorts(msg)
    }
  })

  ws.addEventListener('close', () => {
    ws = null
    notifyAllPorts({ type: 'ws-disconnected' })
    clearTimeout(reconnectTimer)

    if (opened) {
      // 繋がっていた相手が消えた（アプリの終了・更新）。ポートは変えず、最短で待ち直す。
      console.log('[Shiori SW] WS disconnected, retry in', reconnectDelay, 'ms')
      reconnectTimer = setTimeout(connectWS, reconnectDelay)
      reconnectDelay = Math.min(RECONNECT_DELAY_MAX, reconnectDelay * 2)
      return
    }

    // 繋がらなかった。次の候補へ。待ち時間を伸ばすのは候補を 1 周してからにする。
    portIndex = (portIndex + 1) % WS_PORTS.length
    const cycled = portIndex === 0
    console.log('[Shiori SW] no app on that port, next candidate in',
      cycled ? reconnectDelay : RECONNECT_DELAY_NEXT_PORT, 'ms')
    reconnectTimer = setTimeout(connectWS, cycled ? reconnectDelay : RECONNECT_DELAY_NEXT_PORT)
    if (cycled) reconnectDelay = Math.min(RECONNECT_DELAY_MAX, reconnectDelay * 2)
  })

  ws.addEventListener('error', () => ws?.close())
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'shiori') return
  portSet.add(port)
  const tabId = port.sender?.tab?.id
  if (tabId != null) portByTab.set(tabId, port)

  port.onMessage.addListener((msg) => {
    const safeMsg = normalizePortMessage(msg)
    if (!safeMsg) return
    if (safeMsg.type === 'timecode') {
      if (tabId != null) {
        lastActiveTabId = tabId
        if (safeMsg.focused) lastFocusedTabId = tabId
      }
      // window.screenLeft/Top は popup ウィンドウで不正な値を返すことがある。
      // chrome.windows API 経由で実際の画面座標に上書きする。
      const windowId = port.sender?.tab?.windowId
      if (windowId != null) {
        chrome.windows.get(windowId, (win) => {
          if (!chrome.runtime.lastError && win != null) {
            if (win.left != null) safeMsg.windowLeft = win.left
            if (win.top != null) safeMsg.windowTop = win.top
          }
          sendWsMessage(safeMsg)
        })
        return
      }
    }
    sendWsMessage(safeMsg)
  })

  port.onDisconnect.addListener(() => {
    portSet.delete(port)
    if (tabId != null && portByTab.get(tabId) === port) portByTab.delete(tabId)
    if (lastActiveTabId === tabId) lastActiveTabId = null
    if (lastFocusedTabId === tabId) lastFocusedTabId = null
  })

  if (ws && ws.readyState === WebSocket.OPEN) {
    port.postMessage({ type: 'ws-connected' })
    if (cachedSettings) port.postMessage(cachedSettings)
  } else if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    // WS 切断中に新しいタブが接続してきたら、バックオフ満了（最大 30 秒）を待たずに即再接続する。
    // 「アプリを起動し直したのに拡張がしばらく繋がらない」体感を短縮する。
    // connectWS() は CONNECTING/OPEN のときは何もしないので、多重接続にはならない。
    reconnectDelay = RECONNECT_DELAY_MIN
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    connectWS()
  }
})

connectWS()
