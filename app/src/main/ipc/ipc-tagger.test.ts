import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('../system/windows', () => ({
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  },
  sendToRenderer: vi.fn()
}))

const addTag = vi.fn()
vi.mock('../db', () => ({
  listImagesForRetag: vi.fn(() => [])
}))

vi.mock('../db-tags', () => ({
  addTag: (...args: unknown[]) => addTag(...args),
  getImageTags: vi.fn(() => []),
  removeImageTag: vi.fn(),
  addTagsBulk: vi.fn(),
  getImageTagsBulk: vi.fn(() => []),
  addTagBulk: vi.fn(),
  removeTagBulk: vi.fn(),
  removeTagFromAllImages: vi.fn(),
  deleteAllAiTags: vi.fn(() => 0)
}))

vi.mock('../capture/tagger', () => ({
  ensureModel: vi.fn(),
  runTagger: vi.fn(async () => []),
  isModelDownloaded: vi.fn(() => false),
  deleteModel: vi.fn(),
  cancelModelDownload: vi.fn()
}))

vi.mock('../system/paths', () => ({
  resolveRealCapturePath: vi.fn(async (p: string) => p)
}))

vi.mock('../system/busy', () => ({ beginTask: vi.fn(), endTask: vi.fn() }))

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
