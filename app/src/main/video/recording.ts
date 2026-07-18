// 動画クリップ録画のステートマシン。録画状態（isRecording / isRecordingStarting /
// recordingMeta）を保持し、開始・停止・状態リセット・ホットキー処理を提供する。
import { shell, desktopCapturer, screen as electronScreen } from 'electron'
import { broadcastMessage, onExtensionMessage, type ExtensionMessage } from '../ws-server'
import { canCaptureVideo, getBrowserWindowRect, setBrowserWindowPos, setVideoRect } from '../capture'
import { loadSettings } from '../settings'
import { isMainWindowFocused } from '../windows'
import { getRecorderWindow, createRecorderWindow } from './recorder-window'
import { setTrayRecording } from '../tray'
import { getLastTimecode, setLastTimecode } from '../timecode'
import { sendBrowserNotice } from '../browser-notice'

export interface RecordingMeta {
  title: string | null
  currentTime: number | null
  url: string | null
}

let isRecording = false
let isRecordingStarting = false
let recordingMeta: RecordingMeta | null = null

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
    getRecorderWindow()!.webContents.send('recorder:start', {
      sourceId,
      fps: 30,
      maxSeconds: settings.clipMaxSeconds ?? 60
    })
    setTrayRecording(true)
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
