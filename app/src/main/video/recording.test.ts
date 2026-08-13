// 録画中に隠したプレーヤー UI をいつ戻すか（post-capture）の経路。
//
// 復帰の合図は 2 か所から出る：録画が実際に止まった時点の releaseCaptureUi() と、
// 保存まで終わった時点の finishRecordingState()。**片方に寄せられない** — 前者だけだと
// レコーダーがクラッシュした録画で UI が隠れたまま残り、後者だけだと重い後処理のぶん
// 数秒待たされる。二重に送ると content.js 側が復帰タイマーを張り直して逆に遅くなるので、
// 「必ず 1 回だけ出る」ことをここで固定する。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const broadcastMessage = vi.fn()
let extensionListener: ((msg: unknown) => void) | null = null
vi.mock('../browser/ws-server', () => ({
  broadcastMessage: (msg: unknown) => {
    broadcastMessage(msg)
    // request-timecode には拡張が即応答する前提でテストする（応答が来ない経路は
    // 別の分岐＝録画自体が始まらない）。
    const m = msg as { type: string; requestId?: string }
    if (m.type === 'request-timecode') {
      // 実際の応答は WS 越しに別のタスクで届く。同期で返すと、送信側がまだ打ち切り
      // タイマーを組み立てている途中に応答処理が走ってしまい、実物と違う順序になる。
      void Promise.resolve().then(() => extensionListener?.({
        type: 'timecode',
        requestId: m.requestId,
        title: 'テスト',
        currentTime: 12,
        url: 'https://example.test/watch',
        videoRect: { left: 0, top: 0, width: 640, height: 360 },
        windowLeft: 0, windowTop: 0, windowWidth: 800, windowHeight: 600,
        innerWidth: 800, innerHeight: 600
      }))
    }
  },
  onExtensionMessage: (cb: (msg: unknown) => void) => {
    extensionListener = cb
    return () => { extensionListener = null }
  }
}))

const recorderSend = vi.fn()
vi.mock('electron', () => ({
  shell: { beep: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => [{ id: 'screen:0:0', display_id: '1' }]) },
  screen: { getDisplayNearestPoint: vi.fn(() => ({ id: 1, displayFrequency: 60 })) }
}))

vi.mock('../capture/capture', () => ({
  canCaptureVideo: vi.fn(() => true),
  getBrowserWindowRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 600 })),
  setBrowserWindowPos: vi.fn(),
  setVideoRect: vi.fn()
}))

vi.mock('../system/settings', () => ({
  loadSettings: vi.fn(() => ({ clipMaxSeconds: 30, language: 'ja' }))
}))

vi.mock('../system/windows', () => ({ isMainWindowFocused: vi.fn(() => false) }))

vi.mock('./recorder-window', () => ({
  getRecorderWindow: vi.fn(() => ({
    isDestroyed: () => false,
    webContents: { isLoading: () => false, send: (...args: unknown[]) => recorderSend(...args) }
  })),
  createRecorderWindow: vi.fn(),
  setPendingDisplaySource: vi.fn()
}))

vi.mock('./frame-feed', () => ({ startFrameFeed: vi.fn(), stopFrameFeed: vi.fn() }))
vi.mock('../system/tray', () => ({ setTrayRecording: vi.fn() }))
vi.mock('../browser/timecode', () => ({
  getLastTimecode: vi.fn(() => ({ title: 'テスト', currentTime: 12, url: 'https://example.test/watch' })),
  getLastTimecodeAt: vi.fn(() => Date.now()),
  setLastTimecode: vi.fn()
}))
vi.mock('../browser/browser-notice', () => ({ sendBrowserNotice: vi.fn() }))
vi.mock('../system/i18n', () => ({ t: (key: string) => key }))

import { finishRecordingState, isCurrentlyRecording, releaseCaptureUi, startRecording } from './recording'

function postCaptureCount(): number {
  return broadcastMessage.mock.calls.filter(([msg]) => (msg as { type: string }).type === 'post-capture').length
}

describe('プレーヤー UI の復帰（post-capture）', () => {
  beforeEach(async () => {
    // 前のテストの録画状態を持ち越さない（モジュール変数のため）。
    finishRecordingState()
    // 録画開始の待ち時間（request-timecode の打ち切り・ハング保険）を実時間で待たない。
    vi.useFakeTimers()
    broadcastMessage.mockClear()
    await startRecording()
    expect(isCurrentlyRecording()).toBe(true)
    broadcastMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('録画が止まった時点で復帰を流す（保存の完了を待たない）', () => {
    releaseCaptureUi()
    expect(postCaptureCount()).toBe(1)
    // 拡張側のホスト別待ち（スクショ用の 1.6〜3.2 秒）を踏ませないための印。
    expect(broadcastMessage).toHaveBeenCalledWith({ type: 'post-capture', immediate: true })
    // 録画状態そのものは保存が終わるまで動かさない。
    expect(isCurrentlyRecording()).toBe(true)
  })

  it('保存まで終わっても二度は送らない（content.js 側の復帰タイマーが張り直されるため）', () => {
    releaseCaptureUi()
    finishRecordingState()
    expect(postCaptureCount()).toBe(1)
  })

  it('復帰の合図が届かなかった録画では、保存の完了時に送る（UI を隠したまま残さない）', () => {
    finishRecordingState()
    expect(postCaptureCount()).toBe(1)
  })

  it('録画が終わった後の releaseCaptureUi は空打ちしない', () => {
    finishRecordingState()
    broadcastMessage.mockClear()
    releaseCaptureUi()
    expect(postCaptureCount()).toBe(0)
  })

  it('次の録画では改めて復帰を流せる（抑止フラグが持ち越されない）', async () => {
    releaseCaptureUi()
    finishRecordingState()
    await startRecording()
    broadcastMessage.mockClear()
    releaseCaptureUi()
    expect(postCaptureCount()).toBe(1)
  })
})
