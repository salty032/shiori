import { app, Tray, Menu, nativeImage } from 'electron'
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
  const TRAY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB/klEQVR4nGNgwAP+MzAwXhAX58anhgmbYD1U/IasrCQHJ+eVcyoqoteVlHSvyst3gAwlaEAjA8M/kCGHxMRe//7/n4n1z5/+///+HWdgZFSFugyrPhQAs+mNovL0/2pq/x8qKs7EppkRVRtc7L+euLjY819flxuwsqn4srKLnvz53f3Xmw/HtBgY/oNciM8AFgYGhr8i/FxJYoJ8c2R//Ga4+vvXv3/MTAws/xhMH735eI6BgYEZpAakmAmLAf+YmJj+f/n0LcrG3vTvjprCX+Xejkyfv//6qCoi+RCmhgEHYAIRehpSavwcLL92rOr59///89+Rwc7/OBkYVjIygR0Msh0nYAER/OzM7Rb6Kv//fD7z+9m1jX8UxAX+S/BzhiCrQbERCkDG/42O9uD79ftvUnCAy39mHknG9ZsPML98/eGNs4/9Lqg6sN+xARYQIczDVq4iI/L/1b3tv///vPTbw87wPzcL4yxGRkYM25EBI4jw8DDj42FhfD6jp+TP//9P/h7bMeOvKC/HfxVpMQuoOgz/s0BpkFf+Xj13cwo/H7fEi5dvGD6+ff5r7Ya9rJ8+/zjz6tP3k4yMjGA1eF0gLcxTLi/Kv4SLieGpsab8fy1Fyf+ifJzZaJYRBvb2xiIivBxTJQW572pI8QojW0IIgPwIt0lPD39WBqkBAFMwq74EvPrSAAAAAElFTkSuQmCC'
  const trayIcon = nativeImage.createFromDataURL(TRAY_PNG)
  tray = new Tray(trayIcon)
  tray.setToolTip('栞')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => showMainWindow())
}
