// 画像一覧・件数・エクスポート・取得・タイトル/メモ更新・サムネ一括生成・削除の IPC ハンドラ。
import { dialog, shell } from 'electron'
import { access, stat, copyFile } from 'fs/promises'
import { basename, extname } from 'path'
import { handleTrusted, sendToRenderer } from './windows'
import {
  listImages, countImages, listImagesAll, listSites, listSiteCounts, listAllTags, listTagCounts,
  getImage, deleteImage, deleteImagesBulk, updateImageTitle, updateImageMemo, listImagesForThumbCheck, setThumbPath
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
import { createProgressThrottle } from './progress-throttle'
// ゴミ箱への移動を並列投入しすぎると Windows のシェル操作が一時的に失敗するため絞る
// （旧: renderer 側 useSelection.ts の DELETE_CONCURRENCY と同じ理由。B-7 で main 側に統合）。
const DELETE_TRASH_CONCURRENCY = 4

let isThumbGen = false
let isImagesExporting = false
let isImagesExportCanceled = false

// サムネイルが欠けている画像にサムネを補完する。移行直後の旧データや、
// 生成に失敗したまま登録されたエントリを対象に起動時（bootstrap.ts）から自動で呼ぶ。
export async function backfillThumbnails(): Promise<void> {
  if (isThumbGen) return
  isThumbGen = true
  try {
    const targets = listImagesForThumbCheck()
    for (const { id, filepath, thumb_path } of targets) {
      try {
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
        const resolved = await resolveRealCapturePath(filepath)
        if (!resolved) throw new Error('path not resolvable')
        const thumbPath = thumbPathFor(resolved)
        await createImageThumb(resolved, thumbPath)
        setThumbPath(id, thumbPath)
      } catch (err) {
        console.error(`[thumbgen] skip id=${id}`, err)
      }
    }
  } finally {
    isThumbGen = false
  }
}

export function registerImageHandlers(): void {
  handleTrusted(CH.imagesList, (_event, req: unknown) => listImages(imageListRequest(req)))

  handleTrusted(CH.imagesCount, (_event, query: unknown) => countImages(imageQuery(query)))

  handleTrusted(CH.imagesListAll, (_event, query: unknown) => listImagesAll(imageQuery(query)))

  handleTrusted(CH.imagesListSites, () => listSites())
  handleTrusted(CH.imagesListSiteCounts, () => listSiteCounts())
  handleTrusted(CH.imagesListAllTags, () => listAllTags())
  handleTrusted(CH.imagesListTagCounts, () => listTagCounts())

  handleTrusted(CH.imagesExport, async (_event, imageIds: number[]) => {
    // renderer 側（exportStore の exportKind ガード）だけだと、拡張機能の別ウィンドウや
    // 復旧不能な状態からの二重呼び出しを防げない。isImagesExportCanceled がモジュール単一の
    // フラグなので、並行実行されると片方の中止操作がもう片方も止め、進捗表示も混線する（R-5）。
    if (isImagesExporting) return { canceled: true }
    isImagesExporting = true
    try {
      const uniqueIds = Array.isArray(imageIds)
        ? [...new Set(imageIds.map(optionalPositiveInteger).filter((id): id is number => id != null))]
        : []
      const truncated = uniqueIds.length > MAX_EXPORT_IDS
      const ids = uniqueIds.slice(0, MAX_EXPORT_IDS)

      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'エクスポート先フォルダを選択',
        properties: ['openDirectory']
      })
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
    }
  })

  handleTrusted(CH.imagesExportCancel, () => { isImagesExportCanceled = true })

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
      // 1) まず DB 行を削除して確定させる。ここを先にすることで、原本/サムネのゴミ箱移動が
      //    途中で失敗しても「DB行は消えたのにファイルだけ残る（孤立ファイル）」にしかならず、
      //    逆順（先にファイルを消す）だと起きうる「ファイルは消えたのに DB 行が残るゴースト表示」
      //    を構造的に避けられる。孤立ファイルは害がなく後で手動/再生成で掃除できるが、ゴースト
      //    行は一覧上にサムネ等が破損した項目として残り続け、ユーザーには直しようがない。
      deleteImage(imageId)
      // 2) 原本をゴミ箱へ。失敗しても DB 行は既に削除済みなので戻さない（孤立ファイルとして残る）。
      const mainSafe = await resolveRealCapturePath(image.filepath)
      if (mainSafe) {
        try {
          await stat(mainSafe)
          await shell.trashItem(mainSafe)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[images:delete] main file trash failed id=${imageId} (non-fatal, DB row already removed)`, err)
          }
        }
      }
      // 3) サムネも同様に非クリティカルな後始末。失敗しても DB 削除は巻き戻さない。
      if (image.thumb_path) {
        const thumbSafe = await resolveRealCapturePath(image.thumb_path)
        if (thumbSafe) {
          try {
            await stat(thumbSafe)
            await shell.trashItem(thumbSafe)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(`[images:delete] thumb trash failed id=${imageId} (non-fatal)`, err)
            }
          }
        }
      }
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
    // ゴミ箱移動が後で失敗しても DB は戻さない（孤立ファイルは無害・ゴースト行は避けたい）。
    deleteImagesBulk(found.map((x) => x.id))

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < found.length) {
        const { id, image } = found[cursor++]
        const mainSafe = await resolveRealCapturePath(image.filepath)
        if (mainSafe) {
          try {
            await stat(mainSafe)
            await shell.trashItem(mainSafe)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(`[images:deleteBulk] main file trash failed id=${id} (non-fatal, DB row already removed)`, err)
            }
          }
        }
        if (image.thumb_path) {
          const thumbSafe = await resolveRealCapturePath(image.thumb_path)
          if (thumbSafe) {
            try {
              await stat(thumbSafe)
              await shell.trashItem(thumbSafe)
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn(`[images:deleteBulk] thumb trash failed id=${id} (non-fatal)`, err)
              }
            }
          }
        }
        results.push({ ok: true, id })
      }
    }
    await Promise.all(Array.from({ length: Math.min(DELETE_TRASH_CONCURRENCY, found.length) }, worker))
    return results
  })
}
