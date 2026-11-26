// 画像一覧・件数・エクスポート・取得・タイトル/メモ更新・サムネ一括生成・削除の IPC ハンドラ。
import { showOpenDialogOver } from '../system/dialogs'
import { access, copyFile, unlink } from 'fs/promises'
import { basename, extname } from 'path'
import { handleTrusted, sendToRenderer } from '../system/windows'
import {
  listImages, countImages, listImagesAll, listSites,
  getImage, deleteImagesBulk, updateImageTitle, updateImageMemo,
  listImagesMissingThumb, listImagesForThumbCheck, setThumbPath,
  getTimesheet, saveTimesheet
} from '../db/db'
import { listAllTags } from '../db/db-tags'
import { decodeTimesheet, encodeTimesheet } from '../../shared/timesheet'
import {
  MAX_EXPORT_IDS,
  optionalText, optionalPositiveInteger,
  imageQuery, imageListRequest,
  sanitizeFilename, formatDateForFilename, formatTimecodeForFilename, uniqueExportPath,
  uniqueImageIds,
} from './ipc-validation'
import { CH, type ExportImagesResult } from '../../shared/api'
import { MAX_BULK_IDS, MAX_MEMO_LENGTH } from '../../shared/constants'
import type { DeleteImageResult, ImageRow } from '../../shared/types'
import { resolveRealCapturePath, thumbPathFor } from '../system/paths'
import { fileExists } from '../system/file-exists'
import { createImageThumb } from '../capture/image-thumb'
import { createProgressThrottle } from '../system/progress-throttle'
import { exclusiveTask } from '../system/exclusive-task'
import { t } from '../system/i18n'
import { loadSettings } from '../system/settings'
import { extractThumb, getVideoMeta, transcodeToH264 } from '../video/ffmpeg'
// 削除を並列投入しすぎると Windows のファイル操作が一時的に失敗するため絞る
// （旧: renderer 側 useSelection.ts の DELETE_CONCURRENCY と同じ理由。B-7 で main 側に統合）。
const DELETE_CONCURRENCY = 4

// 起動時の補完と手動の修復は同じサムネを書くので、1 つで排他する。
const thumbGen = exclusiveTask()
const imagesExport = exclusiveTask()

// 削除確定（DB 行削除）後の後始末として、原本とサムネをディスクから消す。
//
// 以前は shell.trashItem でゴミ箱へ移していたが、それだと「Shiori で消したのに空き容量が
// 増えない」状態になり、容量を戻すのにユーザーが自分でゴミ箱を空ける必要があった。
// 取り消しは削除確定前の猶予（usePendingDeletion.ts の DELETE_UNDO_MS）で既に成立していて、
// ここへ来る時点で取り消し機会は過ぎている。以降はアプリが最後まで後始末する。
//
// DB 行は既に削除済みなので、ここでの失敗は巻き戻さず孤立ファイルとして残すだけ
// （逆順で起きうるゴースト行を構造的に避ける設計）。次回起動の sweep-orphans が回収するのは
// サムネイルだけで、**原本は残る**（判定を誤っても取り出せるよう、原本は走査しない）。
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

// 1 枚分のサムネを生成して DB に記録する。成功したら true。動画は ffmpeg で抽出し、
// それ以外は createImageThumb を使う。
async function generateThumb(id: number, filepath: string, mediaType: 'image' | 'video' | null): Promise<boolean> {
  try {
    const resolved = await resolveRealCapturePath(filepath)
    if (!resolved) throw new Error('path not resolvable')
    if (mediaType === 'video') {
      const thumbPath = thumbPathFor(resolved, '.png')
      await extractThumb(resolved, thumbPath)
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
export function backfillThumbnails(): Promise<void> {
  return thumbGen.run(null, undefined, async () => {
    for (const { id, filepath, media_type } of listImagesMissingThumb()) {
      await generateThumb(id, filepath, media_type)
    }
  })
}

// 手動の「サムネイル修復」。全画像を走査し、サムネ未生成のものと、thumb_path は記録済みだが
// 実ファイルが消えているものを再生成する。ディスクアクセスが件数に比例するため自動では呼ばない。
function repairThumbnails(): Promise<{ repaired: number; failed: number }> {
  return thumbGen.run('thumb-repair', { repaired: 0, failed: 0 }, async () => {
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
  })
}

export function registerImageHandlers(): void {
  handleTrusted(CH.imagesList, (_event, req: unknown) => listImages(imageListRequest(req)))

  handleTrusted(CH.imagesCount, (_event, query: unknown) => countImages(imageQuery(query)))

  handleTrusted(CH.imagesListAll, (_event, query: unknown) => listImagesAll(imageQuery(query)))

  handleTrusted(CH.imagesListSites, () => listSites())
  handleTrusted(CH.imagesListAllTags, (_event, includeAi: unknown) => listAllTags(includeAi === true))

  handleTrusted(CH.imagesExport, async (_event, imageIds: number[], options?: unknown): Promise<ExportImagesResult> => {
    const skipMissing = typeof options === 'object' && options !== null && (options as { skipMissing?: unknown }).skipMissing === true
    // renderer 側（exportStore の exportKind ガード）だけだと、拡張機能の別ウィンドウや
    // 復旧不能な状態からの二重呼び出しを防げない。「やめて」がモジュール単一なので、
    // 並行実行されると片方の中止操作がもう片方も止め、進捗表示も混線する（R-5）。
    return imagesExport.run('export', { canceled: true }, async (): Promise<ExportImagesResult> => {
      const uniqueIds = uniqueImageIds(imageIds)
      const truncated = uniqueIds.length > MAX_EXPORT_IDS
      const ids = uniqueIds.slice(0, MAX_EXPORT_IDS)

      // **書き出しを途中で欠けさせない。** 元ファイルは書く前に全部確かめ、無いものがあれば
      // 何も書かずに返して画面で聞く（残りを書き出すかは利用者が決める）。全部失敗にしないのは、
      // どの画像の元ファイルが無いかを示す表示が無く、選び直して抜け出す手段が無いから。
      const ready: { image: ImageRow; src: string }[] = []
      let missing = 0
      for (const id of ids) {
        const image = getImage(id)
        const src = image ? await resolveRealCapturePath(image.filepath) : null
        if (!image || !src || !(await fileExists(src))) {
          missing++
          console.warn(`[images:export] source unavailable id=${id}`)
          continue
        }
        ready.push({ image, src })
      }
      if (missing > 0 && (ready.length === 0 || !skipMissing)) {
        return { canceled: false, missing, exportable: ready.length }
      }

      const { canceled, filePaths } = await showOpenDialogOver({ title: t('dialog.exportFolder'), properties: ['openDirectory'] })
      if (canceled || !filePaths[0]) return { canceled: true }
      imagesExport.clearCancel()
      const dest = filePaths[0]
      const used = new Set<string>()
      // 形式は設定（設定 > データ > 動画の書き出し形式）から読む。**フォルダを選ぶ前ではなく
      // ここで 1 回だけ読む**ので、書き出しの最中に設定を変えられても 1 回の書き出しの中で
      // 形式が混ざることはない。
      const toH264 = loadSettings().videoExportFormat === 'h264'
      // H.264 で頼まれたのに変換できず、元の形式のまま置いた本数。
      // **黙って webm を置くと「mp4 で出したつもり」のまま気づけない。** 画面に出す。
      let notConverted = 0
      // 書き出し先に置いたファイル。保存に失敗したら全部消して「何も書き出していない」に戻す。
      const written: string[] = []
      const copyOne = async ({ image, src }: { image: ImageRow; src: string }): Promise<'ok' | 'canceled' | 'write-failed'> => {
        const id = image.id
        const baseTitle = sanitizeFilename(image.title || basename(src, extname(src)))
        const datePart = formatDateForFilename(image.captured_at)
        const timePart = formatTimecodeForFilename(image.current_time)
        const srcExt = extname(src) || '.png'
        const nameWith = async (ext: string): Promise<string> =>
          uniqueExportPath(dest, `${baseTitle}_${datePart}${timePart ? `_t${timePart}` : ''}${ext}`, used)

        if (toH264 && image.media_type === 'video') {
          // すでに H.264 のものは触らない。変換は非可逆なので、掛け直すだけ画質が落ちる
          // （取り込んだ mp4 が該当する）。コーデックが読めなかったときは変換する側へ倒す
          //  ——「H.264 でない可能性があるものを H.264 として出す」ほうが困る。
          let alreadyH264 = false
          try {
            alreadyH264 = (await getVideoMeta(src)).codec === 'h264'
          } catch (err) {
            console.warn(`[images:export] codec probe failed id=${id}`, err)
          }
          if (!alreadyH264) {
            const outPath = await nameWith('.mp4')
            try {
              await transcodeToH264(
                src,
                outPath,
                { width: image.width, height: image.height, fps: image.fps },
                () => imagesExport.canceled
              )
              written.push(outPath)
              return 'ok'
            } catch (err) {
              try { await unlink(outPath) } catch {}
              // 中止で落ちたときは「失敗」として数えない（この後ループも抜ける）。
              if (imagesExport.canceled) return 'canceled'
              console.warn(`[images:export] h264 transcode failed id=${id}`, err)
              notConverted++
            }
          }
        }

        const outPath = await nameWith(srcExt)
        try {
          await copyFile(src, outPath)
          written.push(outPath)
          return 'ok'
        } catch (err) {
          console.warn(`[images:export] copy failed id=${id}`, err)
          try { await unlink(outPath) } catch {}
          return 'write-failed'
        }
      }
      let count = 0
      const total = ready.length
      sendToRenderer(CH.exportProgress, { current: 0, total })
      const shouldSend = createProgressThrottle(total)
      for (let i = 0; i < ready.length; i++) {
        if (imagesExport.canceled) break
        const result = await copyOne(ready[i])
        if (result === 'write-failed') {
          // 途中まで書いた分を残すと、どこまで入ったか分からない半端なフォルダになる。
          for (const path of written) {
            try { await unlink(path) } catch (err) { console.warn('[images:export] rollback failed', path, err) }
          }
          sendToRenderer(CH.exportProgress, { current: total, total })
          return { canceled: false, writeFailed: true }
        }
        if (result === 'ok') count++
        if (shouldSend(i + 1)) sendToRenderer(CH.exportProgress, { current: i + 1, total })
      }
      if (imagesExport.canceled) return { canceled: true, count }
      return { canceled: false, count, truncated, notConverted }
    })
  })

  handleTrusted(CH.imagesExportCancel, () => { imagesExport.cancel() })

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

  handleTrusted(CH.timesheetGet, (_event, id: number) => {
    const imageId = optionalPositiveInteger(id)
    return imageId ? getTimesheet(imageId) : null
  })
  // renderer から来た文字列をそのまま入れず、**保存側でも同じ decode/encode を通す**。
  // 読める行だけが残るので、壊れた入力でも DB に想定外の形が入らない。
  handleTrusted(CH.timesheetSave, (_event, id: number, data: unknown) => {
    const imageId = optionalPositiveInteger(id)
    if (!imageId) return
    saveTimesheet(imageId, encodeTimesheet(decodeTimesheet(typeof data === 'string' ? data : null)))
  })

  handleTrusted(CH.imagesDeleteBulk, async (_event, ids: unknown): Promise<DeleteImageResult[]> => {
    const validIds = uniqueImageIds(ids).slice(0, MAX_BULK_IDS)
    if (validIds.length === 0) return []

    const found = validIds
      .map((id) => ({ id, image: getImage(id) }))
      .filter((x): x is { id: number; image: NonNullable<ReturnType<typeof getImage>> } => x.image != null)
    const foundIdSet = new Set(found.map((x) => x.id))
    const results: DeleteImageResult[] = validIds
      .filter((id) => !foundIdSet.has(id))
      .map((id) => ({ ok: false, id, error: 'not found' }))

    // DB 行はまとめて 1 トランザクションで削除して確定させる（B-7）。原本よりDBを先に消し、
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
