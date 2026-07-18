// 一括共有（ライブラリ全体のエクスポート / インポート / スマートフォルダ設定の取り込み）の IPC ハンドラ。
import { dialog } from 'electron'
import { stat, copyFile, mkdir, readFile, writeFile, unlink } from 'fs/promises'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { getMainWindow, handleTrusted, sendToRenderer, safeExternalUrl } from './windows'
import { listImagesForExport } from './db'
import { loadSettings, saveSettings, smartFolders } from './settings'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbnailDir, thumbPathFor } from './paths'
import { formatDateForFilename, uniqueExportFilename } from './ipc-validation'
import { CH } from '../shared/api'
import { parseShareEntry } from './share-entry'
import { getVideoThumbProvider } from './video-thumb-provider'
import { registerCapturedMedia } from './captured-media'
import { createProgressThrottle } from './progress-throttle'
import { beginTask, endTask } from './busy'

let isShareExporting = false
let isShareExportCanceled = false
let isShareImporting = false
let isShareImportCanceled = false
const MAX_SHARE_METADATA_BYTES = 64 * 1024 * 1024
const MAX_SHARE_SETTINGS_BYTES = 1024 * 1024

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
      const exportDialogOptions: Electron.OpenDialogOptions = { title: '書き出し先フォルダを選択', properties: ['openDirectory'] }
      const { canceled, filePaths } = exportWin
        ? await dialog.showOpenDialog(exportWin, exportDialogOptions)
        : await dialog.showOpenDialog(exportDialogOptions)
      if (canceled || !filePaths[0]) return { canceled: true }
      isShareExportCanceled = false

      const destDir = await createUniqueExportDir(filePaths[0], Date.now())
      const imagesDir = join(destDir, 'images')
      await mkdir(imagesDir, { recursive: true })

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

        return JSON.stringify({
          version: 1,
          file: filename,
          ...(thumbFilename ? { thumb: thumbFilename } : {}),
          url: item.url,
          current_time: item.current_time,
          title: item.title,
          tags: item.manualTags,
          memo: item.memo,
          captured_at: item.captured_at,
          ...(item.media_type === 'video' ? { media_type: 'video', duration: item.duration } : {}),
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
      const importDialogOptions: Electron.OpenDialogOptions = { title: '読み込むフォルダを選択', properties: ['openDirectory'] }
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
          return { canceled: false, count: 0, errors: ['metadata.jsonl が大きすぎます（上限64MB）'] }
        }
        content = await readFile(metadataPath, 'utf-8')
      } catch {
        return { canceled: false, count: 0, errors: ['metadata.jsonl が見つかりません'] }
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
            try { duration = await getVideoThumbProvider().getVideoDuration(destFile) } catch (err) {
              console.warn('[share:import] getVideoDuration failed', err)
            }
          }

          const result = await registerCapturedMedia({
            insert: {
              filepath: destFile,
              captured_at: parsed.capturedAt,
              title: parsed.title,
              current_time: parsed.currentTime,
              url: parsed.url ? safeExternalUrl(parsed.url) : null,
              width: null,
              height: null,
              colors: null,
              memo: parsed.memo,
              media_type: parsed.mediaType,
              duration,
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
            errors.push('settings.json が大きすぎます（上限1MB）')
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
