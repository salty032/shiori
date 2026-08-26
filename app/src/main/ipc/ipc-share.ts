// 一括共有（ライブラリ全体のエクスポート / インポート / スマートフォルダ設定の取り込み）の IPC ハンドラ。
import { dialog } from 'electron'
import { stat, copyFile, mkdir, readFile, writeFile, unlink } from 'fs/promises'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { getMainWindow, handleTrusted, sendToRenderer, safeExternalUrl } from '../system/windows'
import { listImagesForExport } from '../db'
import { decodeFrames, encodeFrames, getVideoFrames, restoreVideoFrames } from '../db-video-frames'
import { loadSettings, saveSettings, smartFolders } from '../system/settings'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbnailDir, thumbPathFor } from '../system/paths'
import { formatDateForFilename, uniqueExportFilename } from './ipc-validation'
import { CH } from '../../shared/api'
import { MAX_SHARE_FRAME_TABLE_BYTES, parseShareEntry } from './share-entry'
import { getVideoThumbProvider } from '../capture/video-thumb-provider'
import { MAX_IMPORT_VIDEO_SECONDS, IMPORT_VIDEO_SECONDS_EPS } from './ipc-import'
import { registerCapturedMedia } from '../capture/captured-media'
import { createProgressThrottle } from '../system/progress-throttle'
import { beginTask, endTask } from '../system/busy'
import { t } from '../system/i18n'

let isShareExporting = false
let isShareExportCanceled = false
let isShareImporting = false
let isShareImportCanceled = false
const MAX_SHARE_METADATA_BYTES = 64 * 1024 * 1024
const MAX_SHARE_SETTINGS_BYTES = 1024 * 1024
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

export function registerShareHandlers(): void {
  handleTrusted(CH.shareExport, async () => {
    // images:export と同じ理由（R-5）: renderer 側ガードだけでは並行実行を防げず、
    // isShareExportCanceled が単一フラグなので混線しうる。
    if (isShareExporting) return { canceled: true }
    isShareExporting = true
    beginTask('export')
    try {
      // 親ウィンドウ未指定だとモーダル化されず背面に隠れうる（BUG-3）。
      const exportWin = getMainWindow()
      const exportDialogOptions: Electron.OpenDialogOptions = { title: t('dialog.exportFolder'), properties: ['openDirectory'] }
      const { canceled, filePaths } = exportWin
        ? await dialog.showOpenDialog(exportWin, exportDialogOptions)
        : await dialog.showOpenDialog(exportDialogOptions)
      if (canceled || !filePaths[0]) return { canceled: true }
      isShareExportCanceled = false

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
        return JSON.stringify({
          version: 2,
          file: filename,
          ...(thumbFilename ? { thumb: thumbFilename } : {}),
          url: item.url,
          current_time: item.current_time,
          title: item.title,
          tags: item.manualTags,
          memo: item.memo,
          // 書き出すのは自分で撮った素材だけ（listImagesForExport が source='capture' に絞る）
          // なので、ここの captured_at は常に自分が撮った時刻。取り込んだ素材の
          // original_captured_at がここへ回ることは無い。
          captured_at: item.captured_at,
          ...(item.width != null ? { width: item.width } : {}),
          ...(item.height != null ? { height: item.height } : {}),
          ...(item.media_type === 'video' ? {
            media_type: 'video',
            duration: item.duration,
            fps: item.fps,
            ...(frameTableFile ? { frame_table_file: frameTableFile } : {}),
            ambiguous_frames: item.ambiguous_frames ?? null,
            unreported_frames: item.unreported_frames ?? null,
          } : {}),
        })
      }
      const lines: string[] = []
      let count = 0
      const total = items.length
      sendToRenderer(CH.exportProgress, { current: 0, total })
      const shouldSend = createProgressThrottle(total)

      for (let i = 0; i < items.length; i++) {
        if (isShareExportCanceled) break
        const line = await copyOne(items[i])
        if (line) { lines.push(line); count++ }
        if (shouldSend(i + 1)) sendToRenderer(CH.exportProgress, { current: i + 1, total })
      }

      // 中断時も、それまでコピー済みの分だけで metadata.jsonl / settings.json を書き出す
      // （途中までの書き出し結果をそのまま share:import で読み込める状態にしておく）。
      await writeFile(join(destDir, 'metadata.jsonl'), lines.join('\n'), 'utf-8')

      // スマートフォルダのみを共有用に書き出す（ホットキー・ToS同意・個人UI設定は含めない）
      const current = loadSettings()
      await writeFile(
        join(destDir, 'settings.json'),
        JSON.stringify({ version: 1, smartFolders: current.smartFolders }, null, 2),
        'utf-8'
      )

      return { canceled: isShareExportCanceled, count, path: destDir }
    } finally {
      isShareExporting = false
      endTask('export')
    }
  })

  handleTrusted(CH.shareExportCancel, () => { isShareExportCanceled = true })

  handleTrusted(CH.shareImport, async () => {
    // shareExport/imagesExport と同じ理由（R-5）: renderer 側のボタン disable だけでは
    // 並行呼び出しを防げず、同じフォルダの画像が二重登録されうる（画像には重複チェックが
    // ないため、スマートフォルダと違って静かに重複が積み上がる）（D-1）。
    if (isShareImporting) return { canceled: true }
    isShareImporting = true
    beginTask('import')
    try {
      // 親ウィンドウ未指定だとモーダル化されず背面に隠れうる（BUG-3）。
      const importWin = getMainWindow()
      const importDialogOptions: Electron.OpenDialogOptions = { title: t('dialog.importFolder'), properties: ['openDirectory'] }
      const { canceled, filePaths } = importWin
        ? await dialog.showOpenDialog(importWin, importDialogOptions)
        : await dialog.showOpenDialog(importDialogOptions)
      if (canceled || !filePaths[0]) return { canceled: true }
      isShareImportCanceled = false

      const srcDir = filePaths[0]
      let content: string
      try {
        const metadataPath = join(srcDir, 'metadata.jsonl')
        const metadataStat = await stat(metadataPath)
        if (!metadataStat.isFile() || metadataStat.size > MAX_SHARE_METADATA_BYTES) {
          return { canceled: false, count: 0, errors: [t('error.metadataTooLarge')] }
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
        if (isShareImportCanceled) break
        try {
          const line = lines[i]
          const parsed = parseShareEntry(line, Date.now())
          if (parsed === null) continue
          if ('error' in parsed) { errors.push(parsed.error); continue }

          const srcFile = join(srcDir, 'images', parsed.file)
          let srcStat: Awaited<ReturnType<typeof stat>>
          try { srcStat = await stat(srcFile) } catch { errors.push(`file not found: ${parsed.file}`); continue }
          if (srcStat.size > 500 * 1024 * 1024) { errors.push(`file too large: ${parsed.file}`); continue }

          const uid = randomUUID()
          const ts = Date.now()
          const dir = await ensureCaptureSubDir(parsed.capturedAt)
          const destFile = join(dir, `cap_${ts}_${uid}${parsed.ext}`)

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
              try { await getVideoThumbProvider().extractThumb(destFile, tf); thumbDest = tf } catch (err) {
                console.warn('[share:import] extractThumb failed', err)
              }
            }
            try {
              const meta = await getVideoThumbProvider().getVideoMeta(destFile)
              duration = meta.duration
              // duration が実体不一致で再取得されるのに対し、fps はバンドル値が検証済みなら
              // 優先する。バンドルに無ければ実体からの値で補う。
              if (fps == null) fps = meta.fps
            } catch (err) {
              console.warn('[share:import] getVideoMeta failed', err)
            }
            // 通常のファイル取り込み（ipc-import.ts）と同じ尺上限を適用する。ここを素通りさせると
            // metadata.jsonl を手編集した共有バンドル経由で著作権対策の30秒上限を回避できてしまう。
            if (duration == null || duration > MAX_IMPORT_VIDEO_SECONDS + IMPORT_VIDEO_SECONDS_EPS) {
              errors.push(duration == null
                ? `duration unknown: ${parsed.file}`
                : `too long (${Math.round(duration)}s > ${MAX_IMPORT_VIDEO_SECONDS}s): ${parsed.file}`)
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
              colors: null,
              memo: parsed.memo,
              media_type: parsed.mediaType,
              duration,
              fps,
              thumb_path: thumbDest,
              source: 'import',
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
              } else {
                console.warn(`[share:import] ignored invalid frame table: ${parsed.file}`)
              }
            } catch (err) {
              console.warn(`[share:import] failed to restore frame table: ${parsed.file}`, err)
            }
          }
          count++
        } finally {
          if (shouldSend(i + 1)) sendToRenderer(CH.shareImportProgress, { current: i + 1, total })
        }
      }

      // settings.json（スマートフォルダのみ）は任意。無くても画像取り込みには影響しない。
      // 名前が完全一致する既存フォルダはスキップし、それ以外は id を採番し直して追記する
      // （エクスポート元とインポート先で id が衝突しうるため）。
      let importedFolders = 0
      if (!isShareImportCanceled) {
        try {
          const settingsPath = join(srcDir, 'settings.json')
          const settingsStat = await stat(settingsPath)
          if (!settingsStat.isFile() || settingsStat.size > MAX_SHARE_SETTINGS_BYTES) {
            errors.push(t('error.settingsTooLarge'))
          } else {
            const settingsRaw = await readFile(settingsPath, 'utf-8')
            const parsed = JSON.parse(settingsRaw) as { smartFolders?: unknown }
            const incoming = smartFolders(parsed?.smartFolders)
            if (incoming.length > 0) {
              const current = loadSettings()
              const existingNames = new Set(current.smartFolders.map((f) => f.name))
              const ts = Date.now()
              const toAdd = incoming
                .filter((f) => !existingNames.has(f.name))
                .map((f, i) => ({ ...f, id: `import-${ts}-${i}` }))
              if (toAdd.length > 0) {
                saveSettings({ ...current, smartFolders: [...current.smartFolders, ...toAdd] })
                importedFolders = toAdd.length
              }
            }
          }
        } catch { /* settings.json が無い/壊れている場合は静かに無視 */ }
      }

      return { canceled: isShareImportCanceled, count, errors, importedFolders }
    } finally {
      isShareImporting = false
      endTask('import')
    }
  })

  handleTrusted(CH.shareImportCancel, () => { isShareImportCanceled = true })
}
