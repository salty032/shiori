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

// 記録開始前の「落ち着くまで待つ」は即座に済ませる（実時間を待たせない）。
// 待ちの中身は frame-feed 側のテストで見る。ここで見たいのは録画開始の手順。
vi.mock('./frame-feed', () => ({
  startFrameFeed: vi.fn(),
  stopFrameFeed: vi.fn(),
  waitForSteadyFrames: vi.fn(async () => ({ settled: true, waitedMs: 0, reports: 30 }))
}))
vi.mock('../system/tray', () => ({ setTrayRecording: vi.fn() }))
vi.mock('../browser/timecode', () => ({
  getLastTimecode: vi.fn(() => ({ title: 'テスト', currentTime: 12, url: 'https://example.test/watch' })),
  getLastTimecodeAt: vi.fn(() => Date.now()),
  setLastTimecode: vi.fn()
}))
vi.mock('../browser/browser-notice', () => ({ sendBrowserNotice: vi.fn() }))
vi.mock('../system/i18n', () => ({ t: (key: string) => key }))

import { desktopCapturer } from 'electron'
import { sendBrowserNotice } from '../browser/browser-notice'
import { finishRecordingState, isCurrentlyRecording, releaseCaptureUi, startRecording, wasRecordingDisplayAmbiguous } from './recording'

function postCaptureCount(): number {
  return broadcastMessage.mock.calls.filter(([msg]) => (msg as { type: string }).type === 'post-capture').length
}

// startRecording は「準備中」の表示が消えるのを待ってから撮り始める（ARMED_CLEAR_MS）。
// ここは実時間を止めているので、進めてやらないと録画が始まらない。
async function startRecordingSettled(): Promise<void> {
  const started = startRecording()
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(500)
  await started
}

describe('プレーヤー UI の復帰（post-capture）', () => {
  beforeEach(async () => {
    // 前のテストの録画状態を持ち越さない（モジュール変数のため）。
    finishRecordingState()
    // 録画開始の待ち時間（request-timecode の打ち切り・ハング保険）を実時間で待たない。
    vi.useFakeTimers()
    broadcastMessage.mockClear()
    await startRecordingSettled()
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
    await startRecordingSettled()
    broadcastMessage.mockClear()
    releaseCaptureUi()
    expect(postCaptureCount()).toBe(1)
  })
})

// 録画する画面が確定できないケース。display_id は環境によって空で返ることがあり、
// 照合が外れたときに先頭の画面へ落とすと、別のモニターを 30 秒撮った動画が他と
// 見分けの付かない形で残る。録画は続ける（当たっている可能性もある）が、
// 保証できないことはログではなく画面へ出す。
describe('録画する画面が特定できないとき', () => {
  const getSources = desktopCapturer.getSources as unknown as ReturnType<typeof vi.fn>
  const notice = sendBrowserNotice as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    finishRecordingState()
    vi.useFakeTimers()
    notice.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    finishRecordingState()
  })

  it('画面が複数あってどれとも一致しないとき、警告を出したうえで録画する', async () => {
    getSources.mockResolvedValueOnce([
      { id: 'screen:9:0', display_id: '9' },
      { id: 'screen:8:0', display_id: '8' },
    ])
    await startRecordingSettled()

    expect(wasRecordingDisplayAmbiguous()).toBe(true)
    expect(notice).toHaveBeenCalledWith('warning', 'notice.recordingDisplayUncertain')
    // 撮り逃しのほうが実害が大きいので、警告を出しても録画自体は止めない。
    expect(isCurrentlyRecording()).toBe(true)
  })

  it('画面が 1 つなら、一致しなくても黙って撮る（先頭がその画面に決まっている）', async () => {
    getSources.mockResolvedValueOnce([{ id: 'screen:9:0', display_id: '' }])
    await startRecordingSettled()

    expect(wasRecordingDisplayAmbiguous()).toBe(false)
    expect(notice).not.toHaveBeenCalled()
    expect(isCurrentlyRecording()).toBe(true)
  })

  it('一致する画面があれば警告を出さない', async () => {
    getSources.mockResolvedValueOnce([
      { id: 'screen:9:0', display_id: '9' },
      { id: 'screen:1:0', display_id: '1' },
    ])
    await startRecordingSettled()

    expect(wasRecordingDisplayAmbiguous()).toBe(false)
    expect(notice).not.toHaveBeenCalled()
  })

  it('前の録画で立った警告フラグを次の録画へ持ち越さない', async () => {
    getSources.mockResolvedValueOnce([
      { id: 'screen:9:0', display_id: '9' },
      { id: 'screen:8:0', display_id: '8' },
    ])
    await startRecordingSettled()
    expect(wasRecordingDisplayAmbiguous()).toBe(true)

    finishRecordingState()
    notice.mockClear()
    await startRecordingSettled()

    expect(wasRecordingDisplayAmbiguous()).toBe(false)
    expect(notice).not.toHaveBeenCalled()
  })
})
