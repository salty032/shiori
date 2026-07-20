import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'path'
import { readdirSync, rmSync } from 'fs'
import { CH } from '../shared/api'
import { setQuitting } from './windows'
import { flushSettings } from './settings'
import { compareVersions } from './version'

// electron-updater は DL したインストーラを %LOCALAPPDATA%\<appName>-updater\pending に置くが、
// 適用後に自分で消してはくれない。100MB 級の .exe が居座り続けるので起動時に掃除する。
//
// 判定はバージョン比較で行う。アプリが新バージョンで起動できている＝インストールは成功して
// いるので、現バージョン以下のインストーラはもう使い道がない。逆にインストールに失敗して
// 旧版のまま起動した場合、pending の新しいインストーラは electron-updater が再利用できる
// ため残す（消すと 100MB を再ダウンロードさせることになる）。
//
// 中断された DL の "temp-" 付きファイルも同じ規則で拾う。
const PENDING_FILE = /^(?:temp-)?(.+)-Setup-(.+?)\.exe(?:\.blockmap)?$/i
// 純粋な数値バージョンだけを対象にする。compareVersions は "1.1.4-beta" を 1.1.0 と読んで
// しまうため、想定外の命名を巻き込んで消さないよう読めないものは残す方に倒す。
const NUMERIC_VERSION = /^\d+(?:\.\d+)*$/

export function stalePendingFiles(names: string[], appName: string, currentVersion: string): string[] {
  return names.filter((name) => {
    const m = PENDING_FILE.exec(name)
    if (!m || m[1].toLowerCase() !== appName.toLowerCase()) return false
    if (!NUMERIC_VERSION.test(m[2])) return false
    return compareVersions(m[2], currentVersion) <= 0
  })
}

// キャッシュのルート直下に残る旧 electron-updater 世代の置き土産。今の 6.x は DL 先も
// temp も pending/ 配下に置く（AppUpdater: cacheDir = cacheDirForPendingUpdate）ため、
// ルートの installer.exe を読むコードはもう存在しない。実機では pending の本体と
// 同サイズ・同時刻の 116MB が丸ごと重複して残っていた。
//
// current.blockmap は別。差分ダウンロードのために現行版のブロックマップとして
// 今も書かれ・読まれる（AppUpdater の saveBlockMapToCacheDir / getBlockMapFromCacheDir）。
// 消すと次回の更新が差分にならずフルダウンロードになるので、対象から外す。
const LEGACY_ROOT_FILES = new Set(['installer.exe', 'temp-installer.exe'])

export function staleRootFiles(names: string[]): string[] {
  return names.filter((name) => LEGACY_ROOT_FILES.has(name.toLowerCase()))
}

function cleanPendingCache(): void {
  // 掃除はあくまで best-effort。ここでの失敗が更新チェック本体を巻き込まないよう握り潰す。
  try {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) return
    const appName = app.getName()
    const root = join(localAppData, `${appName}-updater`)

    const remove = (dir: string, names: string[]): void => {
      for (const name of names) rmSync(join(dir, name), { force: true })
    }
    const list = (dir: string): string[] | null => {
      try {
        return readdirSync(dir)
      } catch {
        return null  // ディレクトリが無い（未更新の環境）のは正常
      }
    }

    const rootNames = list(root)
    if (rootNames == null) return
    remove(root, staleRootFiles(rootNames))

    const pending = join(root, 'pending')
    const pendingNames = list(pending)
    if (pendingNames == null) return
    remove(pending, stalePendingFiles(pendingNames, appName, app.getVersion()))
  } catch (err) {
    console.warn('[updater] pending cache cleanup failed', err)
  }
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  // 新規 DL と競合させないため checkForUpdates より前に済ませる。
  cleanPendingCache()

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
  // 引数は省略できない。quitAndInstall(isSilent = false, isForceRunAfter = false) なので、
  // 素で呼ぶと isSilent=false のまま NSIS に /S が渡らず、oneClick:false の本アプリでは
  // インストール先を尋ねるウィザードが前面に出る（バックグラウンド適用に見えない）。
  // 第2引数も必須で、isSilent=true のとき isForceRunAfter がそのまま使われるため
  // （BaseUpdater: install(isSilent, isSilent ? isForceRunAfter : autoRunAppAfterInstall)）、
  // 省くと --force-run が付かず更新後にアプリが起動しないまま終わる。
  autoUpdater.quitAndInstall(true, true)
}
