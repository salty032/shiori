// 画像一覧・件数・エクスポート・取得・タイトル/メモ更新・サムネ一括生成・削除の IPC ハンドラ。
import { dialog } from 'electron'
import { access, stat, copyFile, unlink } from 'fs/promises'
import { basename, extname } from 'path'
import { getMainWindow, handleTrusted, sendToRenderer } from './windows'
import {
  listImages, countImages, listImagesAll, listSites, listSiteCounts, listAllTags, listTagCounts,
  getImage, deleteImage, deleteImagesBulk, updateImageTitle, updateImageMemo,
  listImagesMissingThumb, listImagesForThumbCheck, setThumbPath
} from './db'
import {
  MAX_EXPORT_IDS,
  optionalText, optionalPositiveInteger,
  imageQuery, imageListRequest,
  sanitizeFilename, formatDateForFilename, formatTimecodeForFilename, uniqueExportPath
} from './ipc-validation'
import { CH } from '../shared/api'
import { MAX_BULK_IDS, MAX_MEMO_LENGTH } from '../shared/constants'
import type { DeleteImageResult } from '../shared/types'
import { resolveRealCapturePath, thumbPathFor } from './paths'
import { createImageThumb } from './image-thumb'
import { getVideoThumbProvider } from './video-thumb-provider'
import { createProgressThrottle } from './progress-throttle'
import { beginTask, endTask } from './busy'
import { t } from './i18n'
// 削除を並列投入しすぎると Windows のファイル操作が一時的に失敗するため絞る
// （旧: renderer 側 useSelection.ts の DELETE_CONCURRENCY と同じ理由。B-7 で main 側に統合）。
const DELETE_CONCURRENCY = 4

let isThumbGen = false
let isImagesExporting = false
let isImagesExportCanceled = false

// 削除確定（DB 行削除）後の後始末として、原本とサムネをディスクから消す。
//
// 以前は shell.trashItem でゴミ箱へ移していたが、それだと「Shiori で消したのに空き容量が
// 増えない」状態になり、容量を戻すのにユーザーが自分でゴミ箱を空ける必要があった。
// 取り消しは削除確定前の猶予（useSelection.ts の DELETE_UNDO_MS）で既に成立していて、
// ここへ来る時点で取り消し機会は過ぎている。以降はアプリが最後まで後始末する。
//
// DB 行は既に削除済みなので、ここでの失敗は巻き戻さず孤立ファイルとして残すだけ
// （逆順で起きうるゴースト行を構造的に避ける設計）。残っても次回起動の sweep-orphans が
// 回収するため、ユーザーのディスクに居座り続けることはない。
// ENOENT（既に無い）は正常系として黙殺する。
async function removeImageFiles(
  image: { filepath: string; thumb_path: string | null },
  id: number,
  logLabel: string
): Promise<void> {
  const removeOne = async (storedPath: string, kind: 'main' | 'thumb'): Promise<void> => {
    const safe = await resolveRealCapturePath(storedPath)
    if (!safe) return
    try {
      await unlink(safe)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[${logLabel}] ${kind} file remove failed id=${id} (non-fatal, DB row already removed)`, err)
      }
    }
  }
  await removeOne(image.filepath, 'main')
  if (image.thumb_path) await removeOne(image.thumb_path, 'thumb')
}

// 1 枚分のサムネを生成して DB に記録する。成功したら true。動画は video-thumb-provider
// （動画機能が登録する ffmpeg 経由の抽出）、それ以外は既存の createImageThumb を使う。
async function generateThumb(id: number, filepath: string, mediaType: 'image' | 'video' | null): Promise<boolean> {
  try {
    const resolved = await resolveRealCapturePath(filepath)
    if (!resolved) throw new Error('path not resolvable')
    if (mediaType === 'video') {
      const thumbPath = thumbPathFor(resolved, '.png')
      await getVideoThumbProvider().extractThumb(resolved, thumbPath)
      setThumbPath(id, thumbPath)
    } else {
      const thumbPath = thumbPathFor(resolved)
      await createImageThumb(resolved, thumbPath)
      setThumbPath(id, thumbPath)
    }
    return true
  } catch (err) {
    console.error(`[thumbgen] skip id=${id}`, err)
    return false
  }
}

// サムネ未生成の画像・動画にサムネを補完する。移行直後の旧データや、生成に失敗したまま
// 登録されたエントリを対象に起動時（bootstrap.ts）から自動で呼ぶ。
// 記録済みサムネの実ファイル確認はここでは行わない（S4-2）。全件の存在確認は起動を
// 重くするだけで、通常は 1 件も直すものがないため、repairThumbnails() の手動実行に回す。
export async function backfillThumbnails(): Promise<void> {
  if (isThumbGen) return
  isThumbGen = true
  try {
    for (const { id, filepath, media_type } of listImagesMissingThumb()) {
      await generateThumb(id, filepath, media_type)
    }
  } finally {
    isThumbGen = false
  }
}

// 手動の「サムネイル修復」。全画像を走査し、サムネ未生成のものと、thumb_path は記録済みだが
// 実ファイルが消えているものを再生成する。ディスクアクセスが件数に比例するため自動では呼ばない。
export async function repairThumbnails(): Promise<{ repaired: number; failed: number }> {
  if (isThumbGen) return { repaired: 0, failed: 0 }
  isThumbGen = true
  beginTask('thumb-repair')
  try {
    const targets = listImagesForThumbCheck()
    let repaired = 0
    let failed = 0
    for (const { id, filepath, thumb_path, media_type } of targets) {
      if (thumb_path) {
        const existingThumb = await resolveRealCapturePath(thumb_path)
        if (existingThumb) {
          try {
            await access(existingThumb)
            continue
          } catch {
            // サムネファイルが見つからない → 再生成へ進む
          }
        }
      }
      if (await generateThumb(id, filepath, media_type)) repaired++
      else failed++
    }
    return { repaired, failed }
  } finally {
    isThumbGen = false
    endTask('thumb-repair')
  }
}

export function registerImageHandlers(): void {
  handleTrusted(CH.imagesList, (_event, req: unknown) => listImages(imageListRequest(req)))

  handleTrusted(CH.imagesCount, (_event, query: unknown) => countImages(imageQuery(query)))

  handleTrusted(CH.imagesListAll, (_event, query: unknown) => listImagesAll(imageQuery(query)))

  handleTrusted(CH.imagesListSites, () => listSites())
  handleTrusted(CH.imagesListSiteCounts, () => listSiteCounts())
  handleTrusted(CH.imagesListAllTags, (_event, includeAi: unknown) => listAllTags(includeAi === true))
  handleTrusted(CH.imagesListTagCounts, () => listTagCounts())

  handleTrusted(CH.imagesExport, async (_event, imageIds: number[]) => {
    // renderer 側（exportStore の exportKind ガード）だけだと、拡張機能の別ウィンドウや
    // 復旧不能な状態からの二重呼び出しを防げない。isImagesExportCanceled がモジュール単一の
    // フラグなので、並行実行されると片方の中止操作がもう片方も止め、進捗表示も混線する（R-5）。
    if (isImagesExporting) return { canceled: true }
    isImagesExporting = true
    beginTask('export')
    try {
      const uniqueIds = Array.isArray(imageIds)
        ? [...new Set(imageIds.map(optionalPositiveInteger).filter((id): id is number => id != null))]
        : []
      const truncated = uniqueIds.length > MAX_EXPORT_IDS
      const ids = uniqueIds.slice(0, MAX_EXPORT_IDS)

      // 親ウィンドウを渡さないとダイアログがモーダル化されず、他ウィンドウの操作で
      // 背面に隠れると「押したのに何も起きない」ように見える（BUG-3）。
      const win = getMainWindow()
      const dialogOptions: Electron.OpenDialogOptions = { title: t('dialog.exportFolder'), properties: ['openDirectory'] }
      const { canceled, filePaths } = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (canceled || !filePaths[0]) return { canceled: true }
      isImagesExportCanceled = false
      const dest = filePaths[0]
      const used = new Set<string>()
      const copyOne = async (id: number): Promise<boolean> => {
        const image = getImage(id)
        if (!image) return false
        const src = await resolveRealCapturePath(image.filepath)
        if (!src) return false
        try {
          await stat(src)
        } catch {
          return false
        }
        const baseTitle = sanitizeFilename(image.title || basename(src, extname(src)))
        const datePart = formatDateForFilename(image.captured_at)
        const timePart = formatTimecodeForFilename(image.current_time)
        const srcExt = extname(src) || '.png'
        const preferred = `${baseTitle}_${datePart}${timePart ? `_t${timePart}` : ''}${srcExt}`
        try {
          await copyFile(src, await uniqueExportPath(dest, preferred, used))
          return true
        } catch (err) {
          console.warn(`[images:export] copy failed id=${id}`, err)
          return false
        }
      }
      let count = 0
      const total = ids.length
      sendToRenderer(CH.exportProgress, { current: 0, total })
      const shouldSend = createProgressThrottle(total)
      for (let i = 0; i < ids.length; i++) {
        if (isImagesExportCanceled) break
        if (await copyOne(ids[i])) count++
        if (shouldSend(i + 1)) sendToRenderer(CH.exportProgress, { current: i + 1, total })
      }
      return { canceled: isImagesExportCanceled, count, truncated }
    } finally {
      isImagesExporting = false
      endTask('export')
    }
  })

  handleTrusted(CH.imagesExportCancel, () => { isImagesExportCanceled = true })

  handleTrusted(CH.imagesRepairThumbs, () => repairThumbnails())

  handleTrusted(CH.imagesGet, (_event, id: number) => {
    const imageId = optionalPositiveInteger(id)
    return imageId ? getImage(imageId) : null
  })

  handleTrusted(CH.imagesUpdateTitle, (_event, id: number, title: string) => {
    const imageId = optionalPositiveInteger(id)
    if (imageId) updateImageTitle(imageId, optionalText(title) ?? '')
  })
  handleTrusted(CH.imagesUpdateMemo, (_event, id: number, memo: string) => {
    const imageId = optionalPositiveInteger(id)
    if (imageId) updateImageMemo(imageId, optionalText(memo, MAX_MEMO_LENGTH) ?? '')
  })

  handleTrusted(CH.imagesDelete, async (_event, id: number) => {
    const imageId = optionalPositiveInteger(id)
    if (!imageId) return { ok: false, id: 0, error: 'invalid id' }
    const image = getImage(imageId)
    if (!image) return { ok: false, id: imageId, error: 'not found' }
    try {
      // 1) まず DB 行を削除して確定させる。ここを先にすることで、原本/サムネの削除が
      //    途中で失敗しても「DB行は消えたのにファイルだけ残る（孤立ファイル）」にしかならず、
      //    逆順（先にファイルを消す）だと起きうる「ファイルは消えたのに DB 行が残るゴースト表示」
      //    を構造的に避けられる。孤立ファイルは害がなく後で手動/再生成で掃除できるが、ゴースト
      //    行は一覧上にサムネ等が破損した項目として残り続け、ユーザーには直しようがない。
      deleteImage(imageId)
      // 2) 原本・サムネを削除（非クリティカルな後始末。失敗しても DB 削除は巻き戻さない）。
      await removeImageFiles(image, imageId, 'images:delete')
      return { ok: true, id: imageId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[images:delete] failed id=${imageId}`, err)
      return { ok: false, id: imageId, error: message }
    }
  })

  handleTrusted(CH.imagesDeleteBulk, async (_event, ids: unknown): Promise<DeleteImageResult[]> => {
    const validIds = Array.isArray(ids)
      ? [...new Set(ids.map(optionalPositiveInteger).filter((id): id is number => id != null))].slice(0, MAX_BULK_IDS)
      : []
    if (validIds.length === 0) return []

    const found = validIds
      .map((id) => ({ id, image: getImage(id) }))
      .filter((x): x is { id: number; image: NonNullable<ReturnType<typeof getImage>> } => x.image != null)
    const foundIdSet = new Set(found.map((x) => x.id))
    const results: DeleteImageResult[] = validIds
      .filter((id) => !foundIdSet.has(id))
      .map((id) => ({ ok: false, id, error: 'not found' }))

    // DB 行はまとめて 1 トランザクションで削除して確定させる（B-7）。単体削除と同じ理由で、
    // ファイル削除が後で失敗しても DB は戻さない（孤立ファイルは無害・ゴースト行は避けたい）。
    deleteImagesBulk(found.map((x) => x.id))

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < found.length) {
        const { id, image } = found[cursor++]
        await removeImageFiles(image, id, 'images:deleteBulk')
        results.push({ ok: true, id })
      }
    }
    await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, found.length) }, worker))
    return results
  })
}
