// 動画クリップ録画のステートマシン。録画状態（isRecording / isRecordingStarting /
// recordingMeta）を保持し、開始・停止・状態リセット・ホットキー処理を提供する。
import { shell, desktopCapturer, screen as electronScreen } from 'electron'
import { broadcastMessage, onExtensionMessage, type ExtensionMessage } from '../ws-server'
import { canCaptureVideo, getBrowserWindowRect, setBrowserWindowPos, setVideoRect } from '../capture'
import { loadSettings } from '../settings'
import { isMainWindowFocused } from '../windows'
import { getRecorderWindow, createRecorderWindow } from './recorder-window'
import { setTrayRecording } from '../tray'
import { getLastTimecode, getLastTimecodeAt, setLastTimecode } from '../timecode'
import { sendBrowserNotice } from '../browser-notice'

export interface RecordingMeta {
  title: string | null
  currentTime: number | null
  url: string | null
}

let isRecording = false
let isRecordingStarting = false
let recordingMeta: RecordingMeta | null = null
// V-1: recorder:done/error のどちらも届かない場合（レコーダーのハング等）に備えた保険。
// finishRecordingState() のたびにインクリメントし、古いウォッチドッグを無効化する。
let recordingWatchdogToken = 0

export function isCurrentlyRecording(): boolean {
  return isRecording
}

export function getRecordingMeta(): RecordingMeta | null {
  return recordingMeta
}

type TimecodeMsg = Extract<ExtensionMessage, { type: 'timecode' }>

async function requestRecordingTarget(): Promise<TimecodeMsg | null> {
  const requestId = `${Date.now()}-${Math.random()}`
  return new Promise((resolve) => {
    let done = false
    const finish = (value: TimecodeMsg | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const off = onExtensionMessage((msg) => {
      if (msg.type === 'timecode' && msg.requestId === requestId) {
        finish(msg)
      }
    })
    broadcastMessage({ type: 'request-timecode', requestId, immediate: true })
    // 録画は immediate=true で UI 非表示の描画待ちが不要なため即応答が返る。
    // 取りこぼし保険として短め(700ms)で打ち切る。スクショ側(900ms)より短いのはこの差による。
    const timer = setTimeout(() => { console.warn('[clip] request-timecode timeout'); finish(null) }, 700)
  })
}

// 録画開始時のデスクトップソース解決。capture.ts が保持するブラウザウィンドウ位置
// （コア state）を読み取り専用アクセサ経由で参照する。
async function getDesktopSourceId(): Promise<string | null> {
  const rect = getBrowserWindowRect()
  if (!rect) return null
  const { left: wl, top: wt, width: ww, height: wh } = rect
  const edisp = electronScreen.getDisplayNearestPoint({ x: Math.round(wl + ww / 2), y: Math.round(wt + wh / 2) })
  const sources = await desktopCapturer.getSources({ types: ['screen'] })
  const source = sources.find(s => s.display_id === String(edisp.id)) ?? sources[0]
  return source?.id ?? null
}

const RECORDER_LOAD_TIMEOUT_MS = 4000

// レコーダーウィンドウを生成し、ロード完了まで待つ。
// 既存ウィンドウ（起動時生成）がまだロード中でも待つことで、起動直後の初回録画で
// recorder:start が未ロードのページに送られて取りこぼされるのを防ぐ。
// ロード失敗・ハング時に isRecordingStarting が固着しないよう必ずタイムアウトで抜ける。
async function ensureRecorderReady(timeoutMs: number): Promise<boolean> {
  let win = getRecorderWindow()
  if (!win || win.isDestroyed()) {
    createRecorderWindow(finishRecordingState)
    win = getRecorderWindow()
  }
  if (!win || win.isDestroyed()) return false

  const wc = win.webContents
  if (!wc.isLoading()) return true // 既にロード完了済み

  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.off('did-finish-load', onLoad)
      resolve(ok)
    }
    const onLoad = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    wc.once('did-finish-load', onLoad)
  })
}

export async function startRecording(): Promise<void> {
  if (isRecording || isRecordingStarting) return
  isRecordingStarting = true

  try {
    const target = await requestRecordingTarget()
    if (target?.videoRect) {
      setLastTimecode({ title: target.title, currentTime: target.currentTime, url: target.url ?? null })
      setBrowserWindowPos(target.windowLeft, target.windowTop, target.windowWidth, target.windowHeight, target.innerWidth, target.innerHeight)
      setVideoRect(target.videoRect)
    }

    // V-4: target がタイムアウト（拡張無応答）で null のとき、以前の browserWindow/videoRect
    // が残っていると canCaptureVideo() を通過してしまい、古い矩形で誤った領域を録画し、
    // メタデータも getLastTimecode() の古い値のまま付いてしまう。スクショ側の鮮度チェック
    // （bootstrap.ts の CAPTURE_FALLBACK_TIMECODE_MAX_AGE_MS）と同じしきい値で中止する。
    const CLIP_TIMECODE_MAX_AGE_MS = 1500
    if (!target && Date.now() - getLastTimecodeAt() > CLIP_TIMECODE_MAX_AGE_MS) {
      console.warn('[clip] stale timecode after target timeout, aborting recording')
      sendBrowserNotice('warning', '動画を検出できませんでした。対応サイトの動画ページを開き、Chrome拡張機能が有効か確認してください。')
      return
    }

    if (!canCaptureVideo()) {
      console.warn('[clip] canCaptureVideo false', { hasTarget: !!target, videoRect: target?.videoRect ?? null })
      sendBrowserNotice('warning', '動画を検出できませんでした。対応サイトの動画ページを開き、Chrome拡張機能が有効か確認してください。')
      return
    }
    if (!(await ensureRecorderReady(RECORDER_LOAD_TIMEOUT_MS))) {
      sendBrowserNotice('error', 'レコーダーの準備に失敗しました。もう一度お試しください。')
      return
    }

    const sourceId = await getDesktopSourceId()
    if (!sourceId) {
      sendBrowserNotice('error', '録画ソースが見つかりませんでした')
      return
    }

    isRecording = true
    broadcastMessage({ type: 'pre-capture' })
    shell.beep()
    const tc = getLastTimecode()
    recordingMeta = {
      title: tc?.title ?? null,
      currentTime: tc?.currentTime ?? null,
      url: tc?.url ?? null
    }

    const settings = loadSettings()
    const maxSeconds = settings.clipMaxSeconds ?? 30
    getRecorderWindow()!.webContents.send('recorder:start', {
      sourceId,
      fps: 30,
      maxSeconds
    })
    setTrayRecording(true)

    // V-1: レコーダーがクラッシュ以外の形でハングし、recorder:done/error のどちらも
    // 届かないケース（render-process-gone では拾えない）に備えた保険。maxSeconds 経過後の
    // 自動停止（recorder.ts の stopTimer）よりさらに 30 秒待っても復帰しなければ強制リセットする。
    const watchdogToken = ++recordingWatchdogToken
    setTimeout(() => {
      if (watchdogToken !== recordingWatchdogToken) return
      if (!isRecording) return
      console.error('[clip] watchdog: recorder did not report done/error in time, forcing reset')
      finishRecordingState()
      sendBrowserNotice('error', '録画処理がタイムアウトしました。もう一度お試しください。')
    }, (maxSeconds + 30) * 1000)
  } catch (err) {
    console.error('[clip] startRecording failed', err)
    finishRecordingState()
  } finally {
    isRecordingStarting = false
  }
}

export function stopRecording(): void {
  if (!isRecording) return
  getRecorderWindow()?.webContents.send('recorder:stop')
}

export function finishRecordingState(): void {
  // ウォッチドッグを無効化する（正常終了・エラー・クラッシュ検知のどの経路でも、
  // 状態が確定した以上ウォッチドッグの出番はない）。
  recordingWatchdogToken++
  // 録画中（= recording.ts が pre-capture で UI を隠している）だったときだけ復元を送る。
  // done / error / render-process-gone 監視が重複発火しても、2 回目以降は no-op になり
  // post-capture を空打ちしない（スクショ側の preCaptureSent と同じ対称化）。
  const wasRecording = isRecording
  isRecording = false
  recordingMeta = null
  if (wasRecording) broadcastMessage({ type: 'post-capture' })
  setTrayRecording(false)
}

export function handleClipHotkey(): void {
  if (isMainWindowFocused()) return
  if (isRecording) stopRecording(); else startRecording()
}
