import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'

export const PORT = 39821
const HOST = '127.0.0.1'
// extension/background.js（バンドラ無しのため import 不可）にも同じ値のコピーがある。
// 片側だけ変えると静かに食い違うため、ws-server.test.ts のパリティテストが
// このモジュールの export 値と background.js のテキストを比較して検知する（M-1）。
export const MAX_TITLE_LENGTH = 500
export const MAX_URL_LENGTH = 2048
export const MAX_WS_PAYLOAD_BYTES = 16 * 1024
export const MAX_REQUEST_ID_LENGTH = 80
export const MAX_TIMECODE_SECONDS = 10_000_000
export const MIN_SCREEN_COORD = -100_000
export const MAX_SCREEN_COORD = 100_000
export const MIN_SCREEN_SIZE = 1
export const MAX_SCREEN_SIZE = 20_000
export const MIN_DEVICE_PIXEL_RATIO = 0.25
export const MAX_DEVICE_PIXEL_RATIO = 8
// コマ通知の displayAt（epoch ミリ秒）の妥当上限。西暦 2100 年相当。
// 壊れた値・別基準の時刻（performance.now() の生値など）が混ざったまま時刻計算に入ると、
// コマの対応付けが黙って狂うため入口で落とす。
export const MAX_EPOCH_MS = 4_102_444_800_000

export type VideoRect = { left: number; top: number; width: number; height: number }

export type ExtensionMessage =
  | { type: 'timecode'; currentTime: number | null; title: string; url: string | null; focused: boolean; requestId?: string; windowLeft: number; windowTop: number; windowWidth: number; windowHeight: number; innerWidth: number; innerHeight: number; devicePixelRatio: number; videoRect: VideoRect | null; fullscreen: boolean; version?: string }
  | { type: 'ping' }
  // 録画中に配信ページ側から届く、素材の1コマぶんの通知。
  // mediaTime は素材自身のタイムライン上の秒、displayAt はそのコマが画面に出る epoch ミリ秒。
  // 画面キャプチャ側の時計とは無関係で、素材の実コマを知る唯一の経路。
  | { type: 'frame'; mediaTime: number; displayAt: number }

// バージョン文字列（例 "1.1.0"）の表示・比較用途の上限。UI表示にしか使わないため
// セキュリティ上重要な値ではなく、拡張側とのパリティ対象にもしない（UX-9）。
const MAX_VERSION_LENGTH = 32

type MessageHandler = (msg: ExtensionMessage) => void
type ConnectCallback = (send: (msg: object) => void) => void

let httpServer: ReturnType<typeof createServer> | null = null
let wss: WebSocketServer | null = null
// ポート占有で listen に失敗した場合、呼び出し側（bootstrap）へ伝える。
// フラグ + ポーリング（consume 方式）だと、EADDRINUSE は listen 後の非同期 'error' イベントで
// 初めて立つのに対し、bootstrap の確認は startWsServer と同じ同期ブロック内で走るため、
// 通知を必ず取りこぼす。検知した時点で push する購読型にして順序依存をなくす。
let portInUseDetected = false
const portInUseCallbacks: Array<() => void> = []

// startWsServer の前後どちらで登録しても届く（検知済みなら即時実行）。
export function onPortInUse(cb: () => void): void {
  if (portInUseDetected) cb()
  else portInUseCallbacks.push(cb)
}

function notifyPortInUse(): void {
  if (portInUseDetected) return
  portInUseDetected = true
  portInUseCallbacks.splice(0).forEach((cb) => cb())
}
// 設定で明示された許可拡張 ID。normalizeSettings が常に非空（未設定時は既定拡張IDへフォールバック）を保証する。
let allowedExtensionIds: string[] = []
const handlers: MessageHandler[] = []
const connectCallbacks: ConnectCallback[] = []

export function onWsClientConnect(cb: ConnectCallback): void {
  connectCallbacks.push(cb)
}

const MOZ_EXTENSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type ExtensionOrigin = { origin: string; id: string; requiresAllowlist: boolean }

function extensionOrigin(origin: string | undefined): ExtensionOrigin | null {
  if (typeof origin !== 'string') return null
  try {
    const url = new URL(origin)
    // url.origin は拡張スキームで Node.js が "null" (文字列) を返すため手動構築
    if (url.protocol === 'chrome-extension:') {
      if (!/^[a-p]{32}$/.test(url.hostname)) return null
      return { origin: `chrome-extension://${url.hostname}`, id: url.hostname, requiresAllowlist: true }
    }
    // Firefox の moz-extension UUID はプロファイル/インストールごとに再生成され固定できないため、
    // allowlist 照合はできない。UUID 形式のみ検証して通す（接続元は 127.0.0.1 限定、
    // 受け取れるのは parseExtensionMessage を通過する限定メッセージのみ）。
    if (url.protocol === 'moz-extension:') {
      if (!MOZ_EXTENSION_UUID.test(url.hostname)) return null
      return { origin: `moz-extension://${url.hostname}`, id: url.hostname, requiresAllowlist: false }
    }
    return null
  } catch {
    return null
  }
}

function isAllowedExtension(ext: ExtensionOrigin): boolean {
  return !ext.requiresAllowlist || allowedExtensionIds.includes(ext.id)
}

export function isAllowedHttpOrigin(origin: string | undefined): boolean {
  const ext = extensionOrigin(origin)
  return ext ? isAllowedExtension(ext) : false
}

export function isAllowedWsOrigin(origin: string | undefined): boolean {
  const ext = extensionOrigin(origin)
  // 拡張スキームとして解釈できない origin も理由を残す。無言で落とすと
  // 接続できない拡張の切り分け（origin 未送出・想定外スキーム）が不可能になる。
  if (!ext) {
    console.warn(`[WS] rejected connection with unrecognized origin: ${origin ?? '(no origin header)'}`)
    return false
  }
  const ok = isAllowedExtension(ext)
  if (!ok) console.warn(`[WS] rejected extension not in allowlist: ${ext.origin}`)
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
    version: typeof msg.version === 'string' ? msg.version.slice(0, MAX_VERSION_LENGTH) : undefined
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
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') notifyPortInUse()
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
  portInUseDetected = false
  portInUseCallbacks.length = 0
}
