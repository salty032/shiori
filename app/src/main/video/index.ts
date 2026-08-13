// 動画機能（録画クリップ・トリミング）のエントリ。full 版の bootstrap にのみ渡される
// MainFeature 実装。capture ソースドロップではこのディレクトリごと削除する。
import { app, session, globalShortcut } from 'electron'
import type { MainFeature } from '../feature'
import { loadSettings, saveSettings } from '../system/settings'
import { sendBrowserNotice } from '../browser/browser-notice'
import { handleTrusted, getMainWindow } from '../system/windows'
import { normalizeCaptureHotkey } from '../browser/hotkey'
import { VIDEO_CH } from '../../shared/api.video'
import { addPreCaptureGuard, addBrowserTargetUpdateGuard, SilentCaptureAbort } from '../capture/capture'
import { setVideoThumbProvider } from '../capture/video-thumb-provider'
import { getRecorderWindow, createRecorderWindow } from './recorder-window'
import { registerVideoHandlers } from './ipc-video'
import { registerRecorderIpc } from './recorder-ipc'
import { registerClipHotkey, changeClipHotkey } from './clip-hotkey'
import { registerSupplyBench } from './supply-bench'
import { finishRecordingState, handleClipHotkey, isCurrentlyRecording } from './recording'
import { extractThumb, getVideoMeta, getVideoFramePts } from './ffmpeg'

setVideoThumbProvider({
  extractThumb,
  getVideoMeta,
  countFrames: async (videoPath) => (await getVideoFramePts(videoPath)).length
})

export const videoFeature: MainFeature = {
  registerIpc() {
    registerVideoHandlers()
    registerRecorderIpc()
    handleTrusted(VIDEO_CH.clipSetHotkey, (_event, hotkey: string) => {
      const normalized = normalizeCaptureHotkey(hotkey)
      if (!normalized) return false
      const ok = changeClipHotkey(normalized, handleClipHotkey)
      if (ok) saveSettings({ ...loadSettings(), clipHotkey: normalized })
      return ok
    })
  },

  onReady() {
    // レコーダーウィンドウのみ media 権限を許可（コアの既定 deny ハンドラを上書きする）
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      const rec = getRecorderWindow()
      if (rec && !rec.isDestroyed() &&
          _webContents.id === rec.webContents.id &&
          permission === 'media') {
        callback(true)
        return
      }
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      const rec = getRecorderWindow()
      return !!(rec && !rec.isDestroyed() &&
        _webContents?.id === rec.webContents.id &&
        permission === 'media')
    })

    // 録画中はスクショと pre/post-capture を共有しているため、スクショ終了時の
    // post-capture が録画中の動画にUIを復活させてしまう。録画中は撥ねる。
    addPreCaptureGuard(() => {
      if (isCurrentlyRecording()) throw new SilentCaptureAbort('Recording in progress')
    })
    // キャプチャ対象（ウィンドウ位置・動画矩形）は録画中に書き換えない。
    // バックグラウンドタブのポーリングが getCrop 前に競り勝つのを防ぐ。
    addBrowserTargetUpdateGuard(() => isCurrentlyRecording())

    registerClipHotkey(
      loadSettings().clipHotkey,
      handleClipHotkey,
      (message) => {
        sendBrowserNotice('error', message)
      }
    )
    createRecorderWindow(finishRecordingState)

    // 供給レートの計測は開発時のみ。配布物にホットキーも計測経路も足さない。
    if (!app.isPackaged) registerSupplyBench()

    // ホットキーは起動時に一度だけ登録するため、起動時に他アプリが同じキーを
    // 握っていると登録に失敗したまま復帰しない。ウィンドウフォーカス時に
    // 「未登録のものだけ」取り直す（コアの captureHotkey 再取得とは独立）。
    getMainWindow()?.on('focus', () => {
      const st = loadSettings()
      if (!globalShortcut.isRegistered(st.clipHotkey)) {
        registerClipHotkey(st.clipHotkey, handleClipHotkey, (m) => {
          sendBrowserNotice('error', m)
        })
      }
    })
  }
}
