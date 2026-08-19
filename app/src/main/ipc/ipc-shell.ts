// OS 側を開く操作（URL・エクスプローラー）と、設定画面に出す接続ポート・使用容量。
// bootstrap.ts から切り出した。
//
// **外へ渡す前に必ず絞る。** URL は safeExternalUrl、パスは DB に載っている画像の
// 実体だけ（resolveRealCapturePath）。ここを緩めると、renderer から任意の場所を
// 開かせられる経路になる。
import { shell } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { CH } from '../../shared/api'
import { handleTrusted, safeExternalUrl } from '../system/windows'
import { optionalPositiveInteger } from './ipc-validation'
import { getImage, countImages } from '../db'
import { resolveRealCapturePath, captureDir } from '../system/paths'
import { installedExtensionPath } from '../browser/extension-updater'
import { getActivePort } from '../browser/ws-server'
import { collectStorageUsage } from '../system/storage'

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
  handleTrusted(CH.shellShowCapturesFolder, async () => {
    // 1枚も撮っていないと captures 自体が無く openPath は黙って失敗する。作ってから開く。
    const dir = captureDir()
    mkdirSync(dir, { recursive: true })
    // showItemInFolder は「親を開いて対象を選択」なので、フォルダ自体を開くには openPath を使う。
    await shell.openPath(dir)
  })

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
