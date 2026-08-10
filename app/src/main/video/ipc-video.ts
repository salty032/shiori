// 動画クリップのフレーム PTS 取得・トリミング（再エンコード）の IPC ハンドラ。
import { unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { handleTrusted } from '../windows'
import { getImage, getImageTags, getVideoFrames, saveVideoFrames, setUncapturedFrames } from '../db'
import { optionalPositiveInteger } from '../ipc-validation'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbPathFor } from '../paths'
import { trimWebm, extractThumb, getVideoFramePts, getTimelineStrip, getVideoDuration } from './ffmpeg'
import { VIDEO_CH } from '../../shared/api.video'
import { registerCapturedMedia } from '../captured-media'
import { sliceFrameTable } from './frame-feed'
import { verifyClipFrames } from './verify-clip'

// トリミング処理中の imageId 集合（多重トリミング防止）
const trimmingIds = new Set<number>()

// フレーム PTS のキャッシュ（V-13）。同じ動画のトリマーを開き直すたびに全フレームを
// デコードする getVideoFramePts が再実行されるのを避ける。imageId 単位でキーする——
// 画像テーブルは AUTOINCREMENT で id を再利用せず、ある imageId のファイル内容は不変
// （トリムは新しい id を作る）なので、id をキーにすれば誤ヒットしない。
// 上限付き LRU（Map は挿入順を保持するので、先頭が最も古いアクセス）。
const framePtsCache = new Map<number, number[]>()
const FRAME_PTS_CACHE_MAX = 24

function getCachedFramePts(id: number): number[] | undefined {
  const hit = framePtsCache.get(id)
  if (hit) {
    framePtsCache.delete(id)   // アクセスしたものを末尾（最新）へ回す
    framePtsCache.set(id, hit)
  }
  return hit
}

function setCachedFramePts(id: number, pts: number[]): void {
  framePtsCache.delete(id)
  framePtsCache.set(id, pts)
  while (framePtsCache.size > FRAME_PTS_CACHE_MAX) {
    const oldest = framePtsCache.keys().next().value
    if (oldest === undefined) break
    framePtsCache.delete(oldest)
  }
}

export function registerVideoHandlers(): void {
  handleTrusted(VIDEO_CH.videoGetFramePts, async (_event, imageId: number) => {
    const validId = optionalPositiveInteger(imageId)
    if (!validId) return []
    const image = getImage(validId)
    if (!image || image.media_type !== 'video') return []
    const cached = getCachedFramePts(validId)
    if (cached) return cached
    try {
      const realPath = await resolveRealCapturePath(image.filepath)
      if (!realPath) return []
      const pts = await getVideoFramePts(realPath)
      if (pts.length === 0) return []   // 失敗・タイムアウトはキャッシュせず再取得の余地を残す

      // フレーム表があれば、素材のコマ単位の並びへ差し替える。
      //
      // ファイルのフレームをそのまま辿ると、画面キャプチャが吐いた枚数（実測 33〜37枚/秒）
      // でコマ送りすることになり、素材のコマ（23.976fps 等）とは対応しない。表があれば
      // 「素材のコマ N が写っているフレーム」の PTS だけを、素材の順で並べ直せる。
      // 撮れなかったコマは直前と同じ PTS になり、絵が変わらないまま1コマ進む。
      const table = getVideoFrames(validId)
      const sourcePts = table
        ?.filter((f) => f.frameIndex >= 0 && f.frameIndex < pts.length)
        .map((f) => pts[f.frameIndex])
      const result = sourcePts && sourcePts.length > 0 ? sourcePts : pts

      setCachedFramePts(validId, result)
      return result
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

    let realPath: string
    try {
      const resolved = await resolveRealCapturePath(image.filepath)
      if (!resolved) return { ok: false, error: 'path_error' }
      realPath = resolved
    } catch { return { ok: false, error: 'path_error' } }

    // outSec の上限検証。DB の duration が null（インポート時に ffmpeg の尺取得失敗）でも
    // ここで実ファイルから取り直して弾く。取得できなければ ffmpeg が末尾で打ち切るだけで
    // 実害は小さいため、検証をスキップして続行する。
    let duration = image.duration
    if (duration == null) {
      try { duration = await getVideoDuration(realPath) } catch { duration = null }
    }
    if (duration != null && outSec > duration + 0.1)
      return { ok: false, error: 'invalid_out' }

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
          // トリムは切り出すだけでフレームレートは変わらないので、元クリップの実測値を
          // そのまま引き継ぐ（ここを引き継がないと、トリムした瞬間に fps 表示が消える）。
          fps: image.fps,
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

      // フレーム表を切り出して引き継ぐ。これをやらないとトリムした瞬間にコマ送りが
      // 素材のコマから外れる（切り出した箇所こそ細かく見たいはずなので致命的）。
      // 失敗してもトリム自体は成立するため、ベストエフォートで進める。
      try {
        const table = getVideoFrames(validId)
        if (table && table.length > 0) {
          const [originalPts, trimmedPts] = await Promise.all([
            getVideoFramePts(realPath),
            getVideoFramePts(webmOut)
          ])
          const sliced = sliceFrameTable(table, originalPts, trimmedPts, inSec)
          if (sliced.length > 0) {
            saveVideoFrames(result.id, sliced)
            const missed = sliced.filter((f) => !f.captured).length
            setUncapturedFrames(result.id, missed)
            // 撮り逃しの検証は元クリップの結果を流用せず、新しいファイルで取り直す。
            // 切り出しでフレーム番号も並びも変わっており、元の判定がそのまま当てはまる
            // 保証が無いため。待たない（トリム完了を返すのを遅らせない）。
            //
            // 枚数照合（第4引数）は不要なので null。切り出し後の表は trimmedPts の添字から
            // 作り直しており、その trimmedPts は新ファイルを ffmpeg でデコードして得たもの
            // なので、定義上ファイル内のフレーム数と一致する。
            if (missed > 0) void verifyClipFrames(result.id, webmOut, sliced, null)
          }
        }
      } catch (err) {
        console.warn('[video:trim] failed to carry over the frame table', err)
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
