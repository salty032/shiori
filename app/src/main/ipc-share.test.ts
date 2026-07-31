import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/mock/share-src'] }))
  }
}))

vi.mock('./windows', () => ({
  getMainWindow: vi.fn(() => null),
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  },
  sendToRenderer: vi.fn(),
  safeExternalUrl: vi.fn((url: string) => url)
}))

vi.mock('./db', () => ({
  listImagesForExport: vi.fn(() => [])
}))

vi.mock('./settings', () => ({
  // i18n の t()（ダイアログ文言など）が loadSettings().language を読むため言語を明示する。
  loadSettings: vi.fn(() => ({ smartFolders: [], language: 'ja' })),
  saveSettings: vi.fn(),
  smartFolders: vi.fn(() => [])
}))

vi.mock('./paths', () => ({
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
vi.mock('./captured-media', () => ({
  registerCapturedMedia: (params: unknown) => registerCapturedMedia(params)
}))

const statMock = vi.fn(async (path: string) => {
  if (String(path).endsWith('metadata.jsonl')) return { isFile: () => true, size: 100 } as never
  if (String(path).endsWith('settings.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return { isFile: () => true, size: 1024 } as never
})
const readFileMock = vi.fn(async (path: string) => {
  if (String(path).endsWith('metadata.jsonl')) return metadataContent
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

import { registerShareHandlers } from './ipc-share'
import { setVideoThumbProvider } from './video-thumb-provider'

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
    getVideoMetaMock.mockResolvedValue({ duration: null, fps: null })
    setVideoThumbProvider({ extractThumb: extractThumbMock, getVideoMeta: getVideoMetaMock, countFrames: vi.fn() })
    metadataContent = JSON.stringify({ version: 1, file: 'clip.webm', captured_at: 1700000000000 })
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
})
