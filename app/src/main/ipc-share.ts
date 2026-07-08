// 一括共有（ライブラリ全体のエクスポート / インポート / スマートフォルダ設定の取り込み）の IPC ハンドラ。
import { dialog } from 'electron'
import { stat, copyFile, mkdir, readFile, writeFile, unlink } from 'fs/promises'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { handleTrusted, sendToRenderer, safeExternalUrl } from './windows'
import { listImagesForExport } from './db'
import { loadSettings, saveSettings, smartFolders } from './settings'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbnailDir, thumbPathFor } from './paths'
import { MAX_EXPORT_IDS, MAX_TEXT_LENGTH, MAX_TAG_LENGTH, normalizeTagName, formatDateForFilename, uniqueExportFilename } from './ipc-validation'
import { CH } from '../shared/api'
import { registerCapturedMedia } from './captured-media'
import { createProgressThrottle } from './progress-throttle'

const SHARE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
// 手編集・破損した metadata.jsonl の captured_at で異常値（負値・極端な未来値等）を受け入れると、
// ensureCaptureSubDir が "NaN-NaN" 等の壊れたフォルダ名を作ったり、一覧の並び順が恒久的に
// 壊れたりする。妥当な epoch 範囲（0〜2100年）にクランプし、範囲外は取り込み時刻にフォールバックする。
const MAX_REASONABLE_CAPTURED_AT = new Date(2100, 0, 1).getTime()
function isValidCapturedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < MAX_REASONABLE_CAPTURED_AT
}

let isShareExportCanceled = false

export function registerShareHandlers(): void {
  handleTrusted(CH.shareExport, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'エクスポート先フォルダを選択',
      properties: ['openDirectory']
    })
    if (canceled || !filePaths[0]) return { canceled: true }
    isShareExportCanceled = false

    const destDir = join(filePaths[0], `shiori_export_${formatDateForFilename(Date.now())}`)
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
  })

  handleTrusted(CH.shareExportCancel, () => { isShareExportCanceled = true })

  handleTrusted(CH.shareImport, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'インポートするフォルダを選択',
      properties: ['openDirectory']
    })
    if (canceled || !filePaths[0]) return { canceled: true }

    const srcDir = filePaths[0]
    let content: string
    try {
      content = await readFile(join(srcDir, 'metadata.jsonl'), 'utf-8')
    } catch {
      return { canceled: false, count: 0, errors: ['metadata.jsonl が見つかりません'] }
    }

    let count = 0
    const errors: string[] = []
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, MAX_EXPORT_IDS)

    for (const line of lines) {
      let entry: { version?: number; file?: unknown; thumb?: unknown; url?: unknown; current_time?: unknown; title?: unknown; tags?: unknown; memo?: unknown; captured_at?: unknown }
      try { entry = JSON.parse(line) } catch { errors.push(`invalid JSON: ${line.slice(0, 50)}`); continue }

      if (typeof entry.file !== 'string' || !entry.file) continue
      const safeFile = basename(entry.file)
      if (!safeFile || safeFile !== entry.file) { errors.push(`unsafe filename: ${entry.file}`); continue }

      const ext = extname(safeFile).toLowerCase()
      // 本ビルドは画像専用。動画エントリを含む共有バンドルを読み込んでも動画は取り込まない。
      if (!SHARE_IMAGE_EXTS.has(ext)) { errors.push(`unsupported extension: ${safeFile}`); continue }

      const srcFile = join(srcDir, 'images', safeFile)
      let srcStat: Awaited<ReturnType<typeof stat>>
      try { srcStat = await stat(srcFile) } catch { errors.push(`file not found: ${safeFile}`); continue }
      if (srcStat.size > 500 * 1024 * 1024) { errors.push(`file too large: ${safeFile}`); continue }

      const uid = randomUUID()
      const ts = Date.now()
      const capturedAt = isValidCapturedAt(entry.captured_at) ? entry.captured_at : ts
      const dir = await ensureCaptureSubDir(capturedAt)
      const destFile = join(dir, `cap_${ts}_${uid}${ext}`)

      let thumbDest: string | null = null
      if (typeof entry.thumb === 'string' && entry.thumb) {
        const safeThumb = basename(entry.thumb)
        if (safeThumb && safeThumb === entry.thumb) {
          const srcThumb = join(srcDir, 'images', safeThumb)
          try {
            await stat(srcThumb)
            const thumbExt = extname(safeThumb).toLowerCase() || '.png'
            if (!SHARE_IMAGE_EXTS.has(thumbExt)) throw new Error('unsupported thumb extension')
            thumbDest = thumbPathFor(destFile, thumbExt)
            await mkdir(thumbnailDir(), { recursive: true })
            await copyFile(srcThumb, thumbDest)
          } catch { /* skip missing thumb */ }
        }
      }

      try {
        await copyFile(srcFile, destFile)
      } catch (err) {
        errors.push(`copy failed: ${safeFile}`)
        if (thumbDest) try { await unlink(thumbDest) } catch {}
        continue
      }

      // 手動タグ追加と同じ正規化（小文字化・空白→_）を通す。ここを素通しすると、
      // 自前編集された共有データから "Tag Name" のような表記ゆれタグが作られてしまう。
      const tags = Array.isArray(entry.tags)
        ? [...new Set((entry.tags as unknown[]).map((t) => normalizeTagName(t, MAX_TAG_LENGTH)).filter((t): t is string => t != null))]
        : []

      const result = await registerCapturedMedia({
        insert: {
          filepath: destFile,
          captured_at: capturedAt,
          title: typeof entry.title === 'string' ? entry.title.slice(0, MAX_TEXT_LENGTH) || null : null,
          current_time: typeof entry.current_time === 'number' && Number.isFinite(entry.current_time) ? entry.current_time : null,
          url: typeof entry.url === 'string' ? safeExternalUrl(entry.url) : null,
          width: null,
          height: null,
          colors: null,
          memo: typeof entry.memo === 'string' ? entry.memo.slice(0, 5000) || null : null,
          thumb_path: thumbDest,
          source: 'import',
        },
        filePath: destFile,
        thumbPath: thumbDest,
        extraTags: tags.length > 0 ? tags.map((name) => ({ name, source: 'manual' as const })) : undefined,
        broadcastCaptureDone: false,
        autoTag: null
      })
      if (!result.ok) {
        errors.push(`insert failed: ${safeFile}`)
        continue
      }
      count++
    }

    // settings.json（スマートフォルダのみ）は任意。無くても画像取り込みには影響しない。
    // 名前が完全一致する既存フォルダはスキップし、それ以外は id を採番し直して追記する
    // （エクスポート元とインポート先で id が衝突しうるため）。
    let importedFolders = 0
    try {
      const settingsRaw = await readFile(join(srcDir, 'settings.json'), 'utf-8')
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
    } catch { /* settings.json が無い/壊れている場合は静かに無視 */ }

    return { canceled: false, count, errors, importedFolders }
  })
}
