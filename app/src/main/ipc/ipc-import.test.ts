// ローカルインポートが「画像として取り込めたか」を確かめる経路。
//
// 動画は尺を取れないものをコピー前に弾いているのに、画像は拡張子と 500MB 以下という
// 条件だけで通していた。中身が画像でないファイル（拡張子だけ .png に変えたもの・転送で
// 壊れたもの）が「取り込み ○件」に数えられ、開けない項目としてライブラリに残る。
//
// 一方で nativeImage が読めない ＝ 壊れている、ではない。Electron が対応を明記しているのは
// PNG / JPEG だけで、webp / gif は正常でもデコードできない（表示は Chromium が原本を
// 直接描くので問題なく見える）。弾く対象を PNG / JPEG に限る理由がここにある。
import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

const { fakeNativeImage } = vi.hoisted(() => ({
  fakeNativeImage: { createFromPath: vi.fn() },
}))

vi.mock('electron', () => ({
  clipboard: { readImage: vi.fn(), writeImage: vi.fn() },
  nativeImage: fakeNativeImage,
}))

vi.mock('../system/windows', () => ({
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  },
}))

const statMock = vi.fn()
const copyFileMock = vi.fn().mockResolvedValue(undefined)
const unlinkMock = vi.fn().mockResolvedValue(undefined)

vi.mock('fs/promises', () => ({
  stat: (...args: unknown[]) => statMock(...args),
  copyFile: (...args: unknown[]) => copyFileMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: (...args: unknown[]) => unlinkMock(...args),
}))

vi.mock('../db', () => ({ getImage: vi.fn(() => null) }))

vi.mock('../system/paths', () => ({
  ensureCaptureSubDir: vi.fn(async () => '/mock/captures'),
  thumbPathFor: vi.fn((p: string, ext = '.jpg') => `${p}${ext}`),
  resolveRealCapturePath: vi.fn(async (p: string) => p),
}))

vi.mock('./ipc-drag', () => ({ isDragTempPath: vi.fn(() => false) }))

const createImageThumbMock = vi.fn()
vi.mock('../capture/image-thumb', () => ({
  createImageThumb: (...args: unknown[]) => createImageThumbMock(...args),
}))

vi.mock('../capture/video-thumb-provider', () => ({
  getVideoThumbProvider: () => ({
    getVideoMeta: vi.fn(async () => ({ duration: 5, fps: 30 })),
    extractThumb: vi.fn(async () => undefined),
  }),
}))

const registerCapturedMediaMock = vi.fn(async (_arg: unknown) => ({ ok: true as const, id: 1 }))
vi.mock('../capture/captured-media', () => ({
  registerCapturedMedia: (arg: unknown) => registerCapturedMediaMock(arg),
}))

vi.mock('../system/busy', () => ({ beginTask: vi.fn(), endTask: vi.fn() }))

import { CH } from '../../shared/api'
import { registerImportHandlers } from './ipc-import'

type ImportResult = { count: number; errors: string[]; truncated: boolean }

// nativeImage: デコードできたファイルだけ寸法を返す。
function decodableAs(size: { width: number; height: number } | null): void {
  fakeNativeImage.createFromPath.mockReturnValue({
    isEmpty: () => size === null,
    getSize: () => size ?? { width: 0, height: 0 },
  })
}

async function importFiles(paths: string[]): Promise<ImportResult> {
  return await handlers.get(CH.importFiles)!({}, paths) as ImportResult
}

describe('importFiles: 画像の中身を確かめる', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    registerImportHandlers()
    statMock.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 1024,
      mtimeMs: 1_700_000_000_000,
    })
    copyFileMock.mockResolvedValue(undefined)
    unlinkMock.mockResolvedValue(undefined)
    registerCapturedMediaMock.mockResolvedValue({ ok: true as const, id: 1 })
  })

  it('読める PNG は今までどおり取り込む', async () => {
    decodableAs({ width: 1920, height: 1080 })
    createImageThumbMock.mockResolvedValue(undefined)

    const result = await importFiles(['C:/src/shot.png'])

    expect(result.count).toBe(1)
    expect(result.errors).toEqual([])
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('中身が画像でない .png は件数に数えず、コピーも残さない', async () => {
    // 拡張子だけ .png に変えたファイル。寸法もサムネも取れない。
    decodableAs(null)
    createImageThumbMock.mockRejectedValue(new Error('nativeImage: failed to load'))

    const result = await importFiles(['C:/src/not-really.png'])

    expect(result.count).toBe(0)
    expect(result.errors).toEqual(['not a valid image: not-really.png'])
    // DB に「開けない項目」を作らない。
    expect(registerCapturedMediaMock).not.toHaveBeenCalled()
    // コピー済みの実体を置き去りにしない（無駄なディスク消費）。
    expect(unlinkMock).toHaveBeenCalledTimes(1)
  })

  it('サムネだけ作れなかった PNG は取り込む（表示は原本で足りる）', async () => {
    decodableAs({ width: 800, height: 600 })
    createImageThumbMock.mockRejectedValue(new Error('write failed'))

    const result = await importFiles(['C:/src/thumbless.png'])

    expect(result.count).toBe(1)
    expect(result.errors).toEqual([])
  })

  it('webp / gif は nativeImage が読めなくても弾かない', async () => {
    // Electron の nativeImage は PNG / JPEG しか保証しない。ここで弾くと
    // 正常な webp・gif が「壊れている」扱いになる（Chromium は普通に表示できる）。
    decodableAs(null)
    createImageThumbMock.mockRejectedValue(new Error('nativeImage: failed to load'))

    const result = await importFiles(['C:/src/anim.gif', 'C:/src/pic.webp'])

    expect(result.count).toBe(2)
    expect(result.errors).toEqual([])
  })
})
