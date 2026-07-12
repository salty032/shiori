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

// トレイ用アイコンを、サイズごとに描き分けた PNG（build/icon16・icon32・icon48）から組み立てる。
// icon.ico を nativeImage.createFromPath() で読むと最大サイズ（256x256）の 1 枚しか取り出せず、
// それを 16px 枠へ潰し込むことになって絵が崩れる。小サイズ用に線の太さを調整した専用 PNG を
// スケールごとに持たせ、表示スケール（100%/150%/200%）に応じた解像度を OS に選ばせる。
// トレイの論理サイズは 16。各 representation のピクセル数は 16 * scaleFactor になる必要があるため、
// 1x=16px / 1.5x=24px（48px を縮小）/ 2x=32px を渡す。
function buildTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createEmpty()
  for (const [scaleFactor, file, px] of [[1, 'icon16.png', 16], [1.5, 'icon48.png', 24], [2, 'icon32.png', 32]] as const) {
    const rep = nativeImage.createFromPath(join(__dirname, '../../build', file))
    if (rep.isEmpty()) continue
    const sized = rep.getSize().width === px ? rep : rep.resize({ width: px, height: px, quality: 'best' })
    icon.addRepresentation({ scaleFactor, buffer: sized.toPNG() })
  }
  return icon
}

export function createTray(): void {
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('Shiori')
  tray.setContextMenu(buildTrayMenu())
  // Windows では左クリック（シングル）でウィンドウを開けるようにする。右クリックは
  // setContextMenu が握るのでメニュー表示のまま、左クリックだけこちらで拾う。
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}
