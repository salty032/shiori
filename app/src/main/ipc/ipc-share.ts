// 一括共有（ライブラリ全体のエクスポート / インポート / スマートフォルダ設定の取り込み）の IPC ハンドラ。
import { showOpenDialogOver } from '../system/dialogs'
import { stat, copyFile, mkdir, readFile, writeFile, unlink } from 'fs/promises'
import { join, basename } from 'path'
import { handleTrusted, sendToRenderer, safeExternalUrl } from '../system/windows'
import { getTimesheet, listImagesForExport, saveTimesheet } from '../db/db'
import { decodeTimesheet, encodeTimesheet } from '../../shared/timesheet'
import { decodeFrames, encodeFrames, getVideoFrames, restoreVideoFrames } from '../db/db-video-frames'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbnailDir, thumbPathFor, captureFileName } from '../system/paths'
import { formatDateForFilename, uniqueExportFilename } from './ipc-validation'
import { CH } from '../../shared/api'
import { MAX_SHARE_FRAME_TABLE_BYTES, buildShareEntry, parseShareEntry, type ImportMode } from './share-entry'
import { extractThumb, getVideoMeta } from '../video/ffmpeg'
import { importDurationError } from './ipc-import'
import { registerCapturedMedia } from '../capture/captured-media'
import { createProgressThrottle } from '../system/progress-throttle'
import { exclusiveTask } from '../system/exclusive-task'
import { t } from '../system/i18n'
import { MAX_MEDIA_FILE_BYTES } from '../system/media-exts'

const shareExport = exclusiveTask()
const shareImport = exclusiveTask()
const MAX_SHARE_METADATA_BYTES = 64 * 1024 * 1024
// 30.5秒（取り込み許容誤差込み）×120fpsより余裕を持たせる。壊れた表が
// ビューアやDBを不必要に膨らませないための多層防御。
const MAX_SHARE_FRAME_ROWS = 4_000

// 同じ秒に連続して書き出しても既存バンドルへ画像が混ざらないよう、ディレクトリ作成自体を
// 衝突判定として使って一意な保存先を予約する（事前 access だけだと TOCTOU になる）。
async function createUniqueExportDir(parent: string, timestamp: number): Promise<string> {
  const base = `shiori_export_${formatDateForFilename(timestamp)}`
  for (let n = 0; ; n++) {
    const candidate = join(parent, n === 0 ? base : `${base}_${n}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

// 読み込み方は画面で聞いてから渡される（SettingsDataTab）。見知らぬ値は取り込まない——
// 黙ってどちらかに倒すと、自分のものと人のものが混ざるか、日付が全部今日になる。
function importModeOf(value: unknown): ImportMode | null {
  return value === 'restore' || value === 'receive' ? value : null
}

export function registerShareHandlers(): void {
  handleTrusted(CH.shareExport, async () => {
    // images:export と同じ理由（R-5）: renderer 側ガードだけでは並行実行を防げず、
    // 「やめて」が単一なので混線しうる。
    return shareExport.run('export', { canceled: true }, async () => {
      const { canceled, filePaths } = await showOpenDialogOver({ title: t('dialog.exportFolder'), properties: ['openDirectory'] })
      if (canceled || !filePaths[0]) return { canceled: true }
      shareExport.clearCancel()

      const destDir = await createUniqueExportDir(filePaths[0], Date.now())
      const imagesDir = join(destDir, 'images')
      const framesDir = join(destDir, 'frames')
      await mkdir(imagesDir, { recursive: true })
      await mkdir(framesDir, { recursive: true })

      const items = listImagesForExport()
      const copyOne = async (item: (typeof items)[number]): Promise<string | null> => {
        const src = await resolveRealCapturePath(item.filepath)
        if (!src) return null
        try { await stat(src) } catch { return null }

        let filename: string
        try {
          filename = await uniqueExportFilename(imagesDir, basename(src))
          await copyFile(src, join(imagesDir, filename))
        } catch (err) {
          console.warn(`[share:export] copy failed ${src}`, err)
          return null
        }

        let thumbFilename: string | null = null
        if (item.thumb_path) {
          const thumbSrc = await resolveRealCapturePath(item.thumb_path)
          if (thumbSrc) {
            try {
              await stat(thumbSrc)
              thumbFilename = await uniqueExportFilename(imagesDir, basename(thumbSrc))
              await copyFile(thumbSrc, join(imagesDir, thumbFilename))
            } catch { /* skip missing thumb */ }
          }
        }

        const frameTable = item.media_type === 'video' ? getVideoFrames(item.id) : null
        let frameTableFile: string | null = null
        if (frameTable) {
          frameTableFile = `${filename}.frames.json`
          try {
            await writeFile(join(framesDir, frameTableFile), encodeFrames(frameTable), 'utf-8')
          } catch (err) {
            // コマ表だけの失敗で動画本体まで書き出せなくするより、従来相当のデータを残す。
            console.warn(`[share:export] frame table write failed ${src}`, err)
            frameTableFile = null
          }
        }
        // 手で打ったタイムシートは作り直せない。打った位置は表の行で覚えているので、表と一緒のときだけ書く。
        const timesheet = frameTableFile ? getTimesheet(item.id) : null
        return JSON.stringify(buildShareEntry(item, { file: filename, thumb: thumbFilename, frameTable: frameTableFile, timesheet }))
      }
      const lines: string[] = []
      let count = 0
      const total = items.length
      sendToRenderer(CH.exportProgress, { current: 0, total })
      const shouldSend = createProgressThrottle(total)

      for (let i = 0; i < items.length; i++) {
        if (shareExport.canceled) break
        const line = await copyOne(items[i])
        if (line) { lines.push(line); count++ }
        if (shouldSend(i + 1)) sendToRenderer(CH.exportProgress, { current: i + 1, total })
      }

      // 中断時も、それまでコピー済みの分だけで metadata.jsonl を書き出す
      // （途中までの書き出し結果をそのまま share:import で読み込める状態にしておく）。
      await writeFile(join(destDir, 'metadata.jsonl'), lines.join('\n'), 'utf-8')

      return { canceled: shareExport.canceled, count, path: destDir }
    })
  })

  handleTrusted(CH.shareExportCancel, () => { shareExport.cancel() })

  handleTrusted(CH.shareImport, async (_event, rawMode: unknown) => {
    const mode = importModeOf(rawMode)
    if (!mode) return { canceled: true }
    // shareExport/imagesExport と同じ理由（R-5）: renderer 側のボタン disable だけでは
    // 並行呼び出しを防げず、同じフォルダの画像が二重登録されうる（画像には重複チェックが
    // ないため、スマートフォルダと違って静かに重複が積み上がる）（D-1）。
    return shareImport.run('library-import', { canceled: true }, async () => {
      const { canceled, filePaths } = await showOpenDialogOver({ title: t('dialog.importFolder'), properties: ['openDirectory'] })
      if (canceled || !filePaths[0]) return { canceled: true }
      shareImport.clearCancel()

      const srcDir = filePaths[0]
      let content: string
      try {
        const metadataPath = join(srcDir, 'metadata.jsonl')
        const metadataStat = await stat(metadataPath)
        if (!metadataStat.isFile() || metadataStat.size > MAX_SHARE_METADATA_BYTES) {
          return { canceled: false, count: 0, errors: [t('error.metadataTooLarge', { mb: MAX_SHARE_METADATA_BYTES / (1024 * 1024) })] }
        }
        content = await readFile(metadataPath, 'utf-8')
      } catch {
        return { canceled: false, count: 0, errors: [t('error.metadataMissing')] }
      }

      let count = 0
      const errors: string[] = []
      // 行数キャップは撤廃（B-2）。1件ずつ逐次処理で、ファイル存在・拡張子・captured_at 等の
      // 検証は行単位で完結しているため、件数上限をここに設ける必然性が薄い一方、
      // 1000枚超のライブラリで超過分が無言で消えるほうが実害が大きい。
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
      const total = lines.length
      sendToRenderer(CH.shareImportProgress, { current: 0, total })
      const shouldSend = createProgressThrottle(total)

      for (let i = 0; i < lines.length; i++) {
        if (shareImport.canceled) break
        // 下の catch で「どの行が失敗したか」を出すために、行の外側に控える。
        let entryFile: string | null = null
        try {
          const line = lines[i]
          const parsed = parseShareEntry(line, Date.now(), mode)
          if (parsed === null) continue
          if ('error' in parsed) { errors.push(parsed.error); continue }
          entryFile = parsed.file

          const srcFile = join(srcDir, 'images', parsed.file)
          let srcStat: Awaited<ReturnType<typeof stat>>
          try { srcStat = await stat(srcFile) } catch { errors.push(`file not found: ${parsed.file}`); continue }
          if (srcStat.size > MAX_MEDIA_FILE_BYTES) { errors.push(`file too large: ${parsed.file}`); continue }

          const ts = Date.now()
          const dir = await ensureCaptureSubDir(parsed.capturedAt)
          const destFile = join(dir, captureFileName(ts, parsed.ext))

          let thumbDest: string | null = null
          if (parsed.thumbFile && parsed.thumbExt) {
            const srcThumb = join(srcDir, 'images', parsed.thumbFile)
            try {
              await stat(srcThumb)
              thumbDest = thumbPathFor(destFile, parsed.thumbExt)
              await mkdir(thumbnailDir(), { recursive: true })
              await copyFile(srcThumb, thumbDest)
            } catch { /* skip missing thumb */ }
          }

          try {
            await copyFile(srcFile, destFile)
          } catch {
            errors.push(`copy failed: ${parsed.file}`)
            if (thumbDest) try { await unlink(thumbDest) } catch {}
            continue
          }

          let duration: number | null = null
          // fps は表示用の付随情報なので duration と違い、実体からの再取得はしない
          // （手編集バイパスの心配がある duration と異なり、不正値は share-entry.ts の
          // 検証で null に落ちるだけで実害が無い。ffmpeg 実行を1回減らせる）。
          let fps: number | null = parsed.fps
          if (parsed.mediaType === 'video') {
            // サムネがバンドルに含まれていなければここで生成する。duration は
            // metadata.jsonl の値を信頼せず実体から取り直す（手編集・旧バージョンの
            // エクスポートで欠けている/不正な場合の保険）。
            if (!thumbDest) {
              const tf = thumbPathFor(destFile, '.png')
              try { await extractThumb(destFile, tf); thumbDest = tf } catch (err) {
                console.warn('[share:import] extractThumb failed', err)
              }
            }
            try {
              const meta = await getVideoMeta(destFile)
              duration = meta.duration
              // duration が実体不一致で再取得されるのに対し、fps はバンドル値が検証済みなら
              // 優先する。バンドルに無ければ実体からの値で補う。
              if (fps == null) fps = meta.fps
            } catch (err) {
              console.warn('[share:import] getVideoMeta failed', err)
            }
            // 通常のファイル取り込み（ipc-import.ts）と同じ尺上限を適用する。ここを素通りさせると
            // metadata.jsonl を手編集した共有バンドル経由で著作権対策の30秒上限を回避できてしまう。
            const durationError = importDurationError(duration, parsed.file)
            if (durationError) {
              errors.push(durationError)
              try { await unlink(destFile) } catch {}
              if (thumbDest) try { await unlink(thumbDest) } catch {}
              continue
            }
          }

          const result = await registerCapturedMedia({
            insert: {
              filepath: destFile,
              captured_at: parsed.capturedAt,
              original_captured_at: parsed.originalCapturedAt,
              title: parsed.title,
              current_time: parsed.currentTime,
              url: parsed.url ? safeExternalUrl(parsed.url) : null,
              width: parsed.width,
              height: parsed.height,
              memo: parsed.memo,
              media_type: parsed.mediaType,
              duration,
              fps,
              thumb_path: thumbDest,
              source: parsed.source,
            },
            filePath: destFile,
            thumbPath: thumbDest,
            extraTags: parsed.tags.length > 0 ? parsed.tags.map((name) => ({ name, source: 'manual' as const })) : undefined,
            broadcastCaptureDone: false,
            autoTag: null
          })
          if (!result.ok) {
            errors.push(`insert failed: ${parsed.file}`)
            continue
          }
          // v2のコマ表を復元する。旧v1には frame_table が無いため従来どおり何もしない。
          // 追加情報が壊れていても動画本体の取り込みは成立しているので、表だけ諦める。
          let frameTableData = parsed.frameTableData
          if (!frameTableData && parsed.frameTableFile) {
            try {
              const frameTablePath = join(srcDir, 'frames', parsed.frameTableFile)
              const frameTableStat = await stat(frameTablePath)
              if (frameTableStat.isFile() && frameTableStat.size <= MAX_SHARE_FRAME_TABLE_BYTES) {
                frameTableData = await readFile(frameTablePath, 'utf-8')
              }
            } catch (err) {
              console.warn(`[share:import] frame table sidecar unavailable: ${parsed.file}`, err)
            }
          }
          if (frameTableData) {
            try {
              const frames = decodeFrames(frameTableData)
              if (frames && frames.length <= MAX_SHARE_FRAME_ROWS) {
                // 合計は渡さない —— 受け取った表から数え直す（restoredFrameCounts）。
                restoreVideoFrames(result.id, frames, { ambiguous: parsed.ambiguousFrames })
                // タイムシートは表を戻せたときだけ戻す（打った位置は表の行なので、表が無いと意味を持たない）。
                // 表の外を指す行は落とす。失敗しても動画と表の取り込みは成立しているので、ここだけ諦める。
                if (parsed.timesheetData) {
                  try {
                    const marks = decodeTimesheet(parsed.timesheetData).filter((m) => m.frame < frames.length)
                    if (marks.length > 0) saveTimesheet(result.id, encodeTimesheet(marks))
                  } catch (err) {
                    console.warn(`[share:import] failed to restore timesheet: ${parsed.file}`, err)
                  }
                }
              } else {
                console.warn(`[share:import] ignored invalid frame table: ${parsed.file}`)
              }
            } catch (err) {
              console.warn(`[share:import] failed to restore frame table: ${parsed.file}`, err)
            }
          }
          count++
        } catch (err) {
          // **1 件の失敗で残り全部を巻き添えにしない。**
          //
          // ここに来るのは行の検証を抜けた後の想定外——保存先が満杯で年月フォルダを
          // 作れない、DB が書けない、といった経路。以前はこの catch が無く、例外は
          // ループごと抜けてハンドラの外まで飛んでいた。**900 枚目でつまずくと 901 枚目
          // 以降は取り込まれず、画面には「取り込みに失敗しました」しか出ない**——
          // 900 枚は実際に入っているのに、それが何枚なのか画面から読めなかった。
          //
          // この行を errors に積んで次へ進めば「◯枚を取り込みました（△枚は失敗）」に
          // なる。空きが尽きた場合は以降も全部失敗するが、**失敗した枚数がそのまま出る
          // 方が、途中で切れて枚数が消えるより読める。**
          //
          // 実体ファイルのコピーだけ済んで登録前に落ちた場合、そのファイルは残る
          // （どこまで進んだか catch からは分からないため、ここでは消さない）。
          console.error('[share:import] entry failed', err)
          errors.push(`import failed: ${entryFile ?? `line ${i + 1}`}`)
        } finally {
          if (shouldSend(i + 1)) sendToRenderer(CH.shareImportProgress, { current: i + 1, total })
        }
      }

      // 以前の版が書き出した settings.json（スマートフォルダ）は読まない（スマートフォルダは 2026-11-20 に消した）。
      return { canceled: shareImport.canceled, count, errors }
    })
  })

  handleTrusted(CH.shareImportCancel, () => { shareImport.cancel() })
}
