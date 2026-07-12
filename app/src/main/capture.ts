import { globalShortcut, nativeImage, screen as electronScreen, desktopCapturer, type Display, type NativeImage } from 'electron'
import screenshot from 'screenshot-desktop'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { ensureCaptureSubDir } from './paths'

export type CropRect = { x: number; y: number; w: number; h: number }

// 通知不要な中断（フォーカス中・多重実行・動画未検出など）を表す。
// registerHotkey の catch はこのクラスかどうかだけを見るため、
// 中断理由が増えてもコアはその文言を知らなくてよい。
export class SilentCaptureAbort extends Error {}

let currentHotkey = 'Alt+S'
let isCapturing = false

type DisplayList = Awaited<ReturnType<typeof screenshot.listDisplays>>
let cachedDisplays: DisplayList | null = null
let cachedDisplaysAt = 0
const DISPLAY_CACHE_TTL = 30_000

// モニタ抜き差し・DPI変更が起きると screenshot-desktop の display id / 座標が変わり、
// 30秒キャッシュが古い id を指したまま別モニタを撮る恐れがある。screen の変化イベントで
// 即キャッシュを破棄する。listen 登録は app ready 後（＝初回キャプチャ時）に一度だけ行う。
let displayInvalidationBound = false
function bindDisplayInvalidation(): void {
  if (displayInvalidationBound) return
  displayInvalidationBound = true
  const invalidate = (): void => { cachedDisplays = null }
  electronScreen.on('display-added', invalidate)
  electronScreen.on('display-removed', invalidate)
  electronScreen.on('display-metrics-changed', invalidate)
}

async function listDisplaysCached(): Promise<DisplayList> {
  bindDisplayInvalidation()
  if (cachedDisplays && Date.now() - cachedDisplaysAt < DISPLAY_CACHE_TTL) return cachedDisplays
  cachedDisplays = await screenshot.listDisplays()
  cachedDisplaysAt = Date.now()
  return cachedDisplays
}

// preCaptureHook が確定したキャプチャ時点のコンテキスト（タイムコード等）を
// onCaptureDone まで引き回すための型。capture.ts は中身に関知しない。
export type CaptureContext = unknown
type CaptureHandler = (imagePath: string, context: CaptureContext) => void | Promise<void>
type AsyncHook = () => Promise<CaptureContext>
type SyncHook = () => void

const handlers: CaptureHandler[] = []
let preCaptureHook: AsyncHook | null = null
let postCaptureHook: SyncHook | null = null
const FULLSCREEN_TOLERANCE_CSS_PX = 3

export function setPreCaptureHook(fn: AsyncHook): void {
  preCaptureHook = fn
}

export function setPostCaptureHook(fn: SyncHook): void {
  postCaptureHook = fn
}

// preCaptureHook 冒頭で実行するガード群。ガードは中断したいとき SilentCaptureAbort を
// throw する。動画機能などが「録画中はスクショ不可」等の条件を、コアにその文言を
// 知らせずに追加登録できるようにするための拡張点。
type PreCaptureGuard = () => void
const preCaptureGuards: PreCaptureGuard[] = []
export function addPreCaptureGuard(fn: PreCaptureGuard): void {
  preCaptureGuards.push(fn)
}
export function runPreCaptureGuards(): void {
  for (const guard of preCaptureGuards) guard()
}

// ブラウザ拡張から届いたタイムコードで browserWindow/videoRect を更新してよいかの抑止判定。
// いずれかの guard が true を返せば更新を抑止する（例: 録画中は対象を書き換えない）。
type UpdateSuppressGuard = () => boolean
const updateSuppressGuards: UpdateSuppressGuard[] = []
export function addBrowserTargetUpdateGuard(fn: UpdateSuppressGuard): void {
  updateSuppressGuards.push(fn)
}
export function shouldSuppressBrowserTargetUpdate(): boolean {
  return updateSuppressGuards.some((guard) => guard())
}

let browserWindow: {
  left: number; top: number; width: number; height: number
  innerWidth: number; innerHeight: number
} | null = null

let videoRect: { left: number; top: number; width: number; height: number } | null = null
let browserFullscreen = false

// 録画開始時のデスクトップソース解決など、動画機能がブラウザウィンドウ位置を
// 参照する必要があるケース向けの読み取り専用アクセサ。
export function getBrowserWindowRect(): typeof browserWindow {
  return browserWindow
}

export function setBrowserWindowPos(
  left: number, top: number, width: number, height: number,
  innerWidth: number, innerHeight: number
): void {
  browserWindow = { left, top, width, height, innerWidth, innerHeight }
}

export function setVideoRect(
  rect: { left: number; top: number; width: number; height: number } | null
): void {
  videoRect = rect
}

export function setBrowserFullscreen(fs: boolean): void {
  browserFullscreen = fs
}

export function canCaptureVideo(): boolean {
  return browserWindow !== null &&
    videoRect !== null &&
    videoRect.width > 10 &&
    videoRect.height > 10
}

// スクリーンショットと動画録画で共用するクロップ計算
// frameW/frameH はキャプチャされたフレームの実ピクセルサイズ
// display を渡すとそのboundsを使う（スクリーンショット側で確定済みの場合）。
// 省略時は getDisplayNearestPoint で自己解決する（録画側のIPC経由呼び出し用）。
export function computeVideoCrop(
  frameW: number,
  frameH: number,
  display?: ReturnType<typeof electronScreen.getDisplayNearestPoint>
): CropRect | null {
  if (!browserWindow || !videoRect) return null

  const { left: wl, top: wt, width: ww, height: wh, innerWidth, innerHeight } = browserWindow
  const { left: vl, top: vt, width: vw, height: vh } = videoRect

  const edisp = display ?? electronScreen.getDisplayNearestPoint({ x: Math.round(wl + ww / 2), y: Math.round(wt + wh / 2) })
  const screenshotDpr = frameW / edisp.bounds.width

  // 最大化時 Windows はウィンドウを画面外に約8px はみ出して配置し、window.screen* が
  // 負座標(例 -8)を返す。この phantom 枠は rawChromeX(=ww-innerWidth)には現れないため、
  // ウィンドウ原点をディスプレイ境界にクランプして相殺する。これを怠ると最大化で上/左に
  // ツールバーや枠が約8px 写り込む。ウィンドウ表示(原点が境界内)では no-op。
  const originX = browserFullscreen ? edisp.bounds.x : Math.max(wl, edisp.bounds.x)
  const originY = browserFullscreen ? edisp.bounds.y : Math.max(wt, edisp.bounds.y)

  const rawChromeX = ww - innerWidth
  // 非最大化ウィンドウの outerWidth/Height には DWM 不可視リサイズ枠（左右・下 各≈8px）が
  // 含まれる。最大化時はこの枠が画面外に出て消える(wl<bounds.x で判定)。
  // 縦タブ(Edge等)は横クロムが大きく全て左側だが、右の不可視枠も rawChromeX に混入するため
  // frameBorder ぶんを差し引く。通常ウィンドウは左右対称枠なので rawChromeX/2 が片側幅。
  const DWM_RESIZE_BORDER = 8
  const framePastEdge = wl < edisp.bounds.x || wt < edisp.bounds.y
  const isVerticalTabs = rawChromeX >= 40
  const frameBorder = framePastEdge ? 0
    : (isVerticalTabs ? DWM_RESIZE_BORDER : Math.max(0, Math.round(rawChromeX / 2)))
  const chromeX = isVerticalTabs ? rawChromeX - frameBorder : frameBorder
  const chromeH = wh - innerHeight - frameBorder
  const fillsViewport =
    vl <= FULLSCREEN_TOLERANCE_CSS_PX &&
    vt <= FULLSCREEN_TOLERANCE_CSS_PX &&
    vl + vw >= innerWidth - FULLSCREEN_TOLERANCE_CSS_PX &&
    vt + vh >= innerHeight - FULLSCREEN_TOLERANCE_CSS_PX
  // サブピクセルのズレ（≤3px）でビューポートをほぼ埋めているなら、丸め誤差を吸収してスナップ
  const adjVt = fillsViewport ? 0 : Math.max(0, vt)
  const adjVl = fillsViewport ? 0 : Math.max(0, vl)
  const adjVh = fillsViewport ? innerHeight : Math.max(1, Math.min(vt + vh, innerHeight) - adjVt)
  const adjVw = fillsViewport ? innerWidth : Math.max(1, Math.min(vl + vw, innerWidth) - adjVl)
  const isFullscreen = browserFullscreen || (fillsViewport && chromeH <= FULLSCREEN_TOLERANCE_CSS_PX)
  const effectiveChromeH = isFullscreen ? 0 : chromeH
  // CSS 1px を物理ピクセルに換算する。DPR=2 では 1px CSS ボーダー = 2 物理ピクセルなので
  // inset=1 だと1物理ピクセル分のボーダーが漏れる。ceil(dpr) でスケールして防ぐ
  // （125%等の半端なDPRでは round だと切り捨たり、安全マージンが0.8px分しかなくなり
  // クロムが1px映り込む。100%/150%/200%等の割り切れるDPRでは ceil でも round と同値）
  const insetPx = isFullscreen ? 0 : Math.max(1, Math.ceil(screenshotDpr))
  // 始点と終点を独立に Math.round すると cropXEnd - cropX が round(size*dpr) ±1 になる。
  // 始点 cropX と寸法 cropW を別々に丸め、終点はそこから導くことでサイズのズレを防ぐ。
  const effectiveChromeX = isFullscreen ? 0 : chromeX
  const cropX = Math.round((originX + effectiveChromeX + adjVl - edisp.bounds.x) * screenshotDpr)
  const cropY = Math.round((originY + effectiveChromeH + adjVt - edisp.bounds.y) * screenshotDpr)
  const cropW = Math.round(adjVw * screenshotDpr)
  const cropH = Math.round(adjVh * screenshotDpr)

  const x = Math.max(0, cropX + insetPx)
  const y = Math.max(0, cropY + insetPx)
  const w = Math.min(cropX + cropW - insetPx, frameW) - x
  const h = Math.min(cropY + cropH - insetPx, frameH) - y

  if (w <= 10 || h <= 10) return null
  return { x, y, w, h }
}

async function resolveDisplay(): Promise<{ id: number; left: number; top: number } | null> {
  if (!browserWindow) return null
  try {
    const displays = await listDisplaysCached()
    const cx = browserWindow.left + browserWindow.width / 2
    const cy = browserWindow.top + browserWindow.height / 2
    const match = displays.find((d) => {
      const dl = d.left ?? 0
      const dt = d.top ?? 0
      return cx >= dl && cx < dl + d.width && cy >= dt && cy < dt + d.height
    })
    return match ? { id: match.id, left: match.left ?? 0, top: match.top ?? 0 } : null
  } catch {
    return null
  }
}

export function onCaptureDone(handler: CaptureHandler): void {
  handlers.push(handler)
}

// screenshot-desktop は Windows では撮影のたびに外部プロセスを起動するため 600ms 前後かかり、
// 「ホットキーを押してからトーストが出るまで」の遅延の大半を占めていた（実測）。
// desktopCapturer はコンポジタから直接取得するのでプロセス起動が要らない。
//
// thumbnailSize には必ず物理解像度（DIP × scaleFactor）を渡す。computeVideoCrop は
// screenshotDpr = frameW / bounds.width で DPR を割り出す前提なので、ここを縮めると
// 画像が縮小保存されるうえクロップ位置もズレる。
async function captureDisplayImage(edisp: Display): Promise<NativeImage | null> {
  const width = Math.round(edisp.size.width * edisp.scaleFactor)
  const height = Math.round(edisp.size.height * edisp.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  // display_id は Windows でも Electron の Display.id と同じ空間の文字列が入る。
  // 取れない環境（空文字）では特定できないので null を返し、呼び出し側で従来経路に落とす。
  const source = sources.find((s) => s.display_id === String(edisp.id))
  if (!source || source.thumbnail.isEmpty()) return null
  return source.thumbnail
}

export async function writeCaptureFile(dir: string, data: Buffer, ext = '.png'): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const filepath = join(dir, `cap_${Date.now()}_${randomUUID()}${ext}`)
    try {
      await writeFile(filepath, data, { flag: 'wx' })
      return filepath
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('Failed to create a unique capture filename')
}

async function notifyCaptureDone(imagePath: string, context: CaptureContext): Promise<void> {
  const results = await Promise.allSettled(
    handlers.map((handler) => Promise.resolve().then(() => handler(imagePath, context)))
  )
  for (const result of results) {
    if (result.status === 'rejected') console.error('[capture] done handler failed', result.reason)
  }
}

export async function captureScreen(): Promise<string> {
  // ホットキー連打による並行実行を防ぐ。並行すると pendingTimecode・setOpacity・
  // pre/post-capture のグローバル状態が競合し、復元順や保存メタデータがズレる。
  if (isCapturing) throw new SilentCaptureAbort('Capture already in progress')
  isCapturing = true

  let context: CaptureContext = null
  // 早期復帰（screenshot 直後）と finally の保険で二重に呼ばれても、プレーヤーUI復帰は
  // 一度だけ送る。呼び出し側（bootstrap）の抑止に依存せず capture.ts 単体で exactly-once。
  let didPostCapture = false
  const runPostCapture = (): void => {
    if (didPostCapture) return
    didPostCapture = true
    postCaptureHook?.()
  }
  try {
    if (preCaptureHook) context = await preCaptureHook()

    if (!canCaptureVideo()) {
      throw new Error('No browser video target available')
    }

    // 撮影対象のディスプレイはブラウザウィンドウの中心点で解決する。computeVideoCrop にも
    // 同じ Display を渡し、撮影画像と bounds が必ず同一モニターを指すようにする。
    const { left: wl, top: wt, width: ww, height: wh } = browserWindow!
    const electronDisplay = electronScreen.getDisplayNearestPoint({ x: Math.round(wl + ww / 2), y: Math.round(wt + wh / 2) })

    let native = await captureDisplayImage(electronDisplay)
    if (!native) {
      // display_id が取れない環境向けのフォールバック（従来の screenshot-desktop 経路）。
      const display = await resolveDisplay()
      if (!display) throw new Error('No browser display target available')
      const img: Buffer = await screenshot({ screen: display.id, format: 'png' })
      native = nativeImage.createFromBuffer(img)
    }

    // スクショ取得時点でピクセルは確定済み。ここで即UIを復元し、ブラウザのプレーヤーUIが
    // 隠れている時間を、後続の保存パイプライン（クロップ・サムネ生成・DB挿入・色抽出）ぶん
    // 引きずらないようにする。finally でも呼ぶが runPostCapture が exactly-once を保証する。
    runPostCapture()

    if (browserWindow && videoRect) {
      const { width: ssW, height: ssH } = native.getSize()
      const crop = computeVideoCrop(ssW, ssH, electronDisplay)
      if (crop) {
        const cropped = native.crop({ x: crop.x, y: crop.y, width: crop.w, height: crop.h })
        // 有効なクロップが確定してから保存先サブフォルダを作る。前面/動画未検出/クロップ不正で
        // 中断したときに空の年月フォルダだけが残らないよう、pre-capture・各判定の後に置く。
        const dir = await ensureCaptureSubDir(Date.now())
        const filepath = await writeCaptureFile(dir, cropped.toPNG())
        await notifyCaptureDone(filepath, context)
        return filepath
      }
    }

    throw new Error('Browser video crop area is invalid')
  } finally {
    runPostCapture()
    isCapturing = false
  }
}

export function registerHotkey(hotkey: string, onError?: (message: string) => void): boolean {
  const ok = globalShortcut.register(hotkey, () => {
    captureScreen().catch((err) => {
      // 通知不要な中断（連打による再入・Shioriフォーカス中・機能側ガードでの中断等）は無視。
      // preCaptureHook が既に具体的な警告（動画未検出）を送信済みのケースもここに含まれる。
      if (err instanceof SilentCaptureAbort) return
      console.error('[capture] failed', err)
      onError?.('キャプチャに失敗しました。もう一度お試しください。')
    })
  })
  if (!ok) {
    console.warn(`[capture] hotkey ${hotkey} registration failed`)
    onError?.(`ホットキー ${hotkey} を登録できませんでした。他のアプリで使われている可能性があります。`)
  } else {
    currentHotkey = hotkey
    console.log(`[capture] hotkey registered: ${hotkey}`)
  }
  return ok
}

export function unregisterHotkey(): void {
  globalShortcut.unregister(currentHotkey)
}

export function changeHotkey(newHotkey: string, onError?: (message: string) => void): boolean {
  const previousHotkey = currentHotkey
  unregisterHotkey()
  const ok = registerHotkey(newHotkey, onError)
  // 巻き戻し（旧キー再登録）が失敗した場合も、呼び出し元の onError で気付けるようにする。
  // onError を渡さないと registerHotkey は console.warn のみでホットキーが完全に失われても
  // 呼び出し元・ユーザーのどちらにも伝わらない。
  if (!ok) registerHotkey(previousHotkey, onError)
  return ok
}
