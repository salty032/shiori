import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    },
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  }
}))

vi.mock('./recorder-window', () => ({
  isTrustedRecorderSender: vi.fn(() => true)
}))

const finishRecordingState = vi.fn()
const getRecordingMeta = vi.fn(() => null)
const isCurrentRecordingSession = vi.fn((_id: number) => true)
vi.mock('./recording', () => ({
  finishRecordingState: () => finishRecordingState(),
  getRecordingMeta: () => getRecordingMeta(),
  isCurrentRecordingSession: (id: number) => isCurrentRecordingSession(id)
}))

const sendNotice = vi.fn()
const sendToRenderer = vi.fn()
vi.mock('../windows', () => ({
  sendNotice: (...args: unknown[]) => sendNotice(...args),
  sendToRenderer: (...args: unknown[]) => sendToRenderer(...args)
}))

vi.mock('../capture', () => ({
  computeVideoCrop: vi.fn(),
  writeCaptureFile: vi.fn(async () => '/mock/captures/cap_1.webm')
}))

vi.mock('../paths', () => ({
  ensureCaptureSubDir: vi.fn(async () => '/mock/captures'),
  thumbPathFor: vi.fn((p: string) => `${p}.thumb.png`)
}))

vi.mock('../settings', () => ({
  // i18n の t() は loadSettings().language を読むため、言語を明示する
  // （未指定だと currentLang() が undefined になり辞書引きで throw する）。
  loadSettings: vi.fn(() => ({ clipNotify: true, language: 'ja' }))
}))

vi.mock('../browser-notice', () => ({
  sendBrowserNotice: vi.fn()
}))

vi.mock('./ffmpeg', () => ({
  extractThumb: vi.fn(async () => {})
}))

// fps 列に入るのは「素材のフレームレート」だけで、その唯一の供給元が getSourceFps
// （拡張から届くコマ通知の回帰推定）。ここを差し替えて、取れた場合・取れない場合の
// 両方を確かめる。
const getSourceFps = vi.fn<() => number | null>(() => null)
vi.mock('./frame-feed', () => ({
  getSourceFps: () => getSourceFps(),
  buildFrameTable: vi.fn(() => null),
  logMatchResult: vi.fn(),
  getReportDelay: vi.fn(() => null),
  logReportInterruptions: vi.fn()
}))

const registerCapturedMedia = vi.fn(async (_params: unknown) => ({ ok: true, id: 1 }))
vi.mock('../captured-media', () => ({
  registerCapturedMedia: (params: unknown) => registerCapturedMedia(params)
}))

vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {})
}))

import { registerRecorderIpc } from './recorder-ipc'

describe('recorder:error / recorder:done - 旧セッションからの遅延メッセージ', () => {
  beforeEach(() => {
    handlers.clear()
    finishRecordingState.mockClear()
    getRecordingMeta.mockClear()
    isCurrentRecordingSession.mockClear()
    isCurrentRecordingSession.mockReturnValue(true)
    sendNotice.mockClear()
    registerCapturedMedia.mockClear()
    registerRecorderIpc()
  })

  it('recorder:error: sessionId が現在の録画と一致しなければ無視する（新しい録画状態を壊さない）', () => {
    isCurrentRecordingSession.mockReturnValue(false)
    const handler = handlers.get('recorder:error')!
    handler({}, 'aborted', 999)
    expect(finishRecordingState).not.toHaveBeenCalled()
  })

  it('recorder:error: sessionId が一致すれば通常どおり処理する', () => {
    isCurrentRecordingSession.mockReturnValue(true)
    const handler = handlers.get('recorder:error')!
    handler({}, 'aborted', 1)
    expect(finishRecordingState).toHaveBeenCalled()
  })

  it('recorder:done: sessionId が一致しなければ無視する（新しい録画を保存確定させない）', async () => {
    isCurrentRecordingSession.mockReturnValue(false)
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 5, 120, 999)
    expect(finishRecordingState).not.toHaveBeenCalled()
    expect(registerCapturedMedia).not.toHaveBeenCalled()
  })

  it('recorder:done: sessionId が一致すれば通常どおり保存する', async () => {
    isCurrentRecordingSession.mockReturnValue(true)
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 5, 120, 1)
    expect(finishRecordingState).toHaveBeenCalled()
    expect(registerCapturedMedia).toHaveBeenCalled()
  })
})

describe('recorder:done - duration 上限（多層防御）', () => {
  beforeEach(() => {
    handlers.clear()
    finishRecordingState.mockClear()
    isCurrentRecordingSession.mockClear()
    isCurrentRecordingSession.mockReturnValue(true)
    sendNotice.mockClear()
    registerCapturedMedia.mockClear()
    registerRecorderIpc()
  })

  it('上限(40秒)ちょうどは保存する', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 40, 960, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('上限(40秒)超は拒否し保存しない', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 40.1, 960, 1)
    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(finishRecordingState).toHaveBeenCalled()
    expect(sendNotice).toHaveBeenCalledWith('error', '録画データが不正なため保存できませんでした。')
  })
})

describe('recorder:done - fps に入るのは素材のフレームレートだけ', () => {
  beforeEach(() => {
    handlers.clear()
    finishRecordingState.mockClear()
    isCurrentRecordingSession.mockClear()
    isCurrentRecordingSession.mockReturnValue(true)
    sendNotice.mockClear()
    registerCapturedMedia.mockClear()
    getSourceFps.mockReset()
    getSourceFps.mockReturnValue(null)
    registerRecorderIpc()
  })

  function insertedFps(): number | null {
    const insertArg = registerCapturedMedia.mock.calls[0][0] as { insert: { fps: number | null } }
    return insertArg.insert.fps
  }

  it('素材の fps が分かればそれを保存する', async () => {
    getSourceFps.mockReturnValue(23.976)
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, 240, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(insertedFps()).toBe(23.976)
  })

  it('素材の fps が取れなければ空欄にする（画面キャプチャの供給レートで埋めない）', async () => {
    // 10秒で240枚＝24枚/秒だが、これは画面キャプチャが寄越した枚数であって素材の fps では
    // ない。以前はここを退避先にしていたため、詳細パネルに素材のものと読める数字が出ていた。
    // コマ打ちを数える用途では、空欄より誤った数字の方が害が大きい。
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, 240, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(insertedFps()).toBeNull()
  })

  it('供給枚数が不正な値でも fps に影響せず、クリップ保存は続行する', async () => {
    // fps は情報表示用であり、これが取れないことを理由に保存を失敗させない
    // （サムネ生成と同じベストエフォート方針）。
    for (const frameCount of [NaN, -5, 10 * 120 + 1]) {
      registerCapturedMedia.mockClear()
      const handler = handlers.get('recorder:done')!
      await handler({}, new ArrayBuffer(10), 10, frameCount, 1)
      expect(registerCapturedMedia, `frameCount=${frameCount}`).toHaveBeenCalled()
      expect(insertedFps(), `frameCount=${frameCount}`).toBeNull()
    }
  })
})
