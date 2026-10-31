// メインウィンドウの生成・参照を集約し、renderer への送信と
// 送信元の信頼性検証（IPC のなりすまし対策）を提供する。他モジュールはウィンドウ参照を
// 直接持たず、アクセサ（getMainWindow / sendToRenderer / handleTrusted 等）経由で扱う。
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { CH } from '../../shared/api'
import { loadSettings } from './settings'
import { hasActiveTasks } from './busy'

let mainWindow: BrowserWindow | null = null
let trustedRendererUrl: string | null = null
let isQuitting = false

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setQuitting(value: boolean): void {
  isQuitting = value
}

// renderer（メインウィンドウ）への送信。未生成・破棄済みのときは無視する。
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

export function sendNotice(level: 'info' | 'warning' | 'error', message: string): void {
  sendToRenderer(CH.appNotice, { level, message })
}

// 画面の読み込みが済んでから実行する。**ウィンドウがまだ無いとき（閉じたらメモリを空ける設定で
// 破棄した後・起動時に作らなかったとき）も捨てない**——次に作った画面の読み込み後に実行する。
// 捨てると、起動時の通知（設定が壊れていた・DB を復元した等）が二度と出ない。
const pendingUntilReady: Array<() => void> = []

export function whenRendererReady(fn: () => void): void {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (!wc) { pendingUntilReady.push(fn); return }
  if (wc.isLoading()) wc.once('did-finish-load', fn)
  else fn()
}

// フォーカス復帰時に呼ぶもの（ホットキーの取り直し）。ウィンドウは作り直されることがあるので、
// ウィンドウではなくここに持ち、作るたびに張る。
const focusListeners: Array<() => void> = []

export function onMainWindowFocus(fn: () => void): void {
  focusListeners.push(fn)
}

// メインウィンドウを前面に出す（show + focus）。閉じたらメモリを空ける設定で破棄されていれば作り直す。
export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    buildWindow(true)
    return
  }
  // 自動起動時は skipTaskbar 付きで生成しているため、初回表示でタスクバーへ戻す
  mainWindow.setSkipTaskbar(false)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

export function isMainWindowFocused(): boolean {
  return mainWindow?.isFocused() ?? false
}

// dev サーバー URL の許可判定。他のウィンドウでも同じ判定基準を使いたいので export する。
export function isAllowedDevRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function isTrustedRendererUrl(value: string): boolean {
  if (trustedRendererUrl && value === trustedRendererUrl) return true
  return !app.isPackaged && isAllowedDevRendererUrl(value)
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender.id === mainWindow.webContents.id &&
    (event.senderFrame != null && isTrustedRendererUrl(event.senderFrame.url))
}

export function handleTrusted<T extends unknown[]>(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown
): void {
  ipcMain.handle(channel, (event, ...args: T) => {
    if (!isTrustedSender(event)) throw new Error(`Rejected IPC from untrusted sender: ${channel}`)
    return listener(event, ...args)
  })
}

// handleTrusted の ipcMain.on 版（送りっぱなし・戻り値なし）。invoke は Promise を挟むため
// webContents.startDrag をドラッグ開始として成立させられない（ipc-drag.ts のコメント参照）。
// 現状 startDrag 専用。応答が要る IPC は handleTrusted を使うこと。
export function onTrusted<T extends unknown[]>(
  channel: string,
  listener: (event: Electron.IpcMainEvent, ...args: T) => void
): void {
  ipcMain.on(channel, (event, ...args: T) => {
    if (!isTrustedSender(event)) {
      console.warn(`[ipc] rejected from untrusted sender: ${channel}`)
      return
    }
    listener(event, ...args)
  })
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return null
  }
}

// メインウィンドウを生成する。onFocus はフォーカス復帰時に呼ばれる（ホットキー再取得用）。
// startHidden の場合はウィンドウを出さずトレイ常駐で待機する（OS 自動起動時）。
// **閉じたらメモリを空ける設定なら、裏で起動したときは作りもしない**——作ると、開かれるまで
// 一覧の画面がまるごと常駐する。トレイから開いたときに作る（showMainWindow）。
export function createWindow(onFocus: () => void, startHidden = false): void {
  onMainWindowFocus(onFocus)
  if (startHidden && loadSettings().lowMemoryMode) return
  buildWindow(!startHidden)
}

function buildWindow(show: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 480,
    show,
    skipTaskbar: !show,
    title: 'Shiori',
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  mainWindow.setIcon(join(__dirname, '../../build/icon.ico'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) shell.openExternal(safeUrl).catch((err) => console.error('[shell] openExternal failed', err))
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  // 閉じても終了しない（トレイに常駐する）。普段は隠すだけで、閉じたらメモリを空ける設定のときは
  // 破棄して画面のプロセスごと手放す。**書き出し・取り込みなどの処理中は隠すだけにする**——
  // 進み具合と結果の表示は画面にしか届かないので、破棄すると終わったかどうか分からなくなる。
  const win = mainWindow
  win.on('close', (e) => {
    if (isQuitting) return
    if (loadSettings().lowMemoryMode && !hasActiveTasks()) return
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 起動時に競合で取れなかったホットキーを、ウィンドウ復帰時に取り直す
  win.on('focus', () => focusListeners.forEach((fn) => fn()))

  // 作る前に預かった「読み込み後に実行するもの」を流す。
  win.webContents.once('did-finish-load', () => {
    pendingUntilReady.splice(0).forEach((fn) => fn())
  })

  // レンダラーの HTML ファイル名
  const htmlName = 'index.html'

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl && isAllowedDevRendererUrl(rendererUrl)) {
    const devUrl = `${rendererUrl}/${htmlName}`
    trustedRendererUrl = devUrl
    mainWindow.loadURL(devUrl)
  } else {
    const rendererFile = join(__dirname, `../renderer/${htmlName}`)
    trustedRendererUrl = pathToFileURL(rendererFile).toString()
    mainWindow.loadFile(rendererFile)
  }
}

