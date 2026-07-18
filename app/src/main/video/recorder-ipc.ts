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
import { finishRecordingState, getRecordingMeta } from './recording'
import { registerCapturedMedia } from '../captured-media'

// renderer 破損時のメモリ DoS / 不正データ対策
const MAX_WEBM_BYTES = 1024 * 1024 * 1024 // 1GB
const MAX_CLIP_DURATION_SEC = 3600 // 1時間

function formatClipDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

export function registerRecorderIpc(): void {
  ipcMain.handle('recorder:getCrop', (event, streamW: number, streamH: number) => {
    if (!isTrustedRecorderSender(event)) return null
    return computeVideoCrop(streamW, streamH)
  })

  ipcMain.on('recorder:error', (event, msg: string) => {
    if (!isTrustedRecorderSender(event)) return
    // V-1: token不一致・recorder未生成での中断は「録画開始処理中に停止された」だけで
    // ユーザーへの通知は不要（そもそも録画は始まっていない）。状態リセットだけ行う。
    if (msg === 'aborted') {
      finishRecordingState()
      return
    }
    // V-5: audio+video が失敗し video のみで録画を継続しているだけなので、録画状態は
    // リセットしない（このあと recorder:done / recorder:error が別途届く）。
    if (msg === 'audio_unavailable_fallback') {
      sendBrowserNotice('warning', '音声なしで録画しています（音声デバイスの初期化に失敗しました）。')
      return
    }
    finishRecordingState()
    if (msg === 'crop_unavailable') {
      sendNotice('warning', '動画領域を特定できませんでした。ページを再読み込みして再試行してください。')
    } else if (msg === 'no_data') {
      sendNotice('warning', '録画データが空でした。短すぎる録画は保存されません。')
    } else if (msg === 'getUserMedia_not_allowed') {
      sendNotice('error', '画面録画の権限がありません。Chromeのハードウェアアクセラレーションをオフにして再試行してください。')
    } else {
      sendNotice('error', `録画エラー: ${msg.slice(0, 80)}`)
    }
  })

  ipcMain.on('recorder:done', async (event, webmAB: ArrayBuffer, duration: number) => {
    if (!isTrustedRecorderSender(event)) return

    // renderer 側が壊れた場合に備えた入力検証（メモリ DoS / 不正データ対策）
    if (!(webmAB instanceof ArrayBuffer) || webmAB.byteLength === 0 || webmAB.byteLength > MAX_WEBM_BYTES) {
      console.error('[clip] recorder:done rejected: invalid webm payload', { byteLength: (webmAB as ArrayBuffer)?.byteLength })
      finishRecordingState()
      sendNotice('error', '録画データが不正なため保存できませんでした。')
      return
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CLIP_DURATION_SEC) {
      console.error('[clip] recorder:done rejected: invalid duration', { duration })
      finishRecordingState()
      sendNotice('error', '録画データが不正なため保存できませんでした。')
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
        sendNotice('error', 'クリップの保存に失敗しました')
        return
      }
      if (loadSettings().clipNotify !== false) {
        sendBrowserNotice('success', `クリップを保存しました（${formatClipDuration(duration)}）`)
      }
    } catch (err) {
      console.error('[clip] save failed', err)
      if (webmPath) try { await unlink(webmPath) } catch {}
      if (thumbPath) try { await unlink(thumbPath) } catch {}
      sendNotice('error', 'クリップの保存に失敗しました')
    }
  })
}
