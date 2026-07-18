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

import { registerVideoHandlers } from './ipc-video'
import { unlink } from 'fs/promises'

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
})
