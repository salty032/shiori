import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'

export const PORT = 39821
const HOST = '127.0.0.1'
const MAX_TITLE_LENGTH = 500
const MAX_URL_LENGTH = 2048
const MAX_WS_PAYLOAD_BYTES = 16 * 1024
const MAX_REQUEST_ID_LENGTH = 80
const MAX_TIMECODE_SECONDS = 10_000_000
const MIN_SCREEN_COORD = -100_000
const MAX_SCREEN_COORD = 100_000
const MIN_SCREEN_SIZE = 1
const MAX_SCREEN_SIZE = 20_000
const MIN_DEVICE_PIXEL_RATIO = 0.25
const MAX_DEVICE_PIXEL_RATIO = 8

export type VideoRect = { left: number; top: number; width: number; height: number }

export type ExtensionMessage =
  | { type: 'timecode'; currentTime: number | null; title: string; url: string | null; focused: boolean; requestId?: string; windowLeft: number; windowTop: number; windowWidth: number; windowHeight: number; innerWidth: number; innerHeight: number; devicePixelRatio: number; videoRect: VideoRect | null; fullscreen: boolean }
  | { type: 'ping' }

type MessageHandler = (msg: ExtensionMessage) => void
type ConnectCallback = (send: (msg: object) => void) => void

let httpServer: ReturnType<typeof createServer> | null = null
let wss: WebSocketServer | null = null
// ポート占有で listen に失敗した場合、呼び出し側（bootstrap）へ伝える一回限りのフラグ。
// startWsServer はウィンドウ生成前に呼ばれるため sendNotice は無言で消える。他の破損設定通知
// （consumeCorruptSettingsNotice）と同じパターンで、ウィンドウ準備後に拾わせる。
let _portInUseNotice = false

export function consumePortInUseNotice(): boolean {
  const v = _portInUseNotice
  _portInUseNotice = false
  return v
}
// 設定で明示された許可拡張 ID。normalizeSettings が常に非空（未設定時は既定拡張IDへフォールバック）を保証する。
let allowedExtensionIds: string[] = []
const handlers: MessageHandler[] = []
const connectCallbacks: ConnectCallback[] = []

export function onWsClientConnect(cb: ConnectCallback): void {
  connectCallbacks.push(cb)
}

function extensionOrigin(origin: string | undefined): string | null {
  if (typeof origin !== 'string') return null
  try {
    const url = new URL(origin)
    if (url.protocol !== 'chrome-extension:') return null
    // url.origin は chrome-extension: スキームで Node.js が "null" (文字列) を返すため手動構築
    return /^[a-p]{32}$/.test(url.hostname) ? `chrome-extension://${url.hostname}` : null
  } catch {
    return null
  }
}

function extensionIdOf(normalizedOrigin: string): string {
  return new URL(normalizedOrigin).hostname
}

export function isAllowedHttpOrigin(origin: string | undefined): boolean {
  const normalized = extensionOrigin(origin)
  if (!normalized) return false
  return allowedExtensionIds.includes(extensionIdOf(normalized))
}

export function isAllowedWsOrigin(origin: string | undefined): boolean {
  const normalized = extensionOrigin(origin)
  if (!normalized) return false
  const ok = allowedExtensionIds.includes(extensionIdOf(normalized))
  if (!ok) console.warn(`[WS] rejected extension not in allowlist: ${normalized}`)
  return ok
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  const n = finiteNumber(value)
  return n == null || n < min || n > max ? null : n
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeRect(value: unknown): VideoRect | null {
  if (!value || typeof value !== 'object') return null
  const rect = value as Record<string, unknown>
  const left = finiteNumber(rect.left)
  const top = finiteNumber(rect.top)
  const width = boundedNumber(rect.width, 0, MAX_SCREEN_SIZE)
  const height = boundedNumber(rect.height, 0, MAX_SCREEN_SIZE)
  if (left == null || top == null || width == null || height == null) return null
  if (left < MIN_SCREEN_COORD || left > MAX_SCREEN_COORD || top < MIN_SCREEN_COORD || top > MAX_SCREEN_COORD) return null
  return { left, top, width, height }
}

export function parseExtensionMessage(raw: string): ExtensionMessage | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_WS_PAYLOAD_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const msg = parsed as Record<string, unknown>
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
    fullscreen: msg.fullscreen === true
  }
}

export function startWsServer(options?: { allowedExtensionIds?: string[] }): void {
  allowedExtensionIds = options?.allowedExtensionIds ?? []
  if (allowedExtensionIds.length > 0) {
    console.log(`[WS] extension allowlist active (${allowedExtensionIds.length} id(s))`)
  }
  // Chrome の Private Network Access プリフライト (OPTIONS) に応答する HTTP サーバーを土台にする
  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = firstHeader(req.headers['origin'])
    if (!isAllowedHttpOrigin(origin)) {
      res.writeHead(403)
      res.end()
      return
    }

    if (req.method !== 'OPTIONS') {
      res.writeHead(405)
      res.end()
      return
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': origin ?? '',
      'Access-Control-Allow-Methods': 'OPTIONS',
      'Access-Control-Allow-Headers': 'Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol, Content-Type',
      'Access-Control-Allow-Private-Network': 'true'
    }

    res.writeHead(200, corsHeaders)
    res.end()
  })

  wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: (info: { req: IncomingMessage }) => {
      return isAllowedWsOrigin(firstHeader(info.req.headers['origin']))
    }
  })

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] extension connected')
    ws.send(JSON.stringify({ type: 'connected' }))
    const sendToClient = (msg: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    connectCallbacks.forEach((cb) => cb(sendToClient))

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        console.warn('[WS] rejected binary message')
        return
      }
      const msg = parseExtensionMessage(raw.toString())
      if (!msg) {
        console.warn('[WS] invalid message', raw.toString().slice(0, 200))
        return
      }
      handlers.forEach((h) => h(msg))
    })

    ws.on('close', () => console.log('[WS] extension disconnected'))
  })

  wss.on('error', (err) => console.error('[WS] server error', err))

  httpServer.listen(PORT, HOST, () => {
    console.log(`[WS] listening on ws://${HOST}:${PORT}`)
  })

  httpServer.on('error', (err) => {
    console.error('[WS] http server error', err)
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') _portInUseNotice = true
  })
}

// ハンドラ登録。戻り値を呼ぶと解除できる（一時ハンドラ用）
export function onExtensionMessage(handler: MessageHandler): () => void {
  handlers.push(handler)
  return () => {
    const idx = handlers.indexOf(handler)
    if (idx !== -1) handlers.splice(idx, 1)
  }
}

// 全接続クライアントにメッセージをブロードキャスト
export function broadcastMessage(msg: object): void {
  if (!wss) return
  const data = JSON.stringify(msg)
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  })
}

export function setAllowedExtensionIds(ids: string[]): void {
  allowedExtensionIds = ids
}

export function stopWsServer(): void {
  wss?.close()
  httpServer?.close()
}

export function _resetWsStateForTest(opts?: { allowedIds?: string[] }): void {
  allowedExtensionIds = opts?.allowedIds ?? []
}
