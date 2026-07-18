// レコーダーウィンドウ（画面録画専用の隠しウィンドウ）の生成・参照・送信元検証。
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { isAllowedDevRendererUrl } from '../windows'

let recorderWindow: BrowserWindow | null = null
let trustedRecorderUrl: string | null = null

export function getRecorderWindow(): BrowserWindow | null {
  return recorderWindow
}

export function isTrustedRecorderSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
): boolean {
  return recorderWindow !== null &&
    !recorderWindow.isDestroyed() &&
    event.sender.id === recorderWindow.webContents.id &&
    trustedRecorderUrl !== null &&
    event.senderFrame != null &&
    event.senderFrame.url === trustedRecorderUrl
}

export function createRecorderWindow(onInterrupted?: () => void): void {
  const preloadPath = join(__dirname, '../preload/recorder.js')
  // show:false の隠し window ではコンポジターが止まり requestVideoFrameCallback が
  // スロットリングされる。1x1px の可視ウィンドウにすることでスロットリングを回避する。
  recorderWindow = new BrowserWindow({
    show: true,
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    }
  })
  // ウィンドウが破棄されると recorder:done/error が届かず録画状態が固着する
  // （render-process-gone と同じ症状）。frameless・focusable:false でユーザーが
  // 閉じる経路はほぼないが、対称化のため closed でも録画状態をリセットする。
  // finishRecordingState は冪等なので、正常系での多重発火も no-op になる。
  recorderWindow.on('closed', () => {
    recorderWindow = null
    onInterrupted?.()
  })

  // レコーダーは外部 URL を開く正当な理由がないため、全て deny（外部ブラウザへの委譲もしない）
  recorderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  recorderWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedRecorderUrl) event.preventDefault()
  })

  // レコーダープロセスがクラッシュすると recorder:done/error が届かず、録画状態が
  // true で固着する（トレイ録画表示のまま・ホットキーが停止しか効かない）。
  // クラッシュを検知して録画状態を強制リセットする。
  recorderWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[recorder] render process gone', details.reason)
    onInterrupted?.()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl && isAllowedDevRendererUrl(devUrl)) {
    trustedRecorderUrl = `${devUrl}/recorder.html`
    recorderWindow.loadURL(trustedRecorderUrl)
  } else {
    const recorderFile = join(__dirname, '../renderer/recorder.html')
    trustedRecorderUrl = pathToFileURL(recorderFile).toString()
    recorderWindow.loadFile(recorderFile)
  }
}
