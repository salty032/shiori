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
  const TRAY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABu0lEQVR4nGNgoDX4yskpA6L/MzCwvmFg4EOXZ8Kl8T8DA2N9fT3THxYWzg8MDIK/WFnVhUmx+T8DAyOU5vzPw2P7X0iID1kcv+b//xlBOCEtzGiNk2XAfgYGG6hmnC5GASDNIO+dOLz4+tdL6//fPL7szpT+ijyQ7atWrWJGVsuEqpWBITQ0lJmRkfF/ZmqgsbayrBqXstxvNQt9ZVYmpi+MDAz/RUWv4vfC///7WUD0llV9k///u/L///dzf+9fWveOgYFBkJERrJcRnwsYGRgc/goJCfFpqsqFM/z6/Y+Bg43p4aMXexkYGN7/+/cP5Pz/yBpYkDn799eDnP9nal9plJKWsijDr9+//v76zXbk5MVlIPmGhga8zmf8//8/yEVsV44tufP/98V//39e+Hfj9IonDAwMXExMYMdiGMCEZvu/ZXOa07VNdJQZvn7/wcDKzHjp8nWQ7d/+/t3Lgu58dNsZpaR4hXdvmHzr368L////v/7/5a0Nv3zcjDVACkCpEp/zwUBSUpLLyUJfur85P/za+bUPd6xqPg4Sh3qNZCDs7miqDYq5//+JSL7I3qmvr2dhgMQ5QQAADPGm6cwFbecAAAAASUVORK5CYII='
  const trayIcon = nativeImage.createFromDataURL(TRAY_PNG)
  tray = new Tray(trayIcon)
  tray.setToolTip('Shiori')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => showMainWindow())
}
