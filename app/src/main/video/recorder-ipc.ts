// レコーダーウィンドウ専用 IPC（recorder:getCrop / recorder:error / recorder:done）。
// recorder:* は ShioriApi の CH 定数の対象外（別契約・別検証方式。preload/recorder.ts 参照）。
import { ipcMain } from 'electron'
import { unlink } from 'fs/promises'
import { computeVideoCrop, writeCaptureFile } from '../capture'
import { sendNotice, sendToRenderer } from '../windows'
import { ensureCaptureSubDir, thumbPathFor } from '../paths'
import { loadSettings } from '../settings'
import { sendBrowserNotice } from '../browser-notice'
import { CH } from '../../shared/api'
import { isTrustedRecorderSender } from './recorder-window'
import { extractThumb } from './ffmpeg'
import { verifyClipFrames } from './verify-clip'
import { finishRecordingState, getRecordingMeta, isCurrentRecordingSession } from './recording'
import { logMatchResult, buildFrameTable, getSourceFps } from './frame-feed'
import { logSupplyDiag, parseCaptureDiag, summarizeSupply } from './capture-diag'
import { registerCapturedMedia } from '../captured-media'
import { saveVideoFrames, setUncapturedFrames } from '../db'
import { t } from '../i18n'

// renderer 破損時のメモリ DoS / 不正データ対策
const MAX_WEBM_BYTES = 1024 * 1024 * 1024 // 1GB
// 著作権対策の録画上限（settings.ts の clipMaxSeconds、最大30秒）に停止タイマーの
// 遅延分だけ余裕を持たせた値。renderer が改ざん・誤動作しても、この値を超える尺の
// クリップを保存させない（多層防御。settings.ts 側が一次の上限）。
const MAX_CLIP_DURATION_SEC = 40
// フレーム数の妥当性上限。取得は acquireScreenStream 側で 60fps に上限しているが、
// renderer の改ざん・誤動作に対する多層防御として余裕を持たせた値で判定する。
const MAX_FRAME_RATE_FOR_VALIDATION = 120
// fps は情報表示用であり、これが取れないことを理由にクリップ保存を失敗させない
// （サムネ生成と同じベストエフォート方針）。小数第2位で丸める：23.976 と 24 の差が
// 消えない程度に、かつ桁が読める粒度。
function computeFps(frameCount: number, duration: number): number | null {
  if (!Number.isInteger(frameCount) || frameCount <= 0) return null
  if (frameCount > duration * MAX_FRAME_RATE_FOR_VALIDATION) return null
  return Math.round((frameCount / duration) * 100) / 100
}

function formatClipDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

export function registerRecorderIpc(): void {
  ipcMain.handle('recorder:getCrop', (event, streamW: number, streamH: number) => {
    if (!isTrustedRecorderSender(event)) return null
    return computeVideoCrop(streamW, streamH)
  })

  ipcMain.on('recorder:error', (event, msg: string, sessionId: number) => {
    if (!isTrustedRecorderSender(event)) return
    // レコーダーウィンドウ側のレース（新しい録画が始まった後に旧セッションの通知が
    // 遅延して届く）で、新しい録画状態を巻き込んで壊さないよう、現在のセッションと
    // 一致しない通知は黙って無視する。
    if (!isCurrentRecordingSession(sessionId)) return
    // V-1: token不一致・recorder未生成での中断は「録画開始処理中に停止された」だけで
    // ユーザーへの通知は不要（そもそも録画は始まっていない）。状態リセットだけ行う。
    if (msg === 'aborted') {
      finishRecordingState()
      return
    }
    // V-5: audio+video が失敗し video のみで録画を継続しているだけなので、録画状態は
    // リセットしない（このあと recorder:done / recorder:error が別途届く）。
    if (msg === 'audio_unavailable_fallback') {
      sendBrowserNotice('warning', t('notice.recordingNoAudio'))
      return
    }
    finishRecordingState()
    if (msg === 'crop_unavailable') {
      sendNotice('warning', t('notice.videoRegionNotFound'))
    } else if (msg === 'no_data') {
      sendNotice('warning', t('notice.recordingEmpty'))
    } else if (msg === 'getUserMedia_not_allowed') {
      sendNotice('error', t('notice.screenCapturePermission'))
    } else {
      sendNotice('error', t('notice.recordingError', { message: msg.slice(0, 80) }))
    }
  })

  ipcMain.on('recorder:done', async (event, webmAB: ArrayBuffer, duration: number, frameCount: number, sessionId: number, drawnAt: number[], diag: unknown) => {
    if (!isTrustedRecorderSender(event)) return
    // recorder:error と同じ理由（レコーダーウィンドウ側のレース）で、現在のセッションと
    // 一致しない完了通知は無視する。新しい録画を誤って確定・保存させない。
    if (!isCurrentRecordingSession(sessionId)) return

    // renderer 側が壊れた場合に備えた入力検証（メモリ DoS / 不正データ対策）
    if (!(webmAB instanceof ArrayBuffer) || webmAB.byteLength === 0 || webmAB.byteLength > MAX_WEBM_BYTES) {
      console.error('[clip] recorder:done rejected: invalid webm payload', { byteLength: (webmAB as ArrayBuffer)?.byteLength })
      finishRecordingState()
      sendNotice('error', t('notice.recordingDataInvalid'))
      return
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CLIP_DURATION_SEC) {
      console.error('[clip] recorder:done rejected: invalid duration', { duration })
      finishRecordingState()
      sendNotice('error', t('notice.recordingDataInvalid'))
      return
    }

    // 素材の実 fps が分かるならそれを使う。frameCount/duration は「画面キャプチャが
    // 何枚寄越したか」でしかなく素材とは無関係な値になる（23.976fps の素材で 37fps 等）。
    // 取れないとき（拡張未接続・非対応サイト）だけ従来の算出へ退避する。
    const sourceFps = getSourceFps()
    const fps = sourceFps ?? computeFps(frameCount, duration)

    const meta = getRecordingMeta()
    finishRecordingState()

    // 素材のコマと撮れたフレームの対応付け。renderer 破損に備え、数値の配列で
    // あることを確認してから使う。ここが得られなくてもクリップ保存は続行する
    // （コマ精度の無い従来どおりのクリップとして残る方が、保存失敗より良い）。
    const usableDrawnAt = Array.isArray(drawnAt) && drawnAt.length > 0 &&
      drawnAt.length <= MAX_CLIP_DURATION_SEC * MAX_FRAME_RATE_FOR_VALIDATION &&
      drawnAt.every((t) => Number.isFinite(t))
    const frameTable = usableDrawnAt ? buildFrameTable(drawnAt) : null
    logMatchResult(frameTable)
    // 撮り逃しの原因を「供給不足」と「観測漏れ」に切り分けるための実測ログ（1録画1行）。
    // 素材の周期が分かるときだけ「素材1コマより長く空いた回数」も併記する。
    if (usableDrawnAt) {
      logSupplyDiag(
        summarizeSupply(drawnAt, duration, sourceFps ? 1000 / sourceFps : null),
        parseCaptureDiag(diag)
      )
    }

    const webm = Buffer.from(webmAB)

    const capturedAt = Date.now()
    let webmPath: string | null = null
    let thumbPath: string | null = null
    try {
      const dir = await ensureCaptureSubDir(capturedAt)
      webmPath = await writeCaptureFile(dir, webm, '.webm')
      const thumbOut = thumbPathFor(webmPath, '.png')
      try {
        await extractThumb(webmPath, thumbOut)
        thumbPath = thumbOut
      } catch (err) {
        console.warn('[clip] extractThumb failed, proceeding without thumb', err)
      }

      const result = await registerCapturedMedia({
        insert: {
          filepath: webmPath,
          captured_at: capturedAt,
          title: meta?.title ?? null,
          current_time: meta?.currentTime ?? null,
          url: meta?.url ?? null,
          width: null,
          height: null,
          colors: null,
          memo: null,
          media_type: 'video',
          duration,
          fps,
          thumb_path: thumbPath
        },
        filePath: webmPath,
        thumbPath,
        autoTag: thumbPath ? { path: thumbPath } : null
      })
      if (!result.ok) {
        sendNotice('error', t('notice.clipSaveFailed'))
        return
      }
      // フレーム表は保存できなくてもクリップ自体は成立する（コマ送りが従来動作に
      // 落ちるだけ）。ここで失敗させて保存済みのクリップを巻き戻す方が損失が大きい。
      const missedFrames = frameTable ? frameTable.matches.filter((m) => !m.captured).length : 0
      if (frameTable) {
        try {
          saveVideoFrames(result.id, frameTable.matches)
          setUncapturedFrames(result.id, missedFrames)
          // 撮り逃しが1コマも無いなら検証する対象が無い（大半のクリップはここで終わる）。
          // 待たずに投げっぱなしにする — 保存の完了通知を遅らせないため。
          if (missedFrames > 0) void verifyClipFrames(result.id, webmPath, frameTable.matches)
        } catch (err) {
          console.error('[clip] saveVideoFrames failed', err)
        }
      }
      if (loadSettings().clipNotify !== false) {
        // 撮り逃したコマがあるときは枚数も添える。この場で分かれば撮り直せるが、後から
        // 詳細パネルで気づいても撮り直せる場面はもう終わっている。0 枚なら従来どおり
        // 何も足さない（大半はこちら。常に数字を出すと通知が読み飛ばされる）。
        sendBrowserNotice('success', missedFrames > 0
          ? t('notice.clipSavedWithMissed', { duration: formatClipDuration(duration), count: String(missedFrames) })
          : t('notice.clipSaved', { duration: formatClipDuration(duration) }))
      }
    } catch (err) {
      console.error('[clip] save failed', err)
      if (webmPath) try { await unlink(webmPath) } catch {}
      if (thumbPath) try { await unlink(thumbPath) } catch {}
      sendNotice('error', t('notice.clipSaveFailed'))
    }
  })
}
