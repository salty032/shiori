import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/mock/share-src'] }))
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
const encodeFramesMock = vi.fn((frames: { mediaTime: number; frameIndex: number; captured: boolean; verified?: string }[]) =>
  JSON.stringify(frames.map((f) => [f.mediaTime, f.frameIndex, f.captured ? 1 : 0, f.verified === 'changed' ? 2 : f.verified === 'same' ? 1 : 0])))
const decodeFramesMock = vi.fn((data: string) => {
  try {
    const rows = JSON.parse(data) as [number, number, number, number][]
    if (!Array.isArray(rows) || rows.length === 0) return null
    return rows.map(([mediaTime, frameIndex, captured, verified]) => ({
      mediaTime,
      frameIndex,
      captured: captured === 1,
      verified: verified === 2 ? 'changed' : verified === 1 ? 'same' : 'unknown',
    }))
  } catch {
    return null
  }
})

vi.mock('../db', () => ({
  listImagesForExport: () => listImagesForExportMock(),
}))

vi.mock('../db-video-frames', () => ({
  getVideoFrames: (id: number) => getVideoFramesMock(id),
  restoreVideoFrames: (...args: unknown[]) => restoreVideoFramesMock(...args),
  encodeFrames: (frames: Parameters<typeof encodeFramesMock>[0]) => encodeFramesMock(frames),
  decodeFrames: (data: string) => decodeFramesMock(data),
}))

vi.mock('../system/settings', () => ({
  // i18n の t()（ダイアログ文言など）が loadSettings().language を読むため言語を明示する。
  loadSettings: vi.fn(() => ({ smartFolders: [], language: 'ja' })),
  saveSettings: vi.fn(),
  smartFolders: vi.fn(() => [])
}))

vi.mock('../system/paths', () => ({
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
vi.mock('./ipc-import', () => ({
  MAX_IMPORT_VIDEO_SECONDS: 30,
  IMPORT_VIDEO_SECONDS_EPS: 0.5
}))

const registerCapturedMedia = vi.fn(async (_params: unknown) => ({ ok: true, id: 1 }))
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
import { setVideoThumbProvider } from '../capture/video-thumb-provider'

const extractThumbMock = vi.fn(async () => {})
const getVideoMetaMock = vi.fn(async (): Promise<{ duration: number | null; fps: number | null }> => ({ duration: null, fps: null }))

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
    encodeFramesMock.mockClear()
    decodeFramesMock.mockClear()
    getVideoMetaMock.mockResolvedValue({ duration: null, fps: null })
    setVideoThumbProvider({ extractThumb: extractThumbMock, getVideoMeta: getVideoMetaMock })
    metadataContent = JSON.stringify({ version: 1, file: 'clip.webm', captured_at: 1700000000000 })
    frameTableContent = ''
    registerShareHandlers()
  })

  it('尺が上限(30秒+誤差0.5秒)を超える動画は登録を拒否し、コピー済みファイルを削除する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: 31, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}) as { count: number; errors: string[] }

    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(result.count).toBe(0)
    expect(result.errors[0]).toMatch(/too long/)
    // 本体・サムネの両方を後始末する
    expect(unlinkMock).toHaveBeenCalledTimes(2)
  })

  it('尺が取得できない（null）動画は登録を拒否する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: null, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}) as { count: number; errors: string[] }

    expect(registerCapturedMedia).not.toHaveBeenCalled()
    expect(result.count).toBe(0)
    expect(result.errors[0]).toMatch(/duration unknown/)
  })

  it('誤差込みの境界値(30.5秒ちょうど)は登録する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: 30.5, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}) as { count: number; errors: string[] }

    expect(registerCapturedMedia).toHaveBeenCalledTimes(1)
    expect(result.count).toBe(1)
    expect(result.errors).toHaveLength(0)
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('境界超過(30.51秒)は拒否する', async () => {
    getVideoMetaMock.mockResolvedValue({ duration: 30.51, fps: null })
    const handler = handlers.get('share:import')!
    const result = await handler({}) as { count: number; errors: string[] }

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

    const result = await handlers.get('share:import')!({}) as { count: number; errors: string[] }

    expect(result).toMatchObject({ count: 1, errors: [] })
    const inserted = registerCapturedMedia.mock.calls[0][0] as { insert: { width: number | null; height: number | null } }
    expect(inserted.insert).toMatchObject({ width: 1920, height: 1080 })
    expect(restoreVideoFramesMock).toHaveBeenCalledWith(1, [
      { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
      { mediaTime: 1 / 24, frameIndex: 0, captured: false, verified: 'changed' },
    // 抜けの合計は渡さない —— 受け取った表から数え直す（restoredFrameCounts）。
    ], { ambiguous: 1 })
  })

  it('壊れたv2コマ表は無視し、動画本体は取り込む', async () => {
    metadataContent = JSON.stringify({
      version: 2,
      file: 'clip.webm',
      captured_at: 1700000000000,
      frame_table: 'not json',
    })
    getVideoMetaMock.mockResolvedValue({ duration: 10, fps: 24 })

    const result = await handlers.get('share:import')!({}) as { count: number; errors: string[] }

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
    const frameWrite = writeFileMock.mock.calls.find((call) => String(call[0]).endsWith('.frames.json'))
    expect(frameWrite?.[1]).toBe(JSON.stringify([[0, 0, 1, 0], [1 / 24, 0, 0, 2]]))
  })
})
