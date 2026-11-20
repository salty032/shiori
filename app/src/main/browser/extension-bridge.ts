// 拡張との WebSocket 配線。bootstrap.ts から切り出した。
//
// 拡張から届くのは配信ページの再生時刻とウィンドウ位置で、**キャプチャの土台になる値**。
// 受け取りを止めると、撮っても再生時刻の付かない素材が黙って増える（画面には何も出ない）。
//
// 送り返すのは設定（コマ送りの fps・キャプチャキー・コマ送りの文言）。接続してきた拡張へは
// **listen 開始より前に登録したコールバックから**返す。後に回すと、起動直後に繋いだ拡張が
// 設定の無いまま動く。
import { Notification } from 'electron'
import { startWsServer, onExtensionMessage, onWsClientConnect, broadcastMessage } from './ws-server'
import { bundledExtPath, readVersion } from './extension-updater'
import { loadSettings, type Settings } from '../system/settings'
import { captureHotkeyMainKey } from './hotkey'
import { setLastTimecode, markFocusedTimecodeNow, getLastFocusedTimecodeAt, setLastExtensionVersion } from './timecode'
import { setBrowserWindowPos, setVideoRect, setBrowserFullscreen, shouldSuppressBrowserTargetUpdate, isCaptureInProgress } from '../capture/capture'
import { isRecordingInProgress } from '../video/recording'
import { notePlayerUiMissing } from './ext-diag'
import { sendToRenderer } from '../system/windows'
import { compareVersions } from '../../shared/version'
import { CH } from '../../shared/api'
import type { AppToExtensionMessage } from '../../shared/wire-messages'
import { t } from '../system/i18n'

// コマ送りが効かないときに拡張がページ上へ出す文言。ここと拡張で別々に持つと、
// 片方だけ翻訳が増えたときに気づけない。
export function browserStepLabels(): { blocked: string; dropped: string } {
  return { blocked: t('video.stepBlocked'), dropped: t('video.stepDropped') }
}

// 拡張へ送る settings メッセージ。**組み立てはここだけ**——接続時・設定保存時・ホットキー変更時の
// 3 か所で別々に書いていた頃は、拡張へ項目を足すとき 1 か所でも書き忘れると、その経路から送った
// 設定だけが届かなかった（画面には何も出ない）。
// stepLabels はブラウザ側 , / . の読み取り表示に出す文言。**拡張は文言を持たない**（原本は ja.ts）ので
// ここに載せて配る。言語を変えたときも設定保存時の再送で届く。
export function extensionSettingsMessage(s: Settings): AppToExtensionMessage {
  return {
    type: 'settings',
    captureKey: captureHotkeyMainKey(s.captureHotkey),
    stepLabels: browserStepLabels()
  }
}

// 拡張に読み込み直しを頼んでから、まだ古い版の報告が届いても待つ時間。頼んだ直後は、読み込み直す前の
// 報告がまだ届く。これを過ぎても古いままなら、ブラウザは別のフォルダの拡張を読んでいる（開発版と製品版は
// 別々のコピーを持つ・手で別の場所から読み込んだ）ので、頼み直さずに今までどおり手で再読み込みを案内する。
export const EXTENSION_RELOAD_GRACE_MS = 15_000

export interface ExtensionRefreshState {
  /** 読み込み直しを頼んだときに動いていた版（同じ版にもう一度は頼まない＝頼み続けない） */
  requestedFor: string | null
  requestedAt: number
  notified: boolean
}

/**
 * 古い拡張が動いていると報告されたとき、どうするか。
 * 録画中・撮影中は待つ（読み込み直すとページの部分が入れ替わり、撮っている途中のものが壊れる）。
 * まだ頼んでいない版なら読み込み直しを頼み、頼んでも直らなければ 1 回だけ手での再読み込みを案内する。
 */
export function decideExtensionRefresh(
  state: ExtensionRefreshState, running: string, now: number, busy: boolean
): 'reload' | 'notify' | 'wait' | 'none' {
  if (busy) return 'wait'
  if (state.requestedFor !== running) {
    state.requestedFor = running
    state.requestedAt = now
    return 'reload'
  }
  if (now - state.requestedAt < EXTENSION_RELOAD_GRACE_MS) return 'wait'
  if (state.notified) return 'none'
  state.notified = true
  return 'notify'
}

export function startExtensionBridge(): void {
  // 拡張から届く timecode の version とバンドル版を比べ、古い拡張が動いていれば
  // 「再読み込みが必要」を出す。OS 通知は起動ごとに 1 回、見逃した後のために設定画面にも
  // バッジを出し続ける（UX-9）。ファイルのコピー時ではなくここで判定するのは、ブラウザが
  // 実際に動かしている版だけが確かなため。
  const bundledExtVersion = readVersion(bundledExtPath())
  const refresh: ExtensionRefreshState = { requestedFor: null, requestedAt: 0, notified: false }
  const wsSettings = loadSettings()
  onWsClientConnect((send) => {
    send(extensionSettingsMessage(loadSettings()))
  })
  // listen 開始前に接続コールバックを登録し、起動直後の接続にも必ず設定を返す。
  startWsServer({ allowedExtensionIds: wsSettings.allowedExtensionIds })

  onExtensionMessage((msg) => {
    if (msg.type === 'player-ui-missing') { notePlayerUiMissing(msg.host); return }
    if (msg.type === 'timecode') {
      if (msg.version) setLastExtensionVersion(msg.version)
      if (msg.focused) markFocusedTimecodeNow()
      // フォーカス中のタブを優先。フォーカスタイムコードが30秒以上届いていない場合は、
      // フォーカスの無いタブからのものも受け付ける。
      const accept = msg.focused || Date.now() - getLastFocusedTimecodeAt() > 30_000
      if (accept) {
        setLastTimecode({ title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null })
      }
      if (!shouldSuppressBrowserTargetUpdate() && accept) {
        setBrowserWindowPos(msg.windowLeft, msg.windowTop, msg.windowWidth, msg.windowHeight, msg.innerWidth, msg.innerHeight)
        setVideoRect(msg.videoRect)
        setBrowserFullscreen(msg.fullscreen)
      }
      // バンドル版の方が新しければ、拡張に自分を読み込み直させる（利用者は何もしなくてよい）。
      // 読み込み直しても古いままのときだけ、今までどおり手での再読み込みを案内する（UX-9）。
      const versionMismatch = !!bundledExtVersion && !!msg.version && compareVersions(bundledExtVersion, msg.version) > 0
      if (versionMismatch) {
        const action = decideExtensionRefresh(refresh, msg.version!, Date.now(), isRecordingInProgress() || isCaptureInProgress())
        if (action === 'reload') {
          console.log(`[ext-update] asking the extension to reload itself (${msg.version} -> ${bundledExtVersion})`)
          broadcastMessage({ type: 'reload-extension' })
        } else if (action === 'notify') {
          new Notification({
            title: 'Shiori',
            body: t('notice.extensionUpdated', { from: msg.version!, to: bundledExtVersion! })
          }).show()
        }
      }
      sendToRenderer(CH.extensionTimecode, { ...msg, versionMismatch })
    }
  })
}
