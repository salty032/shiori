import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { CH } from '../shared/api'

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  // 未署名インストーラ配布中は自動DL無効。バージョン通知のみ行い、手動でリリースページへ誘導する
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  let lastNotifiedVersion: string | null = null

  autoUpdater.on('update-available', (info) => {
    if (info.version === lastNotifiedVersion) return
    lastNotifiedVersion = info.version
    getWindow()?.webContents.send(CH.updaterAvailable, info.version)
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message)
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.warn('[updater] checkForUpdates failed:', err.message)
    })
  }

  check()
  setInterval(check, 4 * 60 * 60 * 1000)
}
