import { describe, expect, it, vi, beforeEach } from 'vitest'

// ipc-images.ts は './windows' 経由で 'electron' に依存する（BrowserWindow 等）。
// backfillFps 自体はどれも呼ばないが、モジュール読み込み時に import は解決される必要がある。
vi.mock('electron', () => ({
  dialog: {},
  nativeImage: {},
  app: { getPath: vi.fn(() => '/mock'), isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  shell: {}
}))

const listImagesMissingFps = vi.fn()
const setFps = vi.fn()
vi.mock('../db', () => ({
  listImages: vi.fn(), countImages: vi.fn(), listImagesAll: vi.fn(), listSites: vi.fn(),
  listSiteCounts: vi.fn(), listAllTags: vi.fn(), listTagCounts: vi.fn(), getImage: vi.fn(),
  deleteImage: vi.fn(), deleteImagesBulk: vi.fn(), updateImageTitle: vi.fn(), updateImageMemo: vi.fn(),
  listImagesMissingThumb: vi.fn(() => []), listImagesForThumbCheck: vi.fn(() => []), setThumbPath: vi.fn(),
  listImagesMissingFps: (...args: unknown[]) => listImagesMissingFps(...args),
  setFps: (...args: unknown[]) => setFps(...args)
}))

vi.mock('../system/paths', () => ({
  resolveRealCapturePath: vi.fn(async (p: string) => p),
  thumbPathFor: vi.fn((p: string) => `${p}.thumb.png`)
}))

const countFramesMock = vi.fn()
vi.mock('../capture/video-thumb-provider', () => ({
  getVideoThumbProvider: () => ({ extractThumb: vi.fn(), getVideoMeta: vi.fn(), countFrames: countFramesMock })
}))

import { backfillFps } from './ipc-images'

describe('backfillFps - 既存クリップへの fps 遡及埋め', () => {
  beforeEach(() => {
    listImagesMissingFps.mockReset()
    setFps.mockReset()
    countFramesMock.mockReset()
  })

  it('実フレーム数と duration から fps を算出して setFps で更新する', async () => {
    listImagesMissingFps.mockReturnValue([
      { id: 1, filepath: '/cap/a.webm', duration: 1.242 },
      { id: 2, filepath: '/cap/b.webm', duration: 5 }
    ])
    countFramesMock
      .mockResolvedValueOnce(16)  // 16 / 1.242 ≈ 12.88（可変フレームレートで fps 表記が無い実例）
      .mockResolvedValueOnce(0)   // 数え取れなかった（0枚）行は書き込まない

    await backfillFps()

    expect(setFps).toHaveBeenCalledTimes(1)
    expect(setFps).toHaveBeenCalledWith(1, 12.88)
  })

  it('duration が無い/0以下の行は countFrames を呼ばずスキップする', async () => {
    listImagesMissingFps.mockReturnValue([
      { id: 1, filepath: '/cap/a.webm', duration: null },
      { id: 2, filepath: '/cap/b.webm', duration: 0 }
    ])

    await backfillFps()

    expect(countFramesMock).not.toHaveBeenCalled()
    expect(setFps).not.toHaveBeenCalled()
  })

  it('1件のデコードが失敗しても残りの処理を続ける（非致命）', async () => {
    listImagesMissingFps.mockReturnValue([
      { id: 1, filepath: '/cap/a.webm', duration: 10 },
      { id: 2, filepath: '/cap/b.webm', duration: 5 }
    ])
    countFramesMock
      .mockRejectedValueOnce(new Error('ffmpeg timed out'))
      .mockResolvedValueOnce(150)

    await backfillFps()

    expect(setFps).toHaveBeenCalledTimes(1)
    expect(setFps).toHaveBeenCalledWith(2, 30)
  })

  it('対象行が無ければ何もしない', async () => {
    listImagesMissingFps.mockReturnValue([])

    await backfillFps()

    expect(countFramesMock).not.toHaveBeenCalled()
    expect(setFps).not.toHaveBeenCalled()
  })

  it('実行中の多重呼び出しは即座に戻り、二重に走らない（再入防止）', async () => {
    listImagesMissingFps.mockReturnValue([{ id: 1, filepath: '/cap/a.webm', duration: 1 }])
    let resolveCount: (v: number) => void = () => {}
    countFramesMock.mockReturnValue(new Promise((resolve) => { resolveCount = resolve }))

    const first = backfillFps()
    const second = backfillFps()
    resolveCount(24)
    await Promise.all([first, second])

    expect(listImagesMissingFps).toHaveBeenCalledTimes(1)
  })
})
