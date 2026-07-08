import { app, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { sendToRenderer, showMainWindow } from './windows'
import { CH } from '../shared/api'

let tray: Tray | null = null

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '開く', click: () => showMainWindow() },
    {
      label: '設定',
      click: () => {
        showMainWindow()
        sendToRenderer(CH.openSettings)
      }
    },
    { label: '終了', click: () => app.quit() }
  ])
}

export function createTray(): void {
  // 16px 単一の埋め込み PNG だと HiDPI（150%/200%スケーリング）でぼやける。ウィンドウの
  // タイトルバーアイコンと同じ build/icon.ico（16/24/32/48/64/128/256 の複数解像度入り）を
  // 読み込むことで、OS が表示スケールに応じた解像度を自動選択できるようにする。
  const trayIcon = nativeImage.createFromPath(join(__dirname, '../../build/icon.ico'))
  tray = new Tray(trayIcon)
  tray.setToolTip('Shiori')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => showMainWindow())
}
