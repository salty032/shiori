// 拡張との WebSocket 配線。bootstrap.ts から切り出した。
//
// 拡張から届くのは配信ページの再生時刻とウィンドウ位置で、**キャプチャの土台になる値**。
// 受け取りを止めると、撮っても再生時刻の付かない素材が黙って増える（画面には何も出ない）。
//
// 送り返すのは設定（コマ送りの fps・キャプチャキー・コマ送りの文言）。接続してきた拡張へは
// **listen 開始より前に登録したコールバックから**返す。後に回すと、起動直後に繋いだ拡張が
// 設定の無いまま動く。
import { startWsServer, onExtensionMessage, onWsClientConnect } from './ws-server'
import { bundledExtPath, readVersion } from './extension-updater'
import { loadSettings } from '../system/settings'
import { captureHotkeyMainKey } from './hotkey'
import { setLastTimecode, markFocusedTimecodeNow, getLastFocusedTimecodeAt } from './timecode'
import { setBrowserWindowPos, setVideoRect, setBrowserFullscreen, shouldSuppressBrowserTargetUpdate } from '../capture/capture'
import { sendToRenderer } from '../system/windows'
import { compareVersions } from '../system/version'
import { CH } from '../../shared/api'
import { t } from '../system/i18n'

// コマ送りが効かないときに拡張がページ上へ出す文言。ここと拡張で別々に持つと、
// 片方だけ翻訳が増えたときに気づけない。
export function browserStepLabels(): { blocked: string; dropped: string } {
  return { blocked: t('video.stepBlocked'), dropped: t('video.stepDropped') }
}

export function startExtensionBridge(): void {
  // OS通知（checkExtensionUpdate）は起動直後の1回しか出ず見逃しやすいため、以後は
  // 拡張から届く timecode の version と比較し続け、設定画面に「再読み込みが必要」の
  // バッジを出せるようにする（UX-9）。
  const bundledExtVersion = readVersion(bundledExtPath())
  const wsSettings = loadSettings()
  onWsClientConnect((send) => {
    const s = loadSettings()
    send({ type: 'settings', frameFps: s.frameFps ?? 24, frameFpsAuto: s.frameFpsAuto !== false, captureKey: captureHotkeyMainKey(s.captureHotkey), stepLabels: browserStepLabels() })
  })
  // listen 開始前に接続コールバックを登録し、起動直後の接続にも必ず設定を返す。
  startWsServer({ allowedExtensionIds: wsSettings.allowedExtensionIds })

  onExtensionMessage((msg) => {
    if (msg.type === 'timecode') {
      if (msg.focused) markFocusedTimecodeNow()
      // フォーカス中のタブを優先。フォーカスタイムコードが30秒以上届いていない場合は
      const accept = msg.focused || Date.now() - getLastFocusedTimecodeAt() > 30_000
      if (accept) {
        setLastTimecode({ title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null })
      }
      if (!shouldSuppressBrowserTargetUpdate() && accept) {
        setBrowserWindowPos(msg.windowLeft, msg.windowTop, msg.windowWidth, msg.windowHeight, msg.innerWidth, msg.innerHeight)
        setVideoRect(msg.videoRect)
        setBrowserFullscreen(msg.fullscreen)
      }
      // バンドル版の方が新しければ「拡張の再読み込みが必要」（UX-9）。
      const versionMismatch = !!bundledExtVersion && !!msg.version && compareVersions(bundledExtVersion, msg.version) > 0
      sendToRenderer(CH.extensionTimecode, { ...msg, versionMismatch })
    }
  })
}
