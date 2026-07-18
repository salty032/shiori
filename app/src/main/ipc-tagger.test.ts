import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('./windows', () => ({
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  },
  sendToRenderer: vi.fn()
}))

const addTag = vi.fn()
vi.mock('./db', () => ({
  addTag: (...args: unknown[]) => addTag(...args),
  getImageTags: vi.fn(() => []),
  removeImageTag: vi.fn(),
  addTagsBulk: vi.fn(),
  listImagesForRetag: vi.fn(() => []),
  getImageTagsBulk: vi.fn(() => []),
  addTagBulk: vi.fn(),
  removeTagBulk: vi.fn(),
  removeTagFromAllImages: vi.fn(),
  deleteAllAiTags: vi.fn(() => 0)
}))

vi.mock('./tagger', () => ({
  ensureModel: vi.fn(),
  runTagger: vi.fn(async () => []),
  isModelDownloaded: vi.fn(() => false),
  deleteModel: vi.fn(),
  cancelModelDownload: vi.fn()
}))

vi.mock('./paths', () => ({
  resolveRealCapturePath: vi.fn(async (p: string) => p)
}))

vi.mock('./busy', () => ({ beginTask: vi.fn(), endTask: vi.fn() }))

import { registerTaggerHandlers } from './ipc-tagger'

describe('tagger:addTag - source省略時のデフォルト', () => {
  beforeEach(() => {
    handlers.clear()
    addTag.mockClear()
    registerTaggerHandlers()
  })

  it('source を省略すると manual として追加される（taggerAddTagBulk・db層のデフォルトと一致）', () => {
    const handler = handlers.get('tagger:addTag')!
    handler({}, 1, 'foo')
    expect(addTag).toHaveBeenCalledWith(1, 'foo', 'manual')
  })

  it('source: ai を明示すれば ai として追加される', () => {
    const handler = handlers.get('tagger:addTag')!
    handler({}, 1, 'foo', 'ai')
    expect(addTag).toHaveBeenCalledWith(1, 'foo', 'ai')
  })
})
