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

// レコーダーは「準備 → 用意できた → 開始」の順で駆動される。実物では別プロセスの
// レンダラーが返す合図を、ここでは即座に返して手順だけを見る（キャプチャの立ち上げ
// そのものは renderer 側の話で、ここで見たいのは main の順序）。
// **返さない場合の経路（見切り）も試験するので、差し替えられる形にしておく。**
let replyReady: ((sessionId: number) => void) | null = null
const recorderSend = vi.fn((channel: string, data?: { sessionId?: number }) => {
  if (channel !== 'recorder:prepare') return
  const sessionId = data?.sessionId ?? 0
  void Promise.resolve().then(() => replyReady?.(sessionId))
})
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
    webContents: {
      isLoading: () => false,
      send: (channel: string, data?: { sessionId?: number }) => recorderSend(channel, data)
    }
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
import { waitForSteadyFrames } from './frame-feed'
import { finishRecordingState, handleClipHotkey, isCurrentlyRecording, notifyRecorderPrepared, releaseCaptureUi, startRecording, wasRecordingDisplayAmbiguous } from './recording'

replyReady = (sessionId) => notifyRecorderPrepared(sessionId)

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

// 記録を始める前の待ち（waitForSteadyFrames）の間に停止を押したとき。
// **レコーダーはまだ録画を始めていないので、停止を送っても空振りする。** 直す前は待ちが
// 明けてから録画が始まっており、押した人からは「止めたのに始まった」に見えた。
describe('落ち着くのを待っている間に停止したとき', () => {
  beforeEach(() => {
    finishRecordingState()
    vi.useFakeTimers()
    broadcastMessage.mockClear()
    recorderSend.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    finishRecordingState()
  })

  it('録画を始めずに畳む（recorder:start を送らない）', async () => {
    // 既定のモックは即座に返るので、この試験のあいだだけ実際に待たせる。
    vi.mocked(waitForSteadyFrames).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ settled: true, waitedMs: 1000, reports: 30 }), 1000))
    )
    const started = startRecording()
    // 待ちに入ったところで停止（ホットキーの再押下と同じ経路）。
    await vi.advanceTimersByTimeAsync(300)
    handleClipHotkey()
    await vi.advanceTimersByTimeAsync(3000)
    await started
    expect(recorderSend.mock.calls.map((c) => c[0])).not.toContain('recorder:start')
    expect(isCurrentlyRecording()).toBe(false)
    // 隠したプレーヤー UI は戻す。畳んだのに隠したままにしない。
    expect(broadcastMessage.mock.calls.some((c) => (c[0] as { type: string }).type === 'post-capture')).toBe(true)
  })

  // 落ち着き待ちが明けてから実際に撮り始めるまでの ARMED_CLEAR_MS（120ms）。**ここも
  // まだ録画は始まっていない。** 直す前はこの窓で押すと recorder:stop だけが空振りし、
  // 直後に recorder:start が送られて録画が始まっていた。
  it('「準備中」が消えた直後（開始を送るまでの 120ms）に押しても始めない', async () => {
    // 落ち着き待ちは即座に明ける（既定のモック）。以降の待ちは ARMED_CLEAR_MS だけ。
    const started = startRecording()
    // 待ちに入るまで進める。0 では clip-armed へ到達していない。
    await vi.advanceTimersByTimeAsync(50)
    expect(broadcastMessage.mock.calls.some((c) => (c[0] as { type: string }).type === 'clip-armed')).toBe(true)
    expect(recorderSend.mock.calls.map((c) => c[0])).not.toContain('recorder:start')
    handleClipHotkey()
    await vi.advanceTimersByTimeAsync(3000)
    await started
    expect(recorderSend.mock.calls.map((c) => c[0])).not.toContain('recorder:start')
    expect(isCurrentlyRecording()).toBe(false)
    expect(broadcastMessage.mock.calls.some((c) => (c[0] as { type: string }).type === 'post-capture')).toBe(true)
  })

  // 押していなければ従来どおり。**窓を閉じるために開始そのものを遅らせていないこと。**
  it('押さなければ 120ms 後に開始を送る', async () => {
    const started = startRecording()
    await vi.advanceTimersByTimeAsync(3000)
    await started
    expect(recorderSend.mock.calls.map((c) => c[0])).toContain('recorder:start')
    expect(isCurrentlyRecording()).toBe(true)
  })
})

// **画面キャプチャを立ち上げてから、落ち着くのを待つ。**
//
// 直す前はこの順が逆で、待ちは負荷のかかっていないページを見ていた（＝何も見ていない）。
// 立ち上がりの荒れはそのまま録画の頭に入り、実測では 1.2 秒で 30 コマが描かれていなかった。
// 順序そのものが直しの中身なので、順序を固定する。
describe('画面キャプチャの立ち上げと落ち着き待ちの順序', () => {
  beforeEach(() => {
    finishRecordingState()
    vi.useFakeTimers()
    broadcastMessage.mockClear()
    recorderSend.mockClear()
    vi.mocked(waitForSteadyFrames).mockClear()
    vi.mocked(sendBrowserNotice).mockClear()
    replyReady = (sessionId) => notifyRecorderPrepared(sessionId)
  })

  afterEach(() => {
    vi.useRealTimers()
    replyReady = (sessionId) => notifyRecorderPrepared(sessionId)
    finishRecordingState()
  })

  it('準備 → 落ち着き待ち → 開始 の順で進む', async () => {
    let settleStartedAfterPrepare = false
    vi.mocked(waitForSteadyFrames).mockImplementationOnce(async () => {
      settleStartedAfterPrepare = recorderSend.mock.calls.some((c) => c[0] === 'recorder:prepare')
      return { settled: true, waitedMs: 0, reports: 30 }
    })
    await startRecordingSettled()
    // **待ちに入る時点でキャプチャの立ち上げを頼み終えている**こと。
    expect(settleStartedAfterPrepare).toBe(true)
    expect(recorderSend.mock.calls.map((c) => c[0])).toEqual(['recorder:prepare', 'recorder:start'])
  })

  it('用意できたが返るまで待ちに入らない（返ってこなければ録画しない）', async () => {
    replyReady = null // レコーダーが立ち上げに失敗して黙り込んだ状態
    const started = startRecording()
    await vi.advanceTimersByTimeAsync(1000)
    // まだ見切りに達していない。待ちにも入らず、開始も送らない。
    expect(waitForSteadyFrames).not.toHaveBeenCalled()
    expect(recorderSend.mock.calls.map((c) => c[0])).not.toContain('recorder:start')
    await vi.advanceTimersByTimeAsync(5000)
    await started
    expect(recorderSend.mock.calls.map((c) => c[0])).not.toContain('recorder:start')
    expect(isCurrentlyRecording()).toBe(false)
    // 掴んだままにしないための停止と、隠した UI の復帰。**録画しないのだから両方要る。**
    expect(recorderSend.mock.calls.map((c) => c[0])).toContain('recorder:stop')
    expect(postCaptureCount()).toBeGreaterThan(0)
    expect(sendBrowserNotice).toHaveBeenCalledWith('error', 'notice.recorderPrepareFailed')
  })

  it('立ち上げを待っている間に停止を押したら、その場で畳む（見切りを待たない）', async () => {
    replyReady = null
    const started = startRecording()
    await vi.advanceTimersByTimeAsync(200)
    handleClipHotkey()
    // **押した直後に畳まれること。** 見切りの 4 秒を待ってからでは、その間ずっと
    // プレーヤーの UI が隠れたままトレイも録画中のままになる。
    await vi.advanceTimersByTimeAsync(50)
    expect(isCurrentlyRecording()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await started
    expect(recorderSend.mock.calls.map((c) => c[0])).not.toContain('recorder:start')
    expect(recorderSend.mock.calls.map((c) => c[0])).toContain('recorder:stop')
    expect(isCurrentlyRecording()).toBe(false)
    // 押して畳んだだけなので、失敗の通知は出さない。
    expect(sendBrowserNotice).not.toHaveBeenCalledWith('error', 'notice.recorderPrepareFailed')
  })
})

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
