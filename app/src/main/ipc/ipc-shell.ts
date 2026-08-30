// OS 側を開く操作（URL・エクスプローラー）と、設定画面に出す接続ポート・使用容量。
// bootstrap.ts から切り出した。
//
// **外へ渡す前に必ず絞る。** URL は safeExternalUrl、パスは DB に載っている画像の
// 実体だけ（resolveRealCapturePath）。ここを緩めると、renderer から任意の場所を
// 開かせられる経路になる。
import { BrowserWindow, dialog, shell } from 'electron'
import { mkdir, stat, unlink, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { CH } from '../../shared/api'
import { handleTrusted, safeExternalUrl } from '../system/windows'
import { optionalPositiveInteger } from './ipc-validation'
import { getImage, countImages, listImagePaths, setImagePaths } from '../db'
import { resolveRealCapturePath, captureDir, defaultCaptureDir, captureRootProblem } from '../system/paths'
import { installedExtensionPath } from '../browser/extension-updater'
import { getActivePort } from '../browser/ws-server'
import { collectStorageUsage } from '../system/storage'
import { planCaptureMove, moveCaptureFiles } from '../system/move-captures'
import { beginTask, endTask } from '../system/busy'
import { sendToRenderer } from '../system/windows'
import { loadSettings, saveSettings } from '../system/settings'
import { t } from '../system/i18n'
import type { ChooseCaptureRootResult } from '../../shared/types'

// 移動の中止フラグ。**押した瞬間に立てて、次の 1 件の前に見る**——今コピー中の 1 件は
// 最後まで書き切る（途中まで書いたファイルを残さないため）。
let moveCanceled = false

async function totalBytes(paths: readonly string[]): Promise<number> {
  let total = 0
  for (const path of paths) {
    try {
      total += (await stat(path)).size
    } catch {
      /* 既に無いファイルは 0 として数える */
    }
  }
  return total
}

// 進み具合の送信を間引く。数万件で 1 件ごとに送ると、描画のほうが移動より遅くなる。
function shouldSendProgress(current: number, total: number): boolean {
  return current === 1 || current === total || current % Math.max(1, Math.floor(total / 100)) === 0
}

async function confirmMove(
  parent: BrowserWindow | null,
  count: number,
  bytes: number,
  dest: string
): Promise<boolean> {
  const options = {
    type: 'question' as const,
    buttons: [t('dialog.moveCaptures.proceed'), t('action.cancel')],
    defaultId: 0,
    cancelId: 1,
    title: t('dialog.moveCaptures.title'),
    message: t('dialog.moveCaptures.message', { count: String(count), size: formatBytes(bytes), dest }),
    detail: t('dialog.moveCaptures.detail'),
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

// 確認ダイアログに出す容量。renderer の formatBytes と同じ刻みにする（同じ数字を
// 2 か所で違う丸め方にすると、設定画面の使用量と食い違って見える）。
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function registerShellHandlers(): void {
  handleTrusted(CH.shellOpenUrl, (_event, url: string) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) return shell.openExternal(safeUrl)
  })
  handleTrusted(CH.shellShowInFolder, async (_event, id: number) => {
    const imageId = optionalPositiveInteger(id)
    if (!imageId) return
    const image = getImage(imageId)
    if (!image) return
    const safePath = await resolveRealCapturePath(image.filepath)
    if (safePath) shell.showItemInFolder(safePath)
  })
  handleTrusted(CH.shellShowExtensionFolder, () => {
    shell.showItemInFolder(join(installedExtensionPath(), 'manifest.json'))
  })

  // 保存先の変更。**選ばせる前でも後でもなく、書けるかどうかをここで確かめる。**
  // 抜いてある外付けドライブや書き込めない場所を保存先にすると、撮った瞬間に失敗する。
  // その場では「保存に失敗しました」としか出ず、原因が保存先だと分からない。
  //
  // **これまでのぶんは移さない。** 元の場所を previousCaptureRoots に控えて、
  // そのまま開けるようにする（paths.ts の captureBases）。移動は別の作業。
  handleTrusted(CH.storageChooseRoot, async (): Promise<ChooseCaptureRootResult> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const options = {
      title: t('settings.chooseCapturesFolder'),
      defaultPath: captureDir(),
      properties: ['openDirectory' as const, 'createDirectory' as const],
    }
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, reason: 'canceled' }

    const chosen = resolve(picked.filePaths[0])
    if (captureRootProblem(chosen) !== null) return { ok: false, reason: 'invalid' }

    // 実際に 1 ファイル書いて消す。存在するかどうかだけでは、読み取り専用の場所や
    // 権限の無いフォルダを見分けられない。
    try {
      await mkdir(chosen, { recursive: true })
      const probe = join(chosen, `.shiori-write-test-${Date.now()}`)
      await writeFile(probe, '')
      await unlink(probe)
    } catch (err) {
      console.warn('[storage] capture root is not writable', err)
      return { ok: false, reason: 'unwritable' }
    }

    const current = loadSettings()
    if (current.captureRoot != null && resolve(current.captureRoot) === chosen) {
      return { ok: true, path: chosen, moved: 0, missing: 0 }
    }

    // 今まで使っていた場所を先頭に控える。**新しい保存先自体は控えから外す**——
    // 同じ場所が 2 つの役で入っていると、戻したときに重複したまま増え続ける。
    const previousRoots = [
      ...(current.captureRoot ? [current.captureRoot] : []),
      ...current.previousCaptureRoots,
    ].filter((root) => resolve(root) !== chosen)
    const applyRoot = (): void => {
      saveSettings({ ...loadSettings(), captureRoot: chosen, previousCaptureRoots: previousRoots })
      console.log(`[storage] capture root changed to ${chosen}`)
    }

    const targets = planCaptureMove(listImagePaths(), [defaultCaptureDir(), ...previousRoots], chosen)
    if (targets.length === 0) {
      applyRoot()
      return { ok: true, path: chosen, moved: 0, missing: 0 }
    }

    // **移す前に必ず聞く。** 実体のコピーなので分単位かかるうえ、移動中は移動先に
    // 2 倍の空きが要る。押した人が「場所の設定を変えるだけ」と思っているまま
    // 何分も固まるのが最悪。
    const bytes = await totalBytes(targets.map((target) => target.from))
    const confirmed = await confirmMove(parent, targets.length, bytes, chosen)
    if (!confirmed) return { ok: false, reason: 'move-canceled' }

    moveCanceled = false
    beginTask('capture-move')
    try {
      const outcome = await moveCaptureFiles({
        targets,
        commit: (moved) => setImagePaths(moved.map((target) => ({ id: target.id, filepath: target.to }))),
        onProgress: (currentCount, total) => {
          if (shouldSendProgress(currentCount, total)) {
            sendToRenderer(CH.storageMoveProgress, { current: currentCount, total })
          }
        },
        isCanceled: () => moveCanceled,
      })
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') {
          return { ok: false, reason: 'move-conflict', conflictPath: outcome.failedPath ?? '' }
        }
        return { ok: false, reason: outcome.reason === 'canceled' ? 'move-canceled' : 'move-failed' }
      }
      // **保存先を変えるのは、移し終えてから。** 先に変えると、移動が失敗したときに
      // 「保存先だけ新しい・ファイルは全部古い場所」という半端な状態が残る。
      applyRoot()
      return { ok: true, path: chosen, moved: outcome.moved, missing: outcome.missing }
    } finally {
      endTask('capture-move')
      sendToRenderer(CH.storageMoveProgress, { current: 0, total: 0 })
    }
  })

  handleTrusted(CH.storageCancelMove, () => { moveCanceled = true })

  handleTrusted(CH.wsGetPort, () => getActivePort())

  handleTrusted(CH.storageGetInfo, async () => {
    const usage = await collectStorageUsage()
    return {
      ...usage,
      imageCount: countImages({ mediaType: 'image' }),
      videoCount: countImages({ mediaType: 'video' }),
    }
  })
}
