import { describe, expect, it, vi, beforeEach } from 'vitest'

const insertImage = vi.fn((_params: unknown) => 1)
const getImage = vi.fn((_id: number) => null)
const addTagsBulk = vi.fn((..._args: unknown[]) => {})
const sendToRenderer = vi.fn((..._args: unknown[]) => {})
const sendNotice = vi.fn((..._args: unknown[]) => {})
const unlink = vi.fn(async (..._args: unknown[]) => {})

vi.mock('../db', () => ({
  insertImage: (params: unknown) => insertImage(params),
  getImage: (id: number) => getImage(id),
}))
vi.mock('../db-tags', () => ({ addTagsBulk: (...args: unknown[]) => addTagsBulk(...args) }))
vi.mock('../system/windows', () => ({
  sendToRenderer: (...args: unknown[]) => sendToRenderer(...args),
  sendNotice: (...args: unknown[]) => sendNotice(...args),
}))
vi.mock('../system/i18n', () => ({ t: (key: string) => key }))
vi.mock('fs/promises', () => ({ unlink: (...args: unknown[]) => unlink(...args) }))
vi.mock('./tagger', () => ({
  canAutoTag: vi.fn(async () => false),
  ensureModel: vi.fn(async () => {}),
  runTagger: vi.fn(async () => []),
}))

import { registerCapturedMedia } from './captured-media'

const params = {
  insert: { filepath: '/mock/a.png', captured_at: 1700000000000 } as never,
  filePath: '/mock/a.png',
  extraTags: [{ name: 'tag', source: 'manual' as const }],
}

describe('registerCapturedMedia - タグが付かなくても撮ったものは捨てない', () => {
  beforeEach(() => {
    insertImage.mockClear()
    insertImage.mockReturnValue(1)
    addTagsBulk.mockClear()
    sendNotice.mockClear()
    sendToRenderer.mockClear()
    unlink.mockClear()
  })

  // DB が書けない（満杯・破損）ときだけ起きる経路。以前はここで例外が外へ抜け、
  // 呼び出し側の後始末で実体ファイルだけ消えて DB の行が残っていた。
  it('タグ登録が落ちても行は残り、成功として返す', async () => {
    addTagsBulk.mockImplementation(() => { throw new Error('SQLITE_FULL') })

    const result = await registerCapturedMedia(params)

    expect(result).toEqual({ ok: true, id: 1, tagsFailed: true })
    // 撮ったものは消さない
    expect(unlink).not.toHaveBeenCalled()
  })

  // 黙って減らすのが一番まずい。タグが消えたことは後から画面を見ても分からない。
  it('タグ登録が落ちたことを画面に出す', async () => {
    addTagsBulk.mockImplementation(() => { throw new Error('SQLITE_FULL') })

    await registerCapturedMedia(params)

    expect(sendNotice).toHaveBeenCalledWith('warning', 'notice.tagsNotSaved')
  })

  it('タグ登録が通れば tagsFailed は false で、通知も出さない', async () => {
    addTagsBulk.mockImplementation(() => {})

    const result = await registerCapturedMedia(params)

    expect(result).toEqual({ ok: true, id: 1, tagsFailed: false })
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('画像の登録自体が落ちたら、実体ファイルを消して失敗を返す', async () => {
    insertImage.mockImplementation(() => { throw new Error('SQLITE_FULL') })

    const result = await registerCapturedMedia(params) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(unlink).toHaveBeenCalledWith('/mock/a.png')
    expect(addTagsBulk).not.toHaveBeenCalled()
  })
})
