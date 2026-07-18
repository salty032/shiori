// 動画クリップのフレーム PTS 取得・トリミング（再エンコード）の IPC ハンドラ。
import { unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { handleTrusted } from '../windows'
import { getImage, getImageTags } from '../db'
import { optionalPositiveInteger } from '../ipc-validation'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbPathFor } from '../paths'
import { trimWebm, extractThumb, getVideoFramePts, getTimelineStrip, getVideoDuration } from './ffmpeg'
import { VIDEO_CH } from '../../shared/api.video'
import { registerCapturedMedia } from '../captured-media'

// トリミング処理中の imageId 集合（多重トリミング防止）
const trimmingIds = new Set<number>()

export function registerVideoHandlers(): void {
  handleTrusted(VIDEO_CH.videoGetFramePts, async (_event, imageId: number) => {
    const validId = optionalPositiveInteger(imageId)
    if (!validId) return []
    const image = getImage(validId)
    if (!image || image.media_type !== 'video') return []
    try {
      const realPath = await resolveRealCapturePath(image.filepath)
      if (!realPath) return []
      return await getVideoFramePts(realPath)
    } catch { return [] }
  })

  handleTrusted(VIDEO_CH.videoGetTimelineStrip, async (_event, imageId: number, count: number) => {
    const validId = optionalPositiveInteger(imageId)
    if (!validId) return null
    const validCount = optionalPositiveInteger(count)
    if (!validCount || validCount > 30) return null
    const image = getImage(validId)
    if (!image || image.media_type !== 'video') return null
    try {
      const realPath = await resolveRealCapturePath(image.filepath)
      if (!realPath) return null
      const duration = image.duration || await getVideoDuration(realPath)
      if (!duration) return null
      const strip = await getTimelineStrip(realPath, duration, validCount)
      return strip.toString('base64')
    } catch { return null }
  })

  handleTrusted(VIDEO_CH.videoTrim, async (_event, imageId: number, inSec: number, outSec: number) => {
    const validId = optionalPositiveInteger(imageId)
    if (!validId) return { ok: false, error: 'invalid_id' }
    if (typeof inSec !== 'number' || !Number.isFinite(inSec) || inSec < 0)
      return { ok: false, error: 'invalid_in' }
    if (typeof outSec !== 'number' || !Number.isFinite(outSec) || outSec <= inSec || outSec - inSec < 0.1)
      return { ok: false, error: 'invalid_out' }
    if (trimmingIds.has(validId)) return { ok: false, error: 'already_trimming' }

    const image = getImage(validId)
    if (!image || image.media_type !== 'video') return { ok: false, error: 'not_found' }
    if (image.duration != null && outSec > image.duration + 0.1)
      return { ok: false, error: 'invalid_out' }

    let realPath: string
    try {
      const resolved = await resolveRealCapturePath(image.filepath)
      if (!resolved) return { ok: false, error: 'path_error' }
      realPath = resolved
    } catch { return { ok: false, error: 'path_error' } }

    const ts = Date.now()
    const dir = await ensureCaptureSubDir(ts)
    const uid = randomUUID()
    const webmOut = join(dir, `cap_${ts}_${uid}.webm`)
    // サムネは原本（captureDir）と分離して thumbnailDir 配下に置く（アプリ全体の規約）。
    // ここで captureDir に直接書くと分離が崩れ、migrate-thumbnails も再実行しないため残り続ける。
    const thumbOut = thumbPathFor(webmOut, '.png')

    trimmingIds.add(validId)
    try {
      await trimWebm(realPath, webmOut, inSec, outSec)

      // サムネ生成はベストエフォート。録画保存（recorder-ipc.ts）と同様に、失敗しても
      // トリム本体（webmOut）は破棄せずサムネなしで登録を続ける。
      let thumbSaved: string | null = null
      try {
        await extractThumb(webmOut, thumbOut)
        thumbSaved = thumbOut
      } catch (err) {
        console.warn('[video:trim] extractThumb failed, proceeding without thumb', err)
      }

      const originalTags = getImageTags(validId)
      const manualTags = originalTags.filter((t) => t.source === 'manual')

      const result = await registerCapturedMedia({
        insert: {
          filepath: webmOut,
          captured_at: ts,
          title: image.title,
          current_time: image.current_time != null ? image.current_time + inSec : null,
          url: image.url,
          width: null,
          height: null,
          colors: null,
          memo: null,
          media_type: 'video',
          duration: outSec - inSec,
          thumb_path: thumbSaved,
          source: image.source
        },
        filePath: webmOut,
        thumbPath: thumbSaved,
        extraTags: manualTags,
        autoTag: thumbSaved ? { path: thumbSaved } : null
      })
      if (!result.ok) {
        return { ok: false, error: String(result.error instanceof Error ? result.error.message : result.error).slice(0, 200) }
      }

      return { ok: true, newId: result.id }
    } catch (err) {
      console.error('[video:trim] failed', err)
      try { await unlink(webmOut) } catch {}
      try { await unlink(thumbOut) } catch {}
      return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) }
    } finally {
      trimmingIds.delete(validId)
    }
  })
}
