import { app, dialog } from 'electron'
import { statSync } from 'fs'
import { initDb, databasePath } from '../db'
import {
  isDatabaseDamaged, listBackups, restoreDatabase, setAsideBrokenDatabase, writeRestoreMarker
} from './db-maintenance'
import { describeStartupError } from './startup-error'
import { t, currentLang } from './i18n'
import { LOCALE_TAG } from '../../shared/i18n'

// 起動時に DB を開くところだけを持つ。**開けなかったときに何を出すか**が本題で、
// 退避ファイルの操作そのものは db-maintenance.ts 側にある。

/** 退避ファイルの日時表示。読めなければパスをそのまま見せる（何も言わないよりは手掛かりになる）。 */
export function backupDateLabel(path: string): string {
  try {
    return statSync(path).mtime.toLocaleString(LOCALE_TAG[currentLang()])
  } catch {
    return path
  }
}

/**
 * DB を開く。開けなかったときは復元の導線を出す。**起動を続けてよければ true。**
 *
 * タグ・メモ・タイムシートの打鍵はこの 1 ファイルにしか無く、撮り直しが効かない。
 * 黙って作り直すと「起動はしたが中身が空」になり、失ったことにも気づけない。
 */
export function openDatabaseOrRecover(): boolean {
  try {
    initDb()
    return true
  } catch (err) {
    return recoverDatabase(err)
  }
}

/** DB を開けなかったときの導線。起動を続けられるなら true。 */
function recoverDatabase(err: unknown): boolean {
  console.error('[startup] initDb failed', err)
  // ロック中・権限不足（ウイルス対策やバックアップソフト）を復元に巻き込まない。
  // 破損だと SQLite 自身が言っている場合だけ、現在のファイルを動かす提案をする。
  if (!isDatabaseDamaged(err)) {
    dialog.showErrorBox('Shiori', t('error.dbOpen'))
    return false
  }
  const dbPath = databasePath()
  const backups = listBackups(dbPath)
  if (backups.length === 0) {
    dialog.showErrorBox('Shiori', t('error.dbCorruptNoBackup', { path: dbPath }))
    return false
  }
  const newest = backups[0]
  const label = backupDateLabel(newest)
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: t('dialog.dbRestore.title'),
    message: t('dialog.dbRestore.message'),
    detail: t('dialog.dbRestore.detail', { date: label }),
    buttons: [t('dialog.dbRestore.restore'), t('dialog.dbRestore.quit')],
    defaultId: 0,
    cancelId: 1
  })
  if (choice !== 0) return false
  try {
    // 壊れたファイルは消さずに退避フォルダへ移す。後から取り出せる可能性を捨てない。
    const broken = setAsideBrokenDatabase(dbPath, new Date())
    restoreDatabase(newest, dbPath)
    writeRestoreMarker(dbPath, newest)
    console.warn(`[startup] restored the database from ${newest} (broken file kept at ${broken})`)
  } catch (restoreErr) {
    console.error('[startup] database restore failed', restoreErr)
    dialog.showErrorBox('Shiori', t('error.dbRestoreFailed', { detail: describeStartupError(restoreErr) }))
    return false
  }
  // 戻した DB でそのまま起動を続けず、必ず起動し直す。
  //
  // ここへ来るまでにメインプロセスはダイアログの前で数十秒〜数分止まっている。その間に
  // Chromium のネットワークサービスが落ちて再起動することがあり（実際に踏んだ:
  // 'Network service crashed or was terminated'）、直後に作ったウィンドウが読み込みに
  // 失敗して**真っ白のまま**残った。復元できたのに何も映らないのでは、直したことにならない。
  // 戻した DB は普通の起動で開き直すのが素直で、半端な状態のプロセスを使い回す理由も無い。
  //
  // exit(0) なのは、この時点でまだ設定を変えておらず、before-quit の後片付けに用が無いため。
  app.relaunch()
  app.exit(0)
  return false
}
