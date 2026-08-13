// メインウィンドウの生成・参照を集約し、renderer への送信と
// 送信元の信頼性検証（IPC のなりすまし対策）を提供する。他モジュールはウィンドウ参照を
// 直接持たず、アクセサ（getMainWindow / sendToRenderer / handleTrusted 等）経由で扱う。
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { CH } from '../../shared/api'

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

// メインウィンドウを前面に出す（show + focus）。破棄済み・未生成時は何もしない。
export function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 自動起動時は skipTaskbar 付きで生成しているため、初回表示でタスクバーへ戻す
    mainWindow.setSkipTaskbar(false)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
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

export function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
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
export function createWindow(onFocus: () => void, startHidden = false): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 480,
    show: !startHidden,
    skipTaskbar: startHidden,
    title: 'Shiori',
    icon: join(__dirname, '../../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  mainWindow.setIcon(join(__dirname, '../../../build/icon.ico'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) shell.openExternal(safeUrl).catch((err) => console.error('[shell] openExternal failed', err))
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // 起動時に競合で取れなかったホットキーを、ウィンドウ復帰時に取り直す
  mainWindow.on('focus', onFocus)

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

