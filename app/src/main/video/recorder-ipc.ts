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
import { finishRecordingState, getRecordingMeta, isCurrentRecordingSession } from './recording'
import { registerCapturedMedia } from '../captured-media'
import { t } from '../i18n'

// renderer 破損時のメモリ DoS / 不正データ対策
const MAX_WEBM_BYTES = 1024 * 1024 * 1024 // 1GB
// 著作権対策の録画上限（settings.ts の clipMaxSeconds、最大30秒）に停止タイマーの
// 遅延分だけ余裕を持たせた値。renderer が改ざん・誤動作しても、この値を超える尺の
// クリップを保存させない（多層防御。settings.ts 側が一次の上限）。
const MAX_CLIP_DURATION_SEC = 40

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

  ipcMain.on('recorder:done', async (event, webmAB: ArrayBuffer, duration: number, sessionId: number) => {
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

    const meta = getRecordingMeta()
    finishRecordingState()

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
      if (loadSettings().clipNotify !== false) {
        sendBrowserNotice('success', t('notice.clipSaved', { duration: formatClipDuration(duration) }))
      }
    } catch (err) {
      console.error('[clip] save failed', err)
      if (webmPath) try { await unlink(webmPath) } catch {}
      if (thumbPath) try { await unlink(thumbPath) } catch {}
      sendNotice('error', t('notice.clipSaveFailed'))
    }
  })
}
