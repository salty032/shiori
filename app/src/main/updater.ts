import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { CH } from '../shared/api'
import { setQuitting } from './windows'
import { flushSettings } from './settings'

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  // 未署名でも NSIS の差分更新（blockmap）でバックグラウンドDLは成立する。
  // ダウンロード完了後にバナーで案内し、ユーザー操作（quitAndInstallUpdate）で適用する。
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  let lastNotifiedVersion: string | null = null

  autoUpdater.on('update-downloaded', (info) => {
    if (info.version === lastNotifiedVersion) return
    lastNotifiedVersion = info.version
    getWindow()?.webContents.send(CH.updaterDownloaded, info.version)
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message)
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.warn('[updater] checkForUpdates failed:', err.message)
    })
  }

  // CODE-REVIEW-v1.0.4 B-4: トレイ常駐で何週間も起動しっぱなしのユーザーがいるため、
  // 起動時に加えて 24h ごとにも確認する（lastNotifiedVersion ガードで多重通知はしない）。
  check()
  setInterval(check, 24 * 60 * 60 * 1000)
}

// トレイ常駐のため、close イベントが quitAndInstall の再起動を隠さないよう
// isQuitting を先に立ててから適用する（windows.ts の close ハンドラ参照）。
export async function quitAndInstallUpdate(): Promise<void> {
  setQuitting(true)
  // before-quit でもフラッシュしているが、quitAndInstall は先に NSIS インストーラを
  // 起動してから app.quit() する。インストーラを走らせる前に設定を書き終えておく方が
  // 待ち合わせの都合が良いので、ここでも待つ（済んでいれば即 resolve）。
  await flushSettings()
  autoUpdater.quitAndInstall()
}
