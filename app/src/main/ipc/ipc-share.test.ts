import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

// 画面で選ばれた読み込み方（SettingsDataTab が聞いて渡す）。既定は今までの取り込み方。
let importMode: unknown = 'receive'

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/mock/share-src'] })),
  }
}))

vi.mock('../system/windows', () => ({
  getMainWindow: vi.fn(() => null),
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  },
  sendToRenderer: vi.fn(),
  safeExternalUrl: vi.fn((url: string) => url)
}))

const listImagesForExportMock = vi.fn(() => [] as Record<string, unknown>[])
const getVideoFramesMock = vi.fn((_id: number) => null as { mediaTime: number; frameIndex: number; captured: boolean; verified?: string }[] | null)
const restoreVideoFramesMock = vi.fn()
// コマ表の符号化は本物を通す（手写しのモックは本物の形から外れても気づけない）。
const encodeFramesMock = vi.fn()
const decodeFramesMock = vi.fn()

const getTimesheetMock = vi.fn((_id: number) => null as string | null)
const saveTimesheetMock = vi.fn()

vi.mock('../db/db', () => ({
  listImagesForExport: () => listImagesForExportMock(),
  getTimesheet: (id: number) => getTimesheetMock(id),
  saveTimesheet: (...args: unknown[]) => saveTimesheetMock(...args),
}))

vi.mock('../db/db-video-frames', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/db-video-frames')>()
  return {
    getVideoFrames: (id: number) => getVideoFramesMock(id),
    restoreVideoFrames: (...args: unknown[]) => restoreVideoFramesMock(...args),
    encodeFrames: (frames: Parameters<typeof actual.encodeFrames>[0]) => {
      encodeFramesMock(frames)
      return actual.encodeFrames(frames)
    },
    decodeFrames: (data: string) => {
      decodeFramesMock(data)
      return actual.decodeFrames(data)
    },
  }
})

vi.mock('../system/settings', () => ({
  // i18n の t()（ダイアログ文言など）が loadSettings().language を読むため言語を明示する。
  loadSettings: vi.fn(() => ({ language: 'ja' })),
  saveSettings: vi.fn(),
}))

vi.mock('../system/paths', () => ({
  captureFileName: (ts: number, ext: string) => `cap_${ts}_${Math.random().toString(36).slice(2)}${ext}`,
  resolveRealCapturePath: vi.fn(async (p: string) => p),
  ensureCaptureSubDir: vi.fn(async () => '/mock/captures'),
  thumbnailDir: vi.fn(() => '/mock/thumbnails'),
  thumbPathFor: vi.fn((p: string) => `${p}.thumb.png`)
}))

vi.mock('./ipc-validation', () => ({
  formatDateForFilename: vi.fn(() => '20260719_000000'),
  uniqueExportFilename: vi.fn(async (_dir: string, name: string) => name)
}))

// 30秒上限の実装（ipc-import.ts）は他にも多数の依存を引き込むため、ここでは定数のみ
// 差し替える。上限値自体が変わったら share 側もこの値で追随することを確認する。
// 尺の判定は本物を使う（境界値を確かめるテストなので）。
vi.mock('./ipc-import', async (importOriginal) => ({
  importDurationError: (await importOriginal<typeof import('./ipc-import')>()).importDurationError
}))

const registerCapturedMedia = vi.fn(async (_params: unknown) => ({ ok: true, id: 1 }))
vi.mock('../video/ffmpeg', () => ({
  extractThumb: (videoPath: string, thumbPath: string) => extractThumbMock(videoPath, thumbPath),
  getVideoMeta: (videoPath: string) => getVideoMetaMock(videoPath),
}))
vi.mock('../capture/captured-media', () => ({
  registerCapturedMedia: (params: unknown) => registerCapturedMedia(params)
}))

const statMock = vi.fn(async (path: string) => {
  if (String(path).endsWith('metadata.jsonl')) return { isFile: () => true, size: 100 } as never
  if (String(path).endsWith('settings.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return { isFile: () => true, size: 1024 } as never
})
const readFileMock = vi.fn(async (path: string) => {
  if (String(path).endsWith('metadata.jsonl')) return metadataContent
  if (String(path).endsWith('.frames.json')) return frameTableContent
  throw new Error('unexpected readFile')
})
const copyFileMock = vi.fn(async (..._args: unknown[]) => {})
const mkdirMock = vi.fn(async (..._args: unknown[]) => {})
const writeFileMock = vi.fn(async (..._args: unknown[]) => {})
const unlinkMock = vi.fn(async (..._args: unknown[]) => {})

vi.mock('fs/promises', () => ({
  stat: (path: string) => statMock(path),
  readFile: (path: string) => readFileMock(path),
  copyFile: (...args: unknown[]) => copyFileMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  unlink: (...args: unknown[]) => unlinkMock(...args)
}))

let metadataContent = ''
let frameTableContent = ''

import { registerShareHandlers } from './ipc-share'
import { decodeFrames } from '../db/db-video-frames'

const extractThumbMock = vi.fn(async (_videoPath: string, _thumbPath: string) => {})
const getVideoMetaMock = vi.fn(async (_videoPath: string): Promise<{ duration: number | null; fps: number | null }> => ({ duration: null, fps: null }))

describe('share:import - 動画の30秒上限（著作権対策）', () => {
  beforeEach(() => {
    handlers.clear()
    statMock.mockClear()
    readFileMock.mockClear()
    copyFileMock.mockClear()
    mkdirMock.mockClear()
    writeFileMock.mockClear()
    unlinkMock.mockClear()
    registerCapturedMedia.mockClear()
    registerCapturedMedia.mockResolvedValue({ ok: true, id: 1 })
    extractThumbMock.mockClear()
    extractThumbMock.mockResolvedValue(undefined)
    getVideoMetaMock.mockClear()
    listImagesForExportMock.mockClear()
    listImagesForExportMock.mockReturnValue([])
    getVideoFramesMock.mockClear()
    getVideoFramesMock.mockReturnValue(null)
    restoreVideoFramesMock.mockClear()
    saveTimesheetMock.mockClear()
    importMode = 'receive'
    encodeFramesMock.mockClear()
    decodeFramesMock.mockClear()
    getVideoMetaMock.mockResolvedValue({ duration: null, fps: null })
    metadataContent = JSON.stringify({ version: 1, file: 'clip.webm', captured_at: 1700000000000 })
    frameTableContent = ''
    registerShareHandlers()
  })

  it('尺が上限(30秒+誤差0.5秒)を超える動画は登録を拒否し、コピー済みファイルを削除する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: 31, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}, importMode) as { count: number; errors: string[] }

    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(result.count).toBe(0)
    expect(result.errors[0]).toMatch(/too long/)
    // 本体・サムネの両方を後始末する
    expect(unlinkMock).toHaveBeenCalledTimes(2)
  })

  it('尺が取得できない（null）動画は登録を拒否する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: null, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}, importMode) as { count: number; errors: string[] }

    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(result.count).toBe(0)
    expect(result.errors[0]).toMatch(/duration unknown/)
  })

  it('誤差込みの境界値(30.5秒ちょうど)は登録する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: 30.5, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}, importMode) as { count: number; errors: string[] }

    expect(registerCapturedMedia).toHaveBeenCalledTimes(1)
    expect(result.count).toBe(1)
    expect(result.errors).toHaveLength(0)
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('境界超過(30.51秒)は拒否する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: 30.51, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}, importMode) as { count: number; errors: string[] }

    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(result.count).toBe(0)
    expect(result.errors[0]).toMatch(/too long/)
  })

  it('v2動画は画素数とコマ表・品質情報を復元する', async () => {
    frameTableContent = JSON.stringify([
      [0, 0, 1, 0],
      [1 / 24, 0, 0, 2],
    ])
    metadataContent = JSON.stringify({
      version: 2,
      file: 'clip.webm',
      captured_at: 1700000000000,
      width: 1920,
      height: 1080,
      frame_table_file: 'clip.webm.frames.json',
      ambiguous_frames: 1,
      unreported_frames: 3,
    })
    getVideoMetaMock.mockResolvedValue({ duration: 10, fps: 24 })

    const result = await handlers.get('share:import')!({}, importMode) as { count: number; errors: string[] }

    expect(result).toMatchObject({ count: 1, errors: [] })
    const inserted = registerCapturedMedia.mock.calls[0][0] as { insert: { width: number | null; height: number | null } }
    expect(inserted.insert).toMatchObject({ width: 1920, height: 1080 })
    expect(restoreVideoFramesMock).toHaveBeenCalledWith(1, [
      { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
      { mediaTime: 1 / 24, frameIndex: 0, captured: false, verified: 'changed' },
    // 抜けの合計は渡さない —— 受け取った表から数え直す（restoredFrameCounts）。
    ], { ambiguous: 1 })
  })

  // 打った位置は表の行で覚えているので、表を戻せたときだけ戻す。表の外を指す行は落とす。
  it('コマ表と一緒に、手で打ったタイムシートも戻す（表の外を指す行は落とす）', async () => {
    frameTableContent = JSON.stringify([[0, 0, 1, 0], [1 / 24, 1, 1, 0]])
    metadataContent = JSON.stringify({
      version: 2, file: 'clip.webm', captured_at: 1700000000000,
      frame_table_file: 'clip.webm.frames.json',
      timesheet: '[[0,"1"],[1,"",""],[5,"9"]]',
    })
    getVideoMetaMock.mockResolvedValue({ duration: 10, fps: 24 })

    const result = await handlers.get('share:import')!({}, importMode) as { count: number; errors: string[] }

    expect(result).toMatchObject({ count: 1, errors: [] })
    expect(saveTimesheetMock).toHaveBeenCalledWith(1, '[[0,"1"],[1]]')
  })

  it('コマ表を戻せなかった動画には、タイムシートも戻さない', async () => {
    metadataContent = JSON.stringify({
      version: 2, file: 'clip.webm', captured_at: 1700000000000,
      frame_table: 'not json',
      timesheet: '[[0,"1"]]',
    })
    getVideoMetaMock.mockResolvedValue({ duration: 10, fps: 24 })

    const result = await handlers.get('share:import')!({}, importMode) as { count: number; errors: string[] }

    expect(result).toMatchObject({ count: 1, errors: [] })
    expect(saveTimesheetMock).not.toHaveBeenCalled()
  })

  it('自分のライブラリとして戻すと、撮ったもの・取り込んだものの区別と日時を書き出したときのまま登録する', async () => {
    importMode = 'restore'
    metadataContent = [
      JSON.stringify({ version: 2, file: 'a.png', captured_at: 1600000000000, origin: 'capture' }),
      JSON.stringify({ version: 2, file: 'b.png', captured_at: 1650000000000, origin: 'import', original_captured_at: 1500000000000 }),
    ].join('\n')

    const result = await handlers.get('share:import')!({}, importMode) as { count: number }

    expect(result.count).toBe(2)
    const inserts = registerCapturedMedia.mock.calls.map((call) => (call[0] as { insert: Record<string, unknown> }).insert)
    expect(inserts[0]).toMatchObject({ source: 'capture', captured_at: 1600000000000, original_captured_at: null })
    expect(inserts[1]).toMatchObject({ source: 'import', captured_at: 1650000000000, original_captured_at: 1500000000000 })
  })

  it('受け取った素材として取り込むと、全部を今日の取り込みとして登録する', async () => {
    metadataContent = JSON.stringify({ version: 2, file: 'a.png', captured_at: 1600000000000, origin: 'capture' })

    await handlers.get('share:import')!({}, importMode)

    const insert = (registerCapturedMedia.mock.calls[0][0] as { insert: Record<string, unknown> }).insert
    expect(insert).toMatchObject({ source: 'import', original_captured_at: 1600000000000 })
    expect(insert.captured_at).not.toBe(1600000000000)
  })

  it('読み込み方が分からない呼び出しでは、何も取り込まない（どちらかに倒すと混ざるか日付が変わる）', async () => {
    importMode = 'bogus'
    metadataContent = JSON.stringify({ version: 2, file: 'a.png', captured_at: 1600000000000 })

    const result = await handlers.get('share:import')!({}, importMode)

    expect(result).toEqual({ canceled: true })
    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(copyFileMock).not.toHaveBeenCalled()
  })

  it('壊れたv2コマ表は無視し、動画本体は取り込む', async () => {
    metadataContent = JSON.stringify({
      version: 2,
      file: 'clip.webm',
      captured_at: 1700000000000,
      frame_table: 'not json',
    })
    getVideoMetaMock.mockResolvedValue({ duration: 10, fps: 24 })

    const result = await handlers.get('share:import')!({}, importMode) as { count: number; errors: string[] }

    expect(result).toMatchObject({ count: 1, errors: [] })
    expect(restoreVideoFramesMock).not.toHaveBeenCalled()
  })
})

describe('share:export - v2研究用メタデータ', () => {
  beforeEach(() => {
    handlers.clear()
    writeFileMock.mockClear()
    listImagesForExportMock.mockReset()
    getVideoFramesMock.mockReset()
    getTimesheetMock.mockReset()
    getTimesheetMock.mockReturnValue(null)
    encodeFramesMock.mockClear()
    registerShareHandlers()
  })

  it('動画の画素数・コマ表・品質カウントを書き出す', async () => {
    listImagesForExportMock.mockReturnValue([{
      id: 7,
      filepath: '/mock/captures/clip.webm',
      thumb_path: null,
      media_type: 'video',
      duration: 10,
      fps: 24,
      width: 1920,
      height: 1080,
      ambiguous_frames: 1,
      unreported_frames: 2,
      url: null,
      current_time: 12,
      title: 'clip',
      manualTags: ['manual'],
      memo: null,
      captured_at: 1700000000000,
    }])
    getVideoFramesMock.mockReturnValue([
      { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
      { mediaTime: 1 / 24, frameIndex: 0, captured: false, verified: 'changed' },
    ])

    const result = await handlers.get('share:export')!({}) as { count: number }

    expect(result.count).toBe(1)
    const metadataWrite = writeFileMock.mock.calls.find((call) => String(call[0]).endsWith('metadata.jsonl'))
    expect(metadataWrite).toBeDefined()
    const entry = JSON.parse(String(metadataWrite![1]))
    expect(entry).toMatchObject({
      version: 2,
      width: 1920,
      height: 1080,
      ambiguous_frames: 1,
      unreported_frames: 2,
    })
    expect(entry.frame_table_file).toBe('clip.webm.frames.json')
    expect(entry.timesheet).toBeUndefined()
    const frameWrite = writeFileMock.mock.calls.find((call) => String(call[0]).endsWith('.frames.json'))
    // 読み戻すと元の表になること（符号化の形そのものは db-video-frames のテストが見る）。
    expect(decodeFrames(String(frameWrite?.[1]))).toEqual([
      { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
      { mediaTime: 1 / 24, frameIndex: 0, captured: false, verified: 'changed' },
    ])
  })
  it('手で打ったタイムシートを、コマ表と一緒に書き出す', async () => {
    listImagesForExportMock.mockReturnValue([{
      id: 7, filepath: '/mock/captures/clip.webm', thumb_path: null, media_type: 'video',
      duration: 10, fps: 24, width: null, height: null, ambiguous_frames: null, unreported_frames: null,
      url: null, current_time: null, title: null, manualTags: [], memo: null, captured_at: 1700000000000,
    }])
    getVideoFramesMock.mockReturnValue([{ mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' }])
    getTimesheetMock.mockReturnValue('[[0,"A"]]')

    await handlers.get('share:export')!({})

    expect(getTimesheetMock).toHaveBeenCalledWith(7)
    const metadataWrite = writeFileMock.mock.calls.find((call) => String(call[0]).endsWith('metadata.jsonl'))
    expect(JSON.parse(String(metadataWrite![1])).timesheet).toBe('[[0,"A"]]')
  })
})

describe('share:import - 1件の失敗で残りを巻き添えにしない', () => {
  beforeEach(() => {
    handlers.clear()
    statMock.mockClear()
    readFileMock.mockClear()
    copyFileMock.mockClear()
    mkdirMock.mockClear()
    unlinkMock.mockClear()
    registerCapturedMedia.mockClear()
    registerCapturedMedia.mockResolvedValue({ ok: true, id: 1 })
    metadataContent = [
      JSON.stringify({ version: 1, file: 'a.png', captured_at: 1700000000000 }),
      JSON.stringify({ version: 1, file: 'b.png', captured_at: 1700000000000 }),
      JSON.stringify({ version: 1, file: 'c.png', captured_at: 1700000000000 }),
    ].join('\n')
    registerShareHandlers()
  })

  it('途中の1件が例外で落ちても、残りの取り込みを続けて件数を返す', async () => {
    // 2件目だけ想定外の例外（保存先が満杯・DBが書けない等）で落とす
    registerCapturedMedia
      .mockResolvedValueOnce({ ok: true, id: 1 })
      .mockRejectedValueOnce(new Error('ENOSPC'))
      .mockResolvedValueOnce({ ok: true, id: 3 })

    const result = await handlers.get('share:import')!({}, importMode) as { count: number; errors: string[] }

    expect(registerCapturedMedia).toHaveBeenCalledTimes(3)
    expect(result.count).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('b.png')
  })

  it('全件が例外で落ちても、失敗した件数がそのまま返る（途中で打ち切らない）', async () => {
    registerCapturedMedia.mockRejectedValue(new Error('ENOSPC'))

    const result = await handlers.get('share:import')!({}, importMode) as { count: number; errors: string[] }

    expect(result.count).toBe(0)
    expect(result.errors).toHaveLength(3)
  })
})
