// 動画クリップのフレーム PTS 取得・トリミング（再エンコード）の IPC ハンドラ。
import { unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { handleTrusted, sendToRenderer } from '../system/windows'
import { getImage, setFrameCounts } from '../db'
import { getImageTags } from '../db-tags'
import { getVideoFrames, restoreVideoFrames, saveVideoFrames } from '../db-video-frames'
import type { StoredFrame } from '../db-video-frames'
import { optionalPositiveInteger } from '../ipc/ipc-validation'
import { resolveRealCapturePath, ensureCaptureSubDir, thumbPathFor } from '../system/paths'
import { trimWebm, extractThumb, getVideoFramePts, getTimelineStrip, getVideoDuration } from './ffmpeg'
import { VIDEO_CH, FRAME_QUALITY } from '../../shared/api.video'
import { CH } from '../../shared/api'
import type { ClipFrames, ClipGap, FrameQuality, TrimProgress } from '../../shared/api.video'
import { registerCapturedMedia } from '../capture/captured-media'
import { sliceFrameTable, countReportDrops, frameGaps, reportDropsMeasured } from './frame-feed'
import { verifyClipFrames } from './verify-clip'

// トリミング処理中の imageId 集合（多重トリミング防止）
const trimmingIds = new Set<number>()

// コマ情報のキャッシュ（V-13）。同じ動画のトリマーを開き直すたびに全フレームを
// デコードする getVideoFramePts が再実行されるのを避ける。imageId 単位でキーする——
// 画像テーブルは AUTOINCREMENT で id を再利用せず、ある imageId のファイル内容は不変
// （トリムは新しい id を作る）なので、id をキーにすれば誤ヒットしない。
// 上限付き LRU（Map は挿入順を保持するので、先頭が最も古いアクセス）。
const clipFramesCache = new Map<number, ClipFrames>()
const CLIP_FRAMES_CACHE_MAX = 24

function getCachedClipFrames(id: number): ClipFrames | undefined {
  const hit = clipFramesCache.get(id)
  if (hit) {
    clipFramesCache.delete(id)   // アクセスしたものを末尾（最新）へ回す
    clipFramesCache.set(id, hit)
  }
  return hit
}

// 表を書き換えたら捨てる。**キャッシュは開いた時点のスナップショット**で、検証（verify-clip）
// や起動時の見直し（recheckUnusableClips）が裏で表を書き換えても自分では気づかない。
// 捨てないと、印が付いた／外れたクリップを開いたまま古い並びで送り続けることになる。
export function invalidateClipFrames(id: number): void {
  clipFramesCache.delete(id)
}

function setCachedClipFrames(id: number, frames: ClipFrames): void {
  clipFramesCache.delete(id)
  clipFramesCache.set(id, frames)
  while (clipFramesCache.size > CLIP_FRAMES_CACHE_MAX) {
    const oldest = clipFramesCache.keys().next().value
    if (oldest === undefined) break
    clipFramesCache.delete(oldest)
  }
}

// 保存されたコマ 1 つを、画面へ出す確からしさ（FRAME_QUALITY）へ落とす。
//
// captured=true のコマに検証結果は無い（frame-verify.ts が付けるのは撮り逃したコマだけ）ので、
// 撮れているかどうかを先に見る。verified が 'unknown' のままなのは検証前・検証失敗・
// 検証を持たない従来の行で、いずれも「流用しているが実害の有無は分からない」に当たる。
export function frameQualityOf(f: StoredFrame): FrameQuality {
  // ずれは最優先。**撮れているコマでも、指しているファイル内フレームが違えば出る絵が違う。**
  // 流用（絵が無い）より重い——あちらは何が出ているか分かっているが、こちらは分からない。
  if (f.misaligned) return FRAME_QUALITY.misaligned
  if (f.captured) return FRAME_QUALITY.captured
  return FRAME_QUALITY.reused
}

// 素材のコマ表とファイルの PTS から、コマ送り用の並びを作る。
//
// 表があれば「素材のコマ N が写っているフレーム」の PTS だけを素材の順で並べ直す。
// ファイルのフレームをそのまま辿ると、画面キャプチャが吐いた枚数（実測 33〜50枚/秒）で
// コマ送りすることになり、素材のコマ（23.976fps 等）とは対応しない。
// 撮れなかったコマは直前と同じ PTS になり、絵が変わらないまま 1 コマ進む。
//
// 表が無い・表の frameIndex がファイルの範囲外（＝対応が取れていない）ときは退避して
// ファイルのフレームをそのまま返し、**素材のコマ単位ではないことを sourceBased で明示する**。
// 黙って別の刻みへ落ちるのが最悪なので、呼び出し側が画面に出せる形で返す。
// 表から抜けている区間を拾う（ClipGap のコメント参照）。
//
// **数え方は frame-feed.ts の frameGaps だけが持つ。** ここで別に数えると、詳細パネルに
// 出る合計とコマ送りに出る場所が別の計算から出ることになる（実測 82 本中 5 本で食い違った）。
export function findClipGaps(frames: StoredFrame[]): ClipGap[] {
  return frameGaps(frames)
}

export function buildClipFrames(pts: number[], table: StoredFrame[] | null): ClipFrames {
  const usable = table?.filter((f) => f.frameIndex >= 0 && f.frameIndex < pts.length) ?? []
  if (usable.length === 0) return { pts, sourceBased: false, quality: [] }
  return {
    pts: usable.map((f) => pts[f.frameIndex]),
    sourceBased: true,
    quality: usable.map(frameQualityOf),
    gaps: findClipGaps(usable)
  }
}

// コマ送りが実際に使う範囲（ファイル内に実在するコマ）で枚数を数え直し、変わっていれば
// DB へ書き戻して画面へ知らせる。**書き戻さないと、詳細タイルだけが落とした行を数え続ける。**
function syncFrameCountsToUsable(
  imageId: number, table: StoredFrame[], fileFrames: number, ambiguous: number | null
): void {
  const usable = table.filter((f) => f.frameIndex >= 0 && f.frameIndex < fileFrames)
  if (usable.length === 0 || usable.length === table.length) return
  // **表と集計値を同じトランザクションで確定する。** 集計値だけ直すと、起動時の
  // backfillFrameCounts が未切り詰めの表を正本として数え直し、次回起動で元へ戻してしまう。
  // ambiguous も usable から再計算し、DBと通知の片方だけ null になる状態を作らない。
  const restored = restoreVideoFrames(imageId, usable, { ambiguous })
  if (!restored) return
  sendToRenderer(CH.framesVerified, {
    id: imageId,
    uncaptured: restored.uncaptured,
    ambiguous: restored.ambiguous,
    total: restored.sourceFrames,
    unreported: restored.unreported,
    misaligned: restored.misaligned,
    unreportedMeasured: restored.unreportedMeasured
  })
}

export function registerVideoHandlers(): void {
  handleTrusted(VIDEO_CH.videoGetClipFrames, async (_event, imageId: number) => {
    // 取得できなかったときの返り値。pts が空＝「コマの位置が分からない」で、
    // 呼び出し側はここでだけ fps 換算のコマ送りへ落ちる（そのことを画面にも出す）。
    const EMPTY: ClipFrames = { pts: [], sourceBased: false, quality: [] }
    const validId = optionalPositiveInteger(imageId)
    if (!validId) return EMPTY
    const image = getImage(validId)
    if (!image || image.media_type !== 'video') return EMPTY
    const cached = getCachedClipFrames(validId)
    if (cached) return cached
    try {
      const realPath = await resolveRealCapturePath(image.filepath)
      if (!realPath) return EMPTY
      const pts = await getVideoFramePts(realPath)
      if (pts.length === 0) return EMPTY   // 失敗・タイムアウトはキャッシュせず再取得の余地を残す

      const table = getVideoFrames(validId)
      const result = buildClipFrames(pts, table)
      // **詳細タイルの枚数を、ここで確定した範囲に合わせ直す。**
      //
      // コマ送りが数えるのは「ファイル内に実在するコマ」だけで、frameIndex がファイルの外を
      // 指す行は落としている。一方 DB の枚数は表の全行から数えたもので、**落とした行まで
      // 母数に入っている**。検証を通った録画は範囲外の行が切り落とされているので一致するが、
      // 検証に失敗した録画と、検証を持たない古い録画では一致しない——同じ録画で、詳細タイルと
      // コマ送りが別の数を出すことになる。ファイルの長さが分かるのはここだけなので、ここで直す。
      if (table && result.sourceBased) {
        syncFrameCountsToUsable(validId, table, pts.length, image.ambiguous_frames ?? null)
      }
      setCachedClipFrames(validId, result)
      return result
    } catch { return EMPTY }
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

  handleTrusted(VIDEO_CH.videoTrim, async (event, imageId: number, inSec: number, outSec: number) => {
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
      // 進み具合の送り先。**閉じた後に届いても捨てる**（トリミングは画面を閉じても
      // 走り切るので、送り先が先に消えることは普通に起きる）。
      const sendProgress = (progress: TrimProgress): void => {
        const sender = event?.sender
        if (!sender || sender.isDestroyed()) return
        sender.send(VIDEO_CH.videoTrimProgress, progress)
      }
      // **整数のパーセントが変わったときだけ**送る。画面に出る値の刻みと送る回数が
      // 一致する（ffmpeg は 1 本の焼き直しで何百行も進捗を吐く）。
      let lastPercent = -1
      await trimWebm(realPath, webmOut, inSec, outSec, (ratio) => {
        const percent = Math.floor(ratio * 100)
        if (percent === lastPercent) return
        lastPercent = percent
        sendProgress({ ratio, phase: 'encode' })
      })
      // 焼き直しはここで終わり。**この先も数秒かかる**（サムネ・登録・コマ表の引き継ぎで
      // 元とトリム後の両方をデコードする）ので、100% のまま止まったように見せない。
      sendProgress({ ratio: 1, phase: 'finish' })

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
          // 画素数も fps と同じ理由で引き継ぐ。トリムは時間方向に切るだけで解像度は
          // 変わらないのに、ここを落とすとトリムした瞬間に解像度表示だけが消える。
          width: image.width,
          height: image.height,
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
            setFrameCounts(result.id, missed, sliced.length, countReportDrops(sliced), 0, reportDropsMeasured(sliced))
            // 撮り逃しの検証は元クリップの結果を流用せず、新しいファイルで取り直す。
            // 切り出しでフレーム番号も並びも変わっており、元の判定がそのまま当てはまる
            // 保証が無いため。待たない（トリム完了を返すのを遅らせない）。
            //
            // **撮り逃しが 0 でも走らせる。** 以前は missed > 0 のときだけだったが、それだと
            // 「最も精度が良く見えるクリップ」ほど照合されないことになる。照合が要るのは
            // 撮り逃しの有無ではなく、表の frameIndex が新しいファイルの実フレームと
            // 一致しているかで、一致していなければ全コマが黙って別の絵を指す。
            // 録画の保存側（recorder-ipc.ts）と同じ基準に揃える。
            //
            // 枚数照合（第4引数）は不要なので null。切り出し後の表は trimmedPts の添字から
            // 作り直しており、その trimmedPts は新ファイルを ffmpeg でデコードして得たもの
            // なので、定義上ファイル内のフレーム数と一致する。
            void verifyClipFrames(result.id, webmOut, sliced, null)
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
