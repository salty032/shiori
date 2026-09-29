// プロセス終了の入口を集約する。通常終了と更新適用のどちらでも、実行中の処理を同じ基準で
// 確認し、設定の書き込みを待ってから終了する。
import { app, dialog, globalShortcut } from 'electron'
import { activeTaskLabels } from './busy'
import { flushSettings } from './settings'
import { getMainWindow, setQuitting } from './windows'
import { stopWsServer } from '../browser/ws-server'
import { cleanupDragTempDir } from '../ipc/ipc-drag'
import { isRecordingInProgress } from '../video/recording'
import { t } from './i18n'

export interface ShutdownGuard {
  // 更新適用は NSIS を起動してから app.quit() を呼ぶため、通常終了より先に確認する。
  // 実行したら true、利用者がキャンセルしたら false。
  runUpdate(action: () => Promise<void>): Promise<boolean>
}

function activeWorkLabels(): string[] {
  const labels = activeTaskLabels()
  if (isRecordingInProgress()) labels.unshift(t('busy.recording'))
  return labels
}

async function confirmExitWhileBusy(kind: 'update' | 'quit'): Promise<boolean> {
  const labels = activeWorkLabels()
  if (labels.length === 0) return true

  const title = kind === 'update' ? t('dialog.updateBusy.title') : t('dialog.quitBusy.title')
  const detail = kind === 'update' ? t('dialog.updateBusy.detail') : t('dialog.quitBusy.detail')
  const proceed = kind === 'update' ? t('dialog.updateBusy.proceed') : t('dialog.quitBusy.proceed')
  const options = {
    type: 'warning' as const,
    buttons: [proceed, t('dialog.updateBusy.cancel')],
    defaultId: 1,
    cancelId: 1,
    title,
    message: t('dialog.updateBusy.message', { tasks: labels.join(t('list.separator')) }),
    detail
  }
  const win = getMainWindow()
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

export function registerShutdownGuard(): ShutdownGuard {
  let teardownDone = false
  let quitConfirmationPending = false
  let quitWhileBusyConfirmed = false

  app.on('before-quit', (event) => {
    // preventDefault → flush → app.quit() で再入するため、後片付けは初回だけ。
    if (teardownDone) return
    event.preventDefault()
    if (quitConfirmationPending) return
    quitConfirmationPending = true

    void (async () => {
      if (!quitWhileBusyConfirmed && !(await confirmExitWhileBusy('quit'))) {
        quitConfirmationPending = false
        setQuitting(false)
        return
      }
      quitWhileBusyConfirmed = true
      setQuitting(true)
      globalShortcut.unregisterAll()
      stopWsServer()
      // ドラッグ用の複製は次回ドラッグ時にも作り直されるが、終了時に残すと temp が
      // 溜まり続けるため掃除する（失敗しても致命的ではない）。
      cleanupDragTempDir()

      // saveSettings は永続化を待たずに返るので、キューが残ったまま終了すると最後の
      // 設定変更が巻き戻る。before-quit は非同期を待ってくれないため、一度 quit を
      // 止めてフラッシュしてから quit し直す。
      await flushSettings()
      teardownDone = true
      app.quit()
    })().catch((err) => {
      // ダイアログや後片付けが想定外に失敗しても、確認待ちが永久に固着しないよう戻す。
      console.error('[shutdown] failed to prepare for quit', err)
      quitConfirmationPending = false
      quitWhileBusyConfirmed = false
      setQuitting(false)
    })
  })

  return {
    async runUpdate(action): Promise<boolean> {
      if (!(await confirmExitWhileBusy('update'))) return false
      // action が起こす before-quit で同じ確認を重ねない。
      quitWhileBusyConfirmed = true
      try {
        await action()
        return true
      } catch (err) {
        // 適用開始前に失敗してアプリが残った場合、次の通常終了まで確認済みにしない。
        quitWhileBusyConfirmed = false
        setQuitting(false)
        throw err
      }
    }
  }
}
