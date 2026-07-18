// 平文 ws:// のまま繋ぐ。Firefox の MV3 既定 CSP は upgrade-insecure-requests を含むため、
// manifest.json の content_security_policy.extension_pages でそれを外した CSP を明示している。
// この指定を消すと Firefox だけ wss:// に格上げされ、TLS 非対応のローカルサーバーに繋がらなくなる。
const WS_URL = 'ws://127.0.0.1:39821'
let ws = null
let reconnectTimer = null
let reconnectDelay = 2000
const RECONNECT_DELAY_MIN = 2000
const RECONNECT_DELAY_MAX = 30000
const MAX_WS_MESSAGE_BYTES = 16 * 1024
const MAX_TITLE_LENGTH = 500
const MAX_URL_LENGTH = 2048
const MAX_REQUEST_ID_LENGTH = 80
const MAX_NOTICE_MESSAGE_LENGTH = 240
const MAX_TIMECODE_SECONDS = 10000000
const MIN_SCREEN_COORD = -100000
const MAX_SCREEN_COORD = 100000
const MIN_SCREEN_SIZE = 1
const MAX_SCREEN_SIZE = 20000
const MIN_DEVICE_PIXEL_RATIO = 0.25
const MAX_DEVICE_PIXEL_RATIO = 8
// shared/hotkey.ts の NAMED_KEYS と対になる、captureKey として許容する名前付きメインキー。
const NAMED_CAPTURE_KEYS = new Set([
  'Space', 'Tab', 'Enter', 'Return', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'
])
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
    // [DIAG] 一時計測 — タイトル欠け／クロップ見切れ調査用。調査後に削除する。
    // 上限は ws-server.ts の diagJson 上限(2400)と揃える。content 側は 2000 で切るため通常は素通し。
    diagJson: typeof msg.diagJson === 'string' ? msg.diagJson.slice(0, 2400) : undefined
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
  if (msg.type === 'pre-capture') return { type: 'pre-capture' }
  if (msg.type === 'post-capture') return { type: 'post-capture' }
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
    return { type: 'settings', frameFps, frameFpsAuto: msg.frameFpsAuto !== false, captureKey }
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

  console.log('[Shiori SW] connecting to', WS_URL)
  ws = new WebSocket(WS_URL)

  ws.addEventListener('open', () => {
    console.log('[Shiori SW] WS connected')
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    reconnectDelay = RECONNECT_DELAY_MIN
    notifyAllPorts({ type: 'ws-connected' })
  })

  ws.addEventListener('message', (event) => {
    const msg = normalizeServerMessage(event.data)
    if (!msg) return
    if (msg.type === 'settings') cachedSettings = msg
    if (['request-timecode', 'pre-capture', 'post-capture', 'notice'].includes(msg.type)) {
      notifyActiveTab(msg)
    } else {
      notifyAllPorts(msg)
    }
  })

  ws.addEventListener('close', () => {
    ws = null
    console.log('[Shiori SW] WS disconnected, retry in', reconnectDelay, 'ms')
    notifyAllPorts({ type: 'ws-disconnected' })
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectWS, reconnectDelay)
    reconnectDelay = Math.min(RECONNECT_DELAY_MAX, reconnectDelay * 2)
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
