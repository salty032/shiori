import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'

// 拡張との接続に使うポートの候補。**extension/background.js の WS_PORTS と同じ並びで
// あること**（extension-parity.test.ts が検知する）。アプリは先頭から順に listen を試し、
// 拡張は先頭から順に接続を試す。同じ並びを両側が持つので、どこに落ち着いても設定は要らない。
//
// なぜ 1 つでは足りないか — Windows は Hyper-V / WSL2 / Docker Desktop が有効だと、
// 起動のたびに TCP ポートを**ブロック単位でまとめて予約**する
// （netsh int ipv4 show excludedportrange protocol=tcp で見える）。予約範囲は再起動ごとに
// 変わるため、固定 1 ポートだと「昨日まで動いていたのに今日は繋がらない」が利用者側で
// 突然起きる。利用者に心当たりは無く、拡張を入れ直しても直らない。
//
// 候補の選び方 — 予約は連続ブロックで来るので、隣（39822 など）は同じブロックに巻き込まれる。
// 2000 ずつ離す。全部 Windows の既定の動的ポート範囲（49152-65535）より下に置き、
// そちらの自動割り当てとは衝突しないようにする。
// 先頭は必ず 39821 のまま（既存の利用者が今そこで繋がっているため、並べ替えると
// 更新直後の 1 回だけ全員が候補探しをすることになる）。
export const WS_PORTS = [39821, 41821, 43821, 45821] as const

// 実際に listen できたポート。どれも確保できなければ null のまま。
let activePort: number | null = null
export function getActivePort(): number | null {
  return activePort
}

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
// 素材のコマ間隔（ミリ秒）の許容範囲。拡張側が実測値を採用する条件（10〜120fps。
// content.js の startFrameTracker）と揃えてある。範囲外なら null にして「測れていない」
// 扱いにする——**壊れた値でビットレートを決めるくらいなら、従来どおりの固定値でよい。**
export const MIN_SOURCE_FRAME_MS = 1000 / 120
export const MAX_SOURCE_FRAME_MS = 1000 / 10
// コマ通知の displayAt（epoch ミリ秒）の妥当上限。西暦 2100 年相当。
// 壊れた値・別基準の時刻（performance.now() の生値など）が混ざったまま時刻計算に入ると、
// コマの対応付けが黙って狂うため入口で落とす。
export const MAX_EPOCH_MS = 4_102_444_800_000

type VideoRect = { left: number; top: number; width: number; height: number }

export type ExtensionMessage =
  // frameDurMs は素材のコマ間隔（ミリ秒）。ページ側が再生中ずっと実測している値で、
  // **録画開始前に素材の fps を知る唯一の経路**（コマ通知は録画中しか流れない）。
  // 測れていなければ null。旧版の拡張は送ってこないので、その場合も null になる。
  | { type: 'timecode'; currentTime: number | null; title: string; url: string | null; focused: boolean; requestId?: string; windowLeft: number; windowTop: number; windowWidth: number; windowHeight: number; innerWidth: number; innerHeight: number; devicePixelRatio: number; videoRect: VideoRect | null; fullscreen: boolean; frameDurMs: number | null; version?: string }
  | { type: 'ping' }
  // 録画中に配信ページ側から届く、素材の1コマぶんの通知。
  // mediaTime は素材自身のタイムライン上の秒、displayAt はそのコマが画面に出る epoch ミリ秒。
  // 画面キャプチャ側の時計とは無関係で、素材の実コマを知る唯一の経路。
  | { type: 'frame'; mediaTime: number; displayAt: number }
  // 録画中にコマ通知が途切れたことの知らせ（値は持たない）。配信ページ側の rVFC ループは
  // <video> が差し替わる（広告挿入・画質切替）と止まるため、その区間のコマは表に入らない。
  // **入らなかったコマは撮り逃しですらなく最初から存在しない**ので、枚数や割合には現れない。
  | { type: 'frame-gap' }

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
  if (msg.type === 'frame-gap') return { type: 'frame-gap' }
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
    // 未送信（旧拡張）・範囲外はここで null になる。**メッセージ全体は落とさない**——
    // これは補助情報で、無ければ従来どおりの固定ビットレートで録れればよい。
    frameDurMs: boundedNumber(msg.frameDurMs, MIN_SOURCE_FRAME_MS, MAX_SOURCE_FRAME_MS),
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

  // 候補を先頭から順に試す。EADDRINUSE は listen 後の非同期 error で来るので、
  // ハンドラ側から次の候補へ進める（同じ server オブジェクトに listen し直せる）。
  let portIndex = 0

  httpServer.on('listening', () => {
    activePort = WS_PORTS[portIndex]
    console.log(`[WS] listening on ws://${HOST}:${activePort}`)
  })

  httpServer.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      console.error('[WS] http server error', err)
      return
    }
    console.warn(`[WS] port ${WS_PORTS[portIndex]} unavailable, trying next`)
    portIndex++
    if (portIndex < WS_PORTS.length) {
      httpServer?.listen(WS_PORTS[portIndex], HOST)
      return
    }
    // 候補を使い切った。ここで初めて利用者に知らせる（1 つ塞がっただけで
    // 警告を出すと、自動で回避できた場合まで不安にさせる）。
    portIndex = WS_PORTS.length - 1
    notifyPortInUse()
  })

  httpServer.listen(WS_PORTS[portIndex], HOST)
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
  activePort = null
}

export function _resetWsStateForTest(opts?: { allowedIds?: string[] }): void {
  allowedExtensionIds = opts?.allowedIds ?? []
  portInUseDetected = false
  portInUseCallbacks.length = 0
}
