// ローカルインポート（クリップボード貼り付け・フォルダドロップ）の IPC ハンドラ。
import { clipboard, nativeImage } from 'electron'
import { stat, copyFile, writeFile, readdir } from 'fs/promises'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { handleTrusted } from './windows'
import { getImage } from './db'
import { ensureCaptureSubDir, thumbPathFor, resolveRealCapturePath } from './paths'
import { MAX_TEXT_LENGTH } from './ipc-validation'
import { isDragTempPath } from './ipc-drag'
import { createImageThumb } from './image-thumb'
import { CH } from '../shared/api'
import { registerCapturedMedia } from './captured-media'
import { beginTask, endTask } from './busy'

const IMPORT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMPORT_FILES = 200

// 上限到達で列挙を打ち切った場合、呼び出し元がユーザーに「一部のみ取り込んだ」と
// 伝えられるよう truncated を返す（200件超のドロップ・フォルダ展開の両方で判定）。
async function collectImportFiles(inputPaths: string[]): Promise<{ files: string[]; truncated: boolean }> {
  const result: string[] = []
  let truncated = false
  async function walk(p: string, depth: number): Promise<void> {
    if (result.length >= MAX_IMPORT_FILES) { truncated = true; return }
    let info: Awaited<ReturnType<typeof stat>>
    try { info = await stat(p) } catch { return }
    if (info.isDirectory()) {
      // 深い階層は無言でスキップせず truncated として計上する。件数上限と同じ扱いにすることで、
      // 「フォルダを落としたのに一部入っていない」原因が既存の truncated トーストで見えるようにする（BUG-7）。
      if (depth > 4) { truncated = true; return }
      let entries: string[]
      try { entries = await readdir(p) } catch { return }
      // readdir の順序は OS 依存。大量取り込みで上限200件に入るファイルや取り込み順が
      // 環境で変わらないよう、名前順に固定して再現性を持たせる。
      entries.sort()
      for (const name of entries) {
        if (result.length >= MAX_IMPORT_FILES) { truncated = true; break }
        await walk(join(p, name), depth + 1)
      }
    } else if (info.isFile()) {
      // フォルダ展開由来（depth>0）は拡張子未対応ファイル（サイドカーの .txt/.json 等）を数に
      // 入れない。数に入れると名前順で先に並ぶ非画像ファイルが MAX_IMPORT_FILES の枠を食い潰し、
      // 画像がほとんど取り込まれなくなるため。直接ドロップされた単体ファイル（depth===0）は
      // 従来どおり通し、後段のループで「unsupported extension」エラーとして案内する。
      if (depth === 0 || IMPORT_IMAGE_EXTS.has(extname(p).toLowerCase())) result.push(p)
    }
  }
  for (const p of inputPaths) {
    if (result.length >= MAX_IMPORT_FILES) { truncated = true; break }
    await walk(p, 0)
  }
  return { files: result, truncated }
}

export function registerImportHandlers(): void {
  handleTrusted(CH.clipboardPaste, async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return { ok: false, reason: 'empty' as const }

    const ts = Date.now()
    const dir = await ensureCaptureSubDir(ts)
    const uid = randomUUID()
    const destFile = join(dir, `cap_${ts}_${uid}.png`)
    await writeFile(destFile, img.toPNG())

    const thumbFile = thumbPathFor(destFile)
    let thumbOk = false
    try { await createImageThumb(destFile, thumbFile); thumbOk = true } catch (err) {
      console.warn('[clipboard:paste] createImageThumb failed', err)
    }

    const size = img.getSize()
    const result = await registerCapturedMedia({
      insert: {
        filepath: destFile,
        captured_at: ts,
        title: null,
        current_time: null,
        url: null,
        width: size.width || null,
        height: size.height || null,
        colors: null,
        memo: null,
        media_type: null,
        duration: null,
        thumb_path: thumbOk ? thumbFile : null,
        source: 'import',
      },
      filePath: destFile,
      thumbPath: thumbOk ? thumbFile : null,
      autoTag: { path: thumbOk ? thumbFile : destFile }
    })
    if (!result.ok) return { ok: false, reason: 'error' as const }

    return { ok: true, id: result.id }
  })

  handleTrusted(CH.clipboardCopyImage, async (_event, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return false
    const image = getImage(id)
    if (!image) return false
    const filePath = await resolveRealCapturePath(image.filepath)
    if (!filePath) return false
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return false
    clipboard.writeImage(img)
    return true
  })

  handleTrusted(CH.importFiles, async (_event, filePaths: unknown) => {
    if (!Array.isArray(filePaths)) return { count: 0, errors: ['invalid input'], truncated: false }

    // 大量ドロップは数分かかることがある。途中でアップデート適用（プロセス終了）が
    // 走ると取り込みが尻切れになるため、実行中であることを busy レジストリへ知らせる。
    beginTask('import')
    try {
      const inputPaths = (filePaths as unknown[])
        .filter((p): p is string => typeof p === 'string' && !!p)
        // Shiori からドラッグした画像を Shiori 自身へ落とし返したケース。取り込むと同じ画像が
        // 増えるだけなので黙って捨てる（ユーザーの意図としては「何も起きない」が正しい）。
        // errors にも積まない：ユーザーは失敗したのではなく、ただ元の場所に戻しただけ。
        .filter((p) => !isDragTempPath(p))
      const { files: expanded, truncated } = await collectImportFiles(inputPaths)

      let count = 0
      const errors: string[] = []

      for (const rawPath of expanded) {
        // createImageThumb（nativeImage）が同期実行のため、大量ドロップ中は
        // IPC/WS の応答が細切れに待たされる（P-3）。イベントループへ一度譲ることで緩和する。
        await new Promise<void>((resolve) => setImmediate(resolve))

        if (typeof rawPath !== 'string' || !rawPath) continue

        const ext = extname(rawPath).toLowerCase()
        // 本ビルドは画像専用。画像以外（動画含む）は取り込まない。
        if (!IMPORT_IMAGE_EXTS.has(ext)) { errors.push(`unsupported: ${basename(rawPath)}`); continue }

        let srcStat: Awaited<ReturnType<typeof stat>>
        try { srcStat = await stat(rawPath) } catch { errors.push(`not found: ${basename(rawPath)}`); continue }
        if (!srcStat.isFile()) { errors.push(`not a file: ${basename(rawPath)}`); continue }
        if (srcStat.size > 500 * 1024 * 1024) { errors.push(`too large: ${basename(rawPath)}`); continue }

        const uid = randomUUID()
        const ts = Date.now()
        // 元ファイルの更新日時を撮影日時として扱う（下の insertImage と揃える）ので、
        // 格納先サブフォルダもそれに合わせる。今日インポートした昔のファイルが
        // 全部「今月」フォルダに積み上がるのを防ぐ。
        const capturedAt = Math.floor(srcStat.mtimeMs) || ts
        const dir = await ensureCaptureSubDir(capturedAt)
        const destFile = join(dir, `cap_${ts}_${uid}${ext}`)

        try { await copyFile(rawPath, destFile) } catch { errors.push(`copy failed: ${basename(rawPath)}`); continue }

        let width: number | null = null
        let height: number | null = null
        let thumbFile: string | null = null
        try {
          const size = nativeImage.createFromPath(destFile).getSize()
          if (size.width > 0 && size.height > 0) { width = size.width; height = size.height }
        } catch { /* best effort */ }
        const tf = thumbPathFor(destFile)
        try { await createImageThumb(destFile, tf); thumbFile = tf } catch (err) {
          console.warn('[import] createImageThumb failed', err)
        }

        const rawName = basename(rawPath, ext)
        const title = rawName.length > 0 ? rawName.slice(0, MAX_TEXT_LENGTH) : null

        const result = await registerCapturedMedia({
          insert: {
            filepath: destFile,
            captured_at: capturedAt,
            title,
            current_time: null,
            url: null,
            width,
            height,
            colors: null,
            memo: null,
            media_type: null,
            duration: null,
            thumb_path: thumbFile,
            source: 'import',
          },
          filePath: destFile,
          thumbPath: thumbFile,
          autoTag: { path: thumbFile ?? destFile }
        })
        if (!result.ok) {
          errors.push(`insert failed: ${basename(rawPath)}`)
          continue
        }

        count++
      }

      return { count, errors, truncated }
    } finally {
      endTask('import')
    }
  })
}
