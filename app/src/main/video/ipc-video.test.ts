import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('../system/windows', () => ({
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  }
}))

const mockImage = {
  id: 1,
  filepath: '/mock/captures/cap_1.webm',
  media_type: 'video' as const,
  duration: 10,
  fps: 23.92,
  width: 1920,
  height: 1080,
  title: null,
  current_time: null,
  url: null,
  source: null
}

const getVideoFrames = vi.fn(() => null as import('../db-video-frames').StoredFrame[] | null)
const saveVideoFrames = vi.fn()
const setFrameCounts = vi.fn()

vi.mock('../db', () => ({
  getImage: vi.fn(() => mockImage),
  setFrameCounts: (...args: unknown[]) => setFrameCounts(...args),
}))

vi.mock('../db-tags', () => ({
  getImageTags: vi.fn(() => []),
}))

vi.mock('../db-video-frames', () => ({
  getVideoFrames: () => getVideoFrames(),
  saveVideoFrames: (...args: unknown[]) => saveVideoFrames(...args),
}))

vi.mock('../system/paths', () => ({
  resolveRealCapturePath: vi.fn(async (p: string) => p),
  ensureCaptureSubDir: vi.fn(async () => '/mock/captures'),
  thumbPathFor: vi.fn((p: string) => `${p}.thumb.png`)
}))

const trimWebm = vi.fn(async () => {})
const extractThumb = vi.fn(async () => { throw new Error('thumb extraction failed') })
const getVideoFramePts = vi.fn(async (_path: string): Promise<number[]> => [])

vi.mock('./ffmpeg', () => ({
  trimWebm: (...args: unknown[]) => trimWebm(...(args as [])),
  extractThumb: (...args: unknown[]) => extractThumb(...(args as [])),
  getVideoFramePts: (path: string) => getVideoFramePts(path),
  getTimelineStrip: vi.fn(async () => Buffer.from([])),
  getVideoDuration: vi.fn(async () => 10)
}))

const registerCapturedMedia = vi.fn(async (_params: unknown) => ({ ok: true, id: 99 }))
vi.mock('../capture/captured-media', () => ({
  registerCapturedMedia: (params: unknown) => registerCapturedMedia(params)
}))

vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {})
}))

import { registerVideoHandlers, buildClipFrames, findClipGaps, frameQualityOf } from './ipc-video'
import { FRAME_QUALITY } from '../../shared/api.video'
import type { StoredFrame } from '../db-video-frames'
import { unlink } from 'fs/promises'

// 表から抜けている区間。**撮り逃し（流用）とは別物で、コマ自体が表に無い。**
// コマ送りするとその区間が飛ぶのに、枚数にも割合にも現れないので画面に出さないと気づけない。
describe('findClipGaps（表から抜けている区間）', () => {
  const SRC = 1 / 23.976
  const rows = (counts: number[]): { mediaTime: number; frameIndex: number; captured: boolean }[] => {
    let t = 0
    return counts.map((step, i) => {
      t += i === 0 ? 0 : step * SRC
      return { mediaTime: t, frameIndex: i, captured: true }
    })
  }

  it('連続していれば抜けは無い', () => {
    expect(findClipGaps(rows([1, 1, 1, 1, 1, 1]))).toEqual([])
  })

  it('飛んでいる位置と枚数を返す', () => {
    // 実測（2026-08-26・image 255）は 1〜2 コマの飛びが 8 箇所続いたあと 8 コマ・11 コマ。
    expect(findClipGaps(rows([1, 1, 3, 1, 9, 1]))).toEqual([
      { afterIndex: 1, missing: 2 },
      { afterIndex: 3, missing: 8 }
    ])
  })

  it('素材のコマ長は表の間隔から出す（fps 列は空のことがある）', () => {
    // 60fps 素材でも、同じ「1 コマぶん」を基準に数えられること。
    const t = (i: number): number => i / 60
    const frames = [0, 1, 2, 5, 6].map((i) => ({ mediaTime: t(i), frameIndex: i, captured: true }))
    expect(findClipGaps(frames)).toEqual([{ afterIndex: 2, missing: 2 }])
  })
})

describe('buildClipFrames（コマ送りに渡す並びと、コマごとの確からしさ）', () => {
  // ファイルには 4 枚のフレームがあり、素材のコマは 3 つ。2 コマ目は専用の絵が撮れていない。
  const pts = [0, 0.02, 0.04, 0.06]

  it('素材のコマ表があれば、素材のコマ順に並べ替えて sourceBased を立てる', () => {
    const table: StoredFrame[] = [
      { mediaTime: 0, frameIndex: 0, captured: true },
      { mediaTime: 0.04, frameIndex: 1, captured: false, verified: 'changed' },
      { mediaTime: 0.08, frameIndex: 3, captured: true }
    ]
    const frames = buildClipFrames(pts, table)
    expect(frames.sourceBased).toBe(true)
    expect(frames.pts).toEqual([0, 0.02, 0.06])
    expect(frames.quality).toEqual([
      FRAME_QUALITY.captured, FRAME_QUALITY.reused, FRAME_QUALITY.captured
    ])
  })

  // 表が無いクリップ（従来の録画・取り込み動画）。**素材のコマ単位ではないことを
  // 呼び出し側が画面に出せるよう、黙って同じ形で返さない。**
  it('表が無ければファイルのフレームをそのまま返し、sourceBased を伏せる', () => {
    const frames = buildClipFrames(pts, null)
    expect(frames.sourceBased).toBe(false)
    expect(frames.pts).toEqual(pts)
    expect(frames.quality).toEqual([])
  })

  // frameIndex がファイルの範囲外＝表とファイルの対応が取れていない。半端に解釈すると
  // 別のコマの絵を指したままコマ送りが動くので、退避させる方がよい（db.ts の decodeFrames と同じ判断）。
  it('表の指す先がファイルの範囲外なら、その行は使わない', () => {
    const table: StoredFrame[] = [
      { mediaTime: 0, frameIndex: 0, captured: true },
      { mediaTime: 0.04, frameIndex: 99, captured: true }
    ]
    const frames = buildClipFrames(pts, table)
    expect(frames.pts).toEqual([0])
    // 1 行も残らなければファイルのフレームへ退避する
    expect(buildClipFrames(pts, [{ mediaTime: 0, frameIndex: 99, captured: true }]).sourceBased).toBe(false)
  })
})

describe('frameQualityOf（そのコマを信じてよいか）', () => {
  it('撮れているコマは検証結果に関係なく captured', () => {
    // 検証（frame-verify.ts）が結果を付けるのは撮り逃したコマだけなので、
    // captured=true の行に載っている値は意味を持たない。
    expect(frameQualityOf({ mediaTime: 0, frameIndex: 0, captured: true })).toBe(FRAME_QUALITY.captured)
    expect(frameQualityOf({ mediaTime: 0, frameIndex: 0, captured: true, verified: 'changed' })).toBe(FRAME_QUALITY.captured)
  })

  it('撮り逃したコマは検証結果で「未検証 / 実害なし / 要確認」に分かれる', () => {
    const missed = { mediaTime: 0, frameIndex: 0, captured: false }
    expect(frameQualityOf(missed)).toBe(FRAME_QUALITY.reused)
    expect(frameQualityOf({ ...missed, verified: 'unknown' })).toBe(FRAME_QUALITY.reused)
    // 「前後が同じ＝実害なし」の灰色表示は廃止した（2026-08-26）。前後が同じでも間の
    // 1 コマだけ違う（ショックコマ）可能性は絵が無い以上消えず、確定できないことを
    // 確定したように見せていたため。検証結果は残すが、画面では流用と同じ扱いにする。
    expect(frameQualityOf({ ...missed, verified: 'same' })).toBe(FRAME_QUALITY.reused)
    expect(frameQualityOf({ ...missed, verified: 'changed' })).toBe(FRAME_QUALITY.reused)
  })
})

describe('video:trim - サムネ生成失敗時の挙動', () => {
  beforeEach(() => {
    handlers.clear()
    trimWebm.mockClear()
    extractThumb.mockClear()
    getVideoFramePts.mockReset()
    getVideoFramePts.mockResolvedValue([])
    getVideoFrames.mockReset()
    getVideoFrames.mockReturnValue(null)
    saveVideoFrames.mockReset()
    setFrameCounts.mockReset()
    registerCapturedMedia.mockClear()
    registerCapturedMedia.mockResolvedValue({ ok: true, id: 99 })
    vi.mocked(unlink).mockClear()
    registerVideoHandlers()
  })

  it('extractThumb が失敗しても、録画保存時と同様にサムネなしで登録を継続する', async () => {
    const handler = handlers.get('video:trim')!
    const result = await handler({}, 1, 2, 8) as { ok: boolean; newId?: number }

    expect(trimWebm).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.newId).toBe(99)
    // 生成済みのトリム済み動画を削除してはいけない
    expect(unlink).not.toHaveBeenCalled()
    // サムネなしで登録される
    const insertArg = registerCapturedMedia.mock.calls[0][0] as { insert: { thumb_path: string | null } }
    expect(insertArg.insert.thumb_path).toBeNull()
  })

  it('元クリップの fps をそのまま引き継ぐ（トリムしても表示が消えない）', async () => {
    const handler = handlers.get('video:trim')!
    await handler({}, 1, 2, 8)

    const insertArg = registerCapturedMedia.mock.calls[0][0] as { insert: { fps: number | null } }
    expect(insertArg.insert.fps).toBe(23.92)
  })

  it('記録画素数も引き継ぐ（トリムは時間方向に切るだけで解像度は変わらない）', async () => {
    const handler = handlers.get('video:trim')!
    await handler({}, 1, 2, 8)

    const insertArg = registerCapturedMedia.mock.calls[0][0] as { insert: { width: number | null; height: number | null } }
    expect(insertArg.insert.width).toBe(1920)
    expect(insertArg.insert.height).toBe(1080)
  })

  it('元クリップのフレーム表を切り出し、新しいクリップへ保存する', async () => {
    getVideoFrames.mockReturnValue([
      { mediaTime: 2, frameIndex: 2, captured: true },
      { mediaTime: 4, frameIndex: 4, captured: true },
    ])
    getVideoFramePts.mockImplementation(async (path) =>
      path === mockImage.filepath
        ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        : [0, 1, 2, 3, 4, 5, 6])

    const handler = handlers.get('video:trim')!
    const result = await handler({}, 1, 2, 8)

    expect(result).toEqual({ ok: true, newId: 99 })
    expect(saveVideoFrames).toHaveBeenCalledWith(99, [
      { mediaTime: 2, frameIndex: 0, captured: true },
      { mediaTime: 4, frameIndex: 2, captured: true },
    ])
    expect(setFrameCounts).toHaveBeenCalledWith(99, 0, 2, 0)
  })
})
