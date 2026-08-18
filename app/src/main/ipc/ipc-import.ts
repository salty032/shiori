// ローカルインポート（クリップボード貼り付け・フォルダドロップ）の IPC ハンドラ。
import { clipboard, nativeImage } from 'electron'
import { stat, copyFile, writeFile, readdir, unlink } from 'fs/promises'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { handleTrusted } from '../system/windows'
import { getImage } from '../db'
import { ensureCaptureSubDir, thumbPathFor, resolveRealCapturePath } from '../system/paths'
import { MAX_TEXT_LENGTH } from './ipc-validation'
import { isDragTempPath } from './ipc-drag'
import { createImageThumb } from '../capture/image-thumb'
import { getVideoThumbProvider } from '../capture/video-thumb-provider'
import { CH } from '../../shared/api'
import { registerCapturedMedia } from '../capture/captured-media'
import { beginTask, endTask } from '../system/busy'

const IMPORT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
// nativeImage が確実にデコードできる形式（Electron が対応を明記しているのは PNG / JPEG のみ）。
// この範囲では「寸法もサムネも取れない＝中身が画像ではない」と断定できるので取り込みを失敗にする。
// webp / gif を含めてはいけない：nativeImage は読めなくても表示は Chromium が行う（サムネが
// 無い行は原本を直接表示する）ため、正常なファイルを弾いてしまう。
const DECODABLE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg'])
const IMPORT_VIDEO_EXTS = new Set(['.webm', '.mp4'])
const MAX_IMPORT_FILES = 200
// インポート動画の尺上限（秒）。録画クリップの上限と同じく著作権対策の割り切りで、
// 設定でも緩和しない固定値。フルエピソードの取り込みを構造的に防ぐ。長尺トリマーの
// 全フレームデコード待ち（U-1）もこの上限内なら実用的な時間で収まる。
export const MAX_IMPORT_VIDEO_SECONDS = 30
// 尺の丸め誤差で 30.0x 秒の動画を弾かないための許容幅。
export const IMPORT_VIDEO_SECONDS_EPS = 0.5

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
      // 入れない。数に入れると名前順で先に並ぶ画像/動画以外のファイルが MAX_IMPORT_FILES の枠を
      // 食い潰し、対応ファイルがほとんど取り込まれなくなるため。直接ドロップされた単体ファイル
      // （depth===0）は従来どおり通し、後段のループで「unsupported extension」エラーとして案内する。
      const ext = extname(p).toLowerCase()
      if (depth === 0 || IMPORT_IMAGE_EXTS.has(ext) || IMPORT_VIDEO_EXTS.has(ext)) result.push(p)
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
        media_type: 'image',
        duration: null,
        fps: null,
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
    if (!image || image.media_type === 'video') return false
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
        const isImage = IMPORT_IMAGE_EXTS.has(ext)
        const isVideo = IMPORT_VIDEO_EXTS.has(ext)
        if (!isImage && !isVideo) { errors.push(`unsupported: ${basename(rawPath)}`); continue }

        let srcStat: Awaited<ReturnType<typeof stat>>
        try { srcStat = await stat(rawPath) } catch { errors.push(`not found: ${basename(rawPath)}`); continue }
        if (!srcStat.isFile()) { errors.push(`not a file: ${basename(rawPath)}`); continue }
        if (srcStat.size > 500 * 1024 * 1024) { errors.push(`too large: ${basename(rawPath)}`); continue }

        // 動画は尺上限を超えるものを取り込まない（著作権対策）。コピー前に元ファイルで判定し、
        // 超過・判定不能なら無駄なコピーもせず弾く。判定不能を許すと長尺のすり抜け余地が
        // 残るため、尺を取れなかった動画も弾く（正常な短尺がまれに巻き添えになる割り切り）。
        let importedDuration: number | null = null
        let importedFps: number | null = null
        if (isVideo) {
          try {
            const meta = await getVideoThumbProvider().getVideoMeta(rawPath)
            importedDuration = meta.duration
            importedFps = meta.fps
          } catch { importedDuration = null }
          if (importedDuration == null) { errors.push(`duration unknown: ${basename(rawPath)}`); continue }
          if (importedDuration > MAX_IMPORT_VIDEO_SECONDS + IMPORT_VIDEO_SECONDS_EPS) {
            errors.push(`too long (${Math.round(importedDuration)}s > ${MAX_IMPORT_VIDEO_SECONDS}s): ${basename(rawPath)}`)
            continue
          }
        }

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
        let duration: number | null = null
        let fps: number | null = null
        if (isImage) {
          try {
            const size = nativeImage.createFromPath(destFile).getSize()
            if (size.width > 0 && size.height > 0) { width = size.width; height = size.height }
          } catch { /* best effort */ }
          const tf = thumbPathFor(destFile)
          try { await createImageThumb(destFile, tf); thumbFile = tf } catch (err) {
            console.warn('[import] createImageThumb failed', err)
          }
          // 動画は尺を取れないものを弾いているのに、画像は拡張子だけで通していた。
          // 中身が画像でないファイル（拡張子だけ .png に変えたもの・転送で壊れたもの）が
          // 「取り込み ○件」に数えられたまま、開けない項目としてライブラリに残る。
          // 寸法もサムネも取れなければコピーを消して失敗として返す。
          if (DECODABLE_IMAGE_EXTS.has(ext) && width === null && thumbFile === null) {
            await unlink(destFile).catch(() => {})
            errors.push(`not a valid image: ${basename(rawPath)}`)
            continue
          }
        } else {
          const tf = thumbPathFor(destFile, '.png')
          try { await getVideoThumbProvider().extractThumb(destFile, tf); thumbFile = tf } catch (err) {
            console.warn('[import] extractThumb failed', err)
          }
          // 尺・fps はコピー前に元ファイルで判定済み（上の尺上限チェック）。再プローブしない。
          duration = importedDuration
          fps = importedFps
        }

        const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image'
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
            media_type: mediaType,
            duration,
            fps,
            thumb_path: thumbFile,
            source: 'import',
          },
          filePath: destFile,
          thumbPath: thumbFile,
          autoTag: isImage ? { path: thumbFile ?? destFile } : null
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
