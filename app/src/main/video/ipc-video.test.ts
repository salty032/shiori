import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('../windows', () => ({
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
  title: null,
  current_time: null,
  url: null,
  source: null
}

vi.mock('../db', () => ({
  getImage: vi.fn(() => mockImage),
  getImageTags: vi.fn(() => [])
}))

vi.mock('../paths', () => ({
  resolveRealCapturePath: vi.fn(async (p: string) => p),
  ensureCaptureSubDir: vi.fn(async () => '/mock/captures'),
  thumbPathFor: vi.fn((p: string) => `${p}.thumb.png`)
}))

const trimWebm = vi.fn(async () => {})
const extractThumb = vi.fn(async () => { throw new Error('thumb extraction failed') })

vi.mock('./ffmpeg', () => ({
  trimWebm: (...args: unknown[]) => trimWebm(...(args as [])),
  extractThumb: (...args: unknown[]) => extractThumb(...(args as [])),
  getVideoFramePts: vi.fn(async () => []),
  getTimelineStrip: vi.fn(async () => Buffer.from([])),
  getVideoDuration: vi.fn(async () => 10)
}))

const registerCapturedMedia = vi.fn(async (_params: unknown) => ({ ok: true, id: 99 }))
vi.mock('../captured-media', () => ({
  registerCapturedMedia: (params: unknown) => registerCapturedMedia(params)
}))

vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {})
}))

import { registerVideoHandlers, buildClipFrames, frameQualityOf } from './ipc-video'
import { FRAME_QUALITY } from '../../shared/api.video'
import type { StoredFrame } from '../db'
import { unlink } from 'fs/promises'

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
      FRAME_QUALITY.captured, FRAME_QUALITY.reusedChanged, FRAME_QUALITY.captured
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
    expect(frameQualityOf({ ...missed, verified: 'same' })).toBe(FRAME_QUALITY.reusedSame)
    expect(frameQualityOf({ ...missed, verified: 'changed' })).toBe(FRAME_QUALITY.reusedChanged)
  })
})

describe('video:trim - サムネ生成失敗時の挙動', () => {
  beforeEach(() => {
    handlers.clear()
    trimWebm.mockClear()
    extractThumb.mockClear()
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
})
