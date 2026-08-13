import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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
const releaseCaptureUi = vi.fn()
vi.mock('./recording', () => ({
  finishRecordingState: () => finishRecordingState(),
  getRecordingMeta: () => getRecordingMeta(),
  isCurrentRecordingSession: (id: number) => isCurrentRecordingSession(id),
  releaseCaptureUi: () => releaseCaptureUi(),
  // 次の録画のビットレートの根拠として実測供給を戻す口（recording.ts）。保存経路の検証には
  // 関わらないので受け流す。
  recordMeasuredSupply: () => {},
  // ログ（[clip-bitrate]）で「ストリームが画面より縮んでいないか」を並べるためだけの値。
  // 保存経路には関与しないので測っていない扱いで返す。
  getRecordingDisplayPixels: () => null
}))

const sendNotice = vi.fn()
const sendToRenderer = vi.fn()
vi.mock('../system/windows', () => ({
  sendNotice: (...args: unknown[]) => sendNotice(...args),
  sendToRenderer: (...args: unknown[]) => sendToRenderer(...args)
}))

vi.mock('../capture/capture', () => ({
  computeVideoCrop: vi.fn(),
  writeCaptureFile: vi.fn(async () => '/mock/captures/cap_1.webm')
}))

vi.mock('../system/paths', () => ({
  ensureCaptureSubDir: vi.fn(async () => '/mock/captures'),
  thumbPathFor: vi.fn((p: string) => `${p}.thumb.png`)
}))

vi.mock('../system/settings', () => ({
  // i18n の t() は loadSettings().language を読むため、言語を明示する
  // （未指定だと currentLang() が undefined になり辞書引きで throw する）。
  loadSettings: vi.fn(() => ({ clipNotify: true, language: 'ja' }))
}))

vi.mock('../browser/browser-notice', () => ({
  sendBrowserNotice: vi.fn()
}))

vi.mock('./ffmpeg', () => ({
  extractThumb: vi.fn(async () => {})
}))

// fps 列に入るのは「素材のフレームレート」だけで、その唯一の供給元が getSourceFps
// （拡張から届くコマ通知の回帰推定）。ここを差し替えて、取れた場合・取れない場合の
// 両方を確かめる。
const getSourceFps = vi.fn<() => number | null>(() => null)
const buildFrameTable = vi.fn<(drawnAt: number[]) => null>(() => null)
vi.mock('./frame-feed', () => ({
  getSourceFps: () => getSourceFps(),
  buildFrameTable: (drawnAt: number[]) => buildFrameTable(drawnAt),
  logMatchResult: vi.fn(),
  getReportDelay: vi.fn(() => null),
  logReportInterruptions: vi.fn()
}))

const registerCapturedMedia = vi.fn(async (_params: unknown) => ({ ok: true, id: 1 }))
vi.mock('../capture/captured-media', () => ({
  registerCapturedMedia: (params: unknown) => registerCapturedMedia(params)
}))

vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {})
}))

import { registerRecorderIpc } from './recorder-ipc'
import { isTrustedRecorderSender } from './recorder-window'

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

describe('recorder:stopped - UI 復帰だけを先に流す', () => {
  beforeEach(() => {
    handlers.clear()
    finishRecordingState.mockClear()
    releaseCaptureUi.mockClear()
    isCurrentRecordingSession.mockClear()
    isCurrentRecordingSession.mockReturnValue(true)
    vi.mocked(isTrustedRecorderSender).mockReturnValue(true)
    registerRecorderIpc()
  })

  // 送信元検証を false のまま次の describe へ持ち越すと、そちらが全部無視されて通らなくなる。
  afterEach(() => { vi.mocked(isTrustedRecorderSender).mockReturnValue(true) })

  it('録画状態は触らない（保存の完了ではないため）', () => {
    handlers.get('recorder:stopped')!({}, 1)
    expect(releaseCaptureUi).toHaveBeenCalled()
    expect(finishRecordingState).not.toHaveBeenCalled()
  })

  it('sessionId が現在の録画と一致しなければ無視する（新しい録画の UI を戻さない）', () => {
    isCurrentRecordingSession.mockReturnValue(false)
    handlers.get('recorder:stopped')!({}, 999)
    expect(releaseCaptureUi).not.toHaveBeenCalled()
  })

  it('レコーダーウィンドウ以外からの送信は無視する', () => {
    vi.mocked(isTrustedRecorderSender).mockReturnValue(false)
    handlers.get('recorder:stopped')!({}, 1)
    expect(releaseCaptureUi).not.toHaveBeenCalled()
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

  // 記録画素数は画質を語るときの母数。1 コマあたりのビット数は解像度をまたぐと
  // 比べられないので、これが残らないと後から画質の判断ができない。
  it('記録した画素数を保存する', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, 240, 1, [], {
      callbacks: 240, presented: 240, skippedByCallback: 0, duplicateSuppressed: 0,
      cropWidth: 1920, cropHeight: 1080
    })
    const insert = registerCapturedMedia.mock.calls[0][0] as { insert: { width: number | null; height: number | null } }
    expect(insert.insert.width).toBe(1920)
    expect(insert.insert.height).toBe(1080)
  })

  it('画素数が届かなければ空欄にする（推定で埋めない）', async () => {
    const handler = handlers.get('recorder:done')!
    await handler({}, new ArrayBuffer(10), 10, 240, 1)
    const insert = registerCapturedMedia.mock.calls[0][0] as { insert: { width: number | null; height: number | null } }
    expect(insert.insert.width).toBeNull()
    expect(insert.insert.height).toBeNull()
  })

  it('取得上限（120枚/秒）いっぱいの供給でもフレーム表を捨てない', () => {
    // 妥当性の上限（MAX_FRAME_RATE_FOR_VALIDATION）を取得上限と同値にすると、上限まで
    // 出ている良い録画ほど「不正な値」として弾かれ、コマ精度を失う。
    // 30 秒 × 120枚/秒 = 3600 枚。
    buildFrameTable.mockClear()
    const drawnAt = Array.from({ length: 3600 }, (_, i) => 1_700_000_000_000 + i * (1000 / 120))
    const handler = handlers.get('recorder:done')!
    return Promise.resolve(handler({}, new ArrayBuffer(10), 30, 3600, 1, drawnAt)).then(() => {
      expect(buildFrameTable).toHaveBeenCalled()
      expect(buildFrameTable.mock.calls[0][0]).toHaveLength(3600)
    })
  })
})
