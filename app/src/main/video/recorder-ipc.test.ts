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

describe('recorder:done - fps の算出とベストエフォート方針', () => {
  beforeEach(() => {
    handlers.clear()
    finishRecordingState.mockClear()
    isCurrentRecordingSession.mockClear()
    isCurrentRecordingSession.mockReturnValue(true)
    sendNotice.mockClear()
    registerCapturedMedia.mockClear()
    registerRecorderIpc()
  })

  function insertedFps(): number | null {
    const insertArg = registerCapturedMedia.mock.calls[0][0] as { insert: { fps: number | null } }
    return insertArg.insert.fps
  }

  it('正常なフレーム数から fps を算出して保存する', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, 240, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(insertedFps()).toBe(24)
  })

  it('フレーム数が不正（NaN）でも fps を null にしてクリップ保存は続行する', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, NaN, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(insertedFps()).toBeNull()
  })

  it('フレーム数が負でも fps を null にしてクリップ保存は続行する', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, -5, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(insertedFps()).toBeNull()
  })

  it('フレーム数が過大（多層防御の上限超え）でも fps を null にしてクリップ保存は続行する', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, 10 * 120 + 1, 1)
    expect(registerCapturedMedia).toHaveBeenCalled()
    expect(insertedFps()).toBeNull()
  })
})
