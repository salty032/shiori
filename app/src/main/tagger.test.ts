import { vi, describe, expect, it, beforeEach } from 'vitest'

const { fakeNativeImage, fakeNet } = vi.hoisted(() => ({
  fakeNativeImage: { createFromPath: vi.fn() },
  fakeNet: { fetch: vi.fn() },
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock') },
  nativeImage: fakeNativeImage,
  net: fakeNet,
}))

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>()
  return { ...actual, createHash: vi.fn(actual.createHash) }
})

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  access: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}))

import { createHash } from 'crypto'
import { readFile, access } from 'fs/promises'
import {
  parseTagsCSV, runTagger, isModelLoaded, deleteModel,
  _resetTaggerStateForTest, _modelFilePathsForTest,
} from './tagger'

const TAGS_CSV = `row_id,name,category,count,aliases
0,rating_safe,9,1,"[]"
1,test_tag,0,1,"[]"`

const fakeImage = {
  isEmpty: () => false,
  resize: () => fakeImage,
  toBitmap: () => new Uint8Array(448 * 448 * 4),
}

function makeFakeOrt(scores: number[]): { Tensor: unknown; InferenceSession: { create: ReturnType<typeof vi.fn> } } {
  const fakeSession = {
    inputNames: ['input'],
    outputNames: ['output'],
    run: vi.fn().mockResolvedValue({ output: { data: Float32Array.from(scores) } }),
    release: vi.fn().mockResolvedValue(undefined),
  }
  return {
    Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} },
    InferenceSession: { create: vi.fn().mockResolvedValue(fakeSession) },
  }
}

const SAMPLE_CSV = `row_id,name,category,count,aliases
0,rating_safe,9,1000000,"[]"
1,1girl,0,4000000,"[]"
2,solo,0,2000000,"[]"
3,aqua_(konosuba),4,50000,"[]"
4,blonde_hair,0,1000000,"[]"`

describe('parseTagsCSV', () => {
  it('ヘッダー行をスキップする', () => {
    const result = parseTagsCSV(SAMPLE_CSV)
    expect(result.every((e) => e.name !== 'row_id')).toBe(true)
  })

  it('name と category を正しくパース', () => {
    const result = parseTagsCSV(SAMPLE_CSV)
    expect(result).toContainEqual({ name: '1girl', category: 0 })
    expect(result).toContainEqual({ name: 'aqua_(konosuba)', category: 4 })
    expect(result).toContainEqual({ name: 'rating_safe', category: 9 })
  })

  it('すべての行をパース (category 9 を含む)', () => {
    const result = parseTagsCSV(SAMPLE_CSV)
    expect(result).toHaveLength(5)
  })

  it('空行をスキップ', () => {
    const csv = `header,name,category
\n
0,1girl,0\n\n
1,solo,0`
    const result = parseTagsCSV(csv)
    expect(result).toHaveLength(2)
  })

  it('フィールドが 3 個未満の行はスキップ', () => {
    const csv = `header,name,category
0,1girl`
    const result = parseTagsCSV(csv)
    expect(result).toHaveLength(0)
  })

  it('name が空の行はスキップ', () => {
    const csv = `header,name,category
0,,0
1,solo,0`
    const result = parseTagsCSV(csv)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('solo')
  })

  it('category は整数としてパース', () => {
    const csv = `header,name,category
0,1girl,0`
    const result = parseTagsCSV(csv)
    expect(result[0].category).toBe(0)
    expect(typeof result[0].category).toBe('number')
  })

  it('空 CSV (ヘッダーのみ) → 空配列', () => {
    expect(parseTagsCSV('row_id,name,category')).toHaveLength(0)
  })

  it('完全空 CSV → 空配列', () => {
    expect(parseTagsCSV('')).toHaveLength(0)
  })

  it('parts[1] が name: カンマ区切りの2番目カラム', () => {
    const csv = `h,name,cat
0,my_tag,0`
    const result = parseTagsCSV(csv)
    expect(result[0].name).toBe('my_tag')
  })
})

// S3-2: アイドル解放によって session が null になった直後に runTagger が呼ばれても、
// ダウンロード済み・検証済みのファイルは再ハッシュせずセッションだけ再ロードして
// タグ付けを成功させることを確認する（(a) 競合の自己修復 + (b) 検証キャッシュ）。
describe('runTagger: アイドル解放レースからの自己修復', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeNativeImage.createFromPath.mockReturnValue(fakeImage)
  })

  it('session=null でも verifiedPaths 済みならハッシュ再計算・再ダウンロードなしで再ロードして成功する', async () => {
    const { model, tags } = _modelFilePathsForTest()
    vi.mocked(access).mockResolvedValue(undefined)
    vi.mocked(readFile).mockResolvedValue(TAGS_CSV)
    const fakeOrt = makeFakeOrt([0, 0.5])

    _resetTaggerStateForTest({
      session: null,
      ortModule: fakeOrt,
      wasLoadedOnce: true,
      verifiedPaths: [model, tags],
    })

    const result = await runTagger('/mock/thumb.jpg')

    expect(result).toEqual([{ name: 'test_tag', category: 0, score: 0.5 }])
    expect(isModelLoaded()).toBe(true)
    expect(createHash).not.toHaveBeenCalled()
    expect(fakeNet.fetch).not.toHaveBeenCalled()
  })
})

describe('deleteModel: taggerChain 上のジョブと競合しない (S3-9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeNativeImage.createFromPath.mockReturnValue(fakeImage)
  })

  it('チェーン上に実行中のジョブがある間は release() を呼ばず、ジョブ完了後に解放する', async () => {
    const events: string[] = []
    let resolveRun: (value: { output: { data: Float32Array } }) => void = () => {}
    let runStarted = false
    const fakeSession = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: vi.fn().mockImplementation(() => {
        runStarted = true
        events.push('run:start')
        return new Promise((r) => { resolveRun = r })
      }),
      release: vi.fn().mockImplementation(async () => { events.push('release') }),
    }
    _resetTaggerStateForTest({
      session: fakeSession,
      ortModule: { Tensor: class { constructor() {} } },
      tagList: [{ name: 'test_tag', category: 0 }],
      wasLoadedOnce: true,
    })

    const jobPromise = runTagger('/mock/thumb.jpg')
    await vi.waitFor(() => expect(runStarted).toBe(true))

    const deletePromise = deleteModel()
    // ジョブが run() 内で止まっている間は release されていない（チェーン経由なら待たされる）
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fakeSession.release).not.toHaveBeenCalled()

    resolveRun({ output: { data: Float32Array.from([0, 0.5]) } })
    events.push('run:resolved')
    await jobPromise
    await deletePromise

    expect(fakeSession.release).toHaveBeenCalledTimes(1)
    expect(events.indexOf('run:resolved')).toBeLessThan(events.indexOf('release'))
    expect(isModelLoaded()).toBe(false)
  })
})
