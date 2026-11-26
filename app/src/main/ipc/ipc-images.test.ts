// 一括削除（images:deleteBulk）と選択の書き出し（images:export）の回帰テスト。
//
// 守っているのは 2 つ。**DB の行を先に消し、実ファイルは後**（逆だとファイルの無い行が一覧に残る）。
// **ファイルが消せなくても DB は戻さない**（戻すと消したはずの行が復活する。孤立した原本は残る——自動回収はサムネイルだけ）。
import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const calls: string[] = []

vi.mock('electron', () => ({ dialog: {} }))

vi.mock('../system/windows', () => ({
  getMainWindow: vi.fn(),
  sendToRenderer: vi.fn(),
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  },
}))

const unlinkMock = vi.fn(async (p: string) => { calls.push(`unlink ${p}`) })
const copyFileMock = vi.fn(async (_src: string, dest: string) => { calls.push(`copy ${dest}`) })
vi.mock('fs/promises', () => ({
  access: vi.fn(), stat: vi.fn(),
  copyFile: (src: string, dest: string) => copyFileMock(src, dest),
  unlink: (p: string) => unlinkMock(p),
}))

// 書き出し（images:export）用。元ファイルがあるかは existing で決める。
const existing = new Set<string>()
vi.mock('../system/file-exists', () => ({ fileExists: vi.fn(async (p: string) => existing.has(p)) }))
const openDialogMock = vi.fn(async () => ({ canceled: false, filePaths: ['/dest'] }))
vi.mock('../system/dialogs', () => ({ showOpenDialogOver: () => openDialogMock() }))

type StoredImage = { id?: number; filepath: string; thumb_path: string | null; title?: string; captured_at?: string; current_time?: number | null; media_type?: string }
const stored = new Map<number, StoredImage>()
const deleteImagesBulkMock = vi.fn((ids: number[]) => { calls.push(`db ${ids.join(',')}`) })
vi.mock('../db/db', () => ({
  getImage: (id: number) => stored.get(id) ?? null,
  deleteImagesBulk: (ids: number[]) => deleteImagesBulkMock(ids),
  listImages: vi.fn(), countImages: vi.fn(), listImagesAll: vi.fn(), listSites: vi.fn(),
  updateImageTitle: vi.fn(), updateImageMemo: vi.fn(),
  listImagesMissingThumb: vi.fn(), listImagesForThumbCheck: vi.fn(), setThumbPath: vi.fn(),
  getTimesheet: vi.fn(), saveTimesheet: vi.fn(),
}))
vi.mock('../db/db-tags', () => ({ listAllTags: vi.fn() }))

// 保存先の外を指すパスは null（消さない）。
vi.mock('../system/paths', () => ({
  resolveRealCapturePath: vi.fn(async (p: string) => (p.startsWith('/outside/') ? null : p)),
  thumbPathFor: vi.fn(),
}))
vi.mock('../capture/image-thumb', () => ({ createImageThumb: vi.fn() }))
vi.mock('../system/progress-throttle', () => ({ createProgressThrottle: vi.fn(() => () => false) }))
vi.mock('../system/busy', () => ({ beginTask: vi.fn(), endTask: vi.fn() }))
vi.mock('../system/i18n', () => ({ t: (k: string) => k }))
vi.mock('../system/settings', () => ({ loadSettings: vi.fn(() => ({})) }))
vi.mock('../video/ffmpeg', () => ({ extractThumb: vi.fn(), getVideoMeta: vi.fn(), transcodeToH264: vi.fn() }))

import { CH, type ExportImagesResult } from '../../shared/api'
import { MAX_BULK_IDS } from '../../shared/constants'
import { registerImageHandlers } from './ipc-images'
import type { DeleteImageResult } from '../../shared/types'

registerImageHandlers()

function deleteBulk(ids: unknown): Promise<DeleteImageResult[]> {
  return handlers.get(CH.imagesDeleteBulk)!({}, ids) as Promise<DeleteImageResult[]>
}

beforeEach(() => {
  calls.length = 0
  stored.clear()
  existing.clear()
  unlinkMock.mockClear()
  copyFileMock.mockClear()
  openDialogMock.mockClear()
  deleteImagesBulkMock.mockClear()
})

// **書き出しを途中で欠けさせない。** 元ファイルの無い画像があれば何も書かずに返し（残りを書くかは
// 画面で聞く）、書き出し先に保存できなければ書いた分を消して「何も書き出していない」に戻す。
describe('images:export', () => {
  function exportImages(ids: number[], options?: unknown): Promise<ExportImagesResult> {
    return handlers.get(CH.imagesExport)!({}, ids, options) as Promise<ExportImagesResult>
  }
  function addImage(id: number, present: boolean): void {
    const filepath = `/cap/${id}.png`
    stored.set(id, { id, filepath, thumb_path: null, title: `t${id}`, captured_at: '2026-11-26T00:00:00Z', current_time: null, media_type: 'image' })
    if (present) existing.add(filepath)
  }

  it('元ファイルの無い画像があれば、保存先も聞かず何も書かずに件数を返す', async () => {
    addImage(1, true)
    addImage(2, false)
    addImage(3, true)

    expect(await exportImages([1, 2, 3])).toEqual({ canceled: false, missing: 1, exportable: 2 })
    expect(openDialogMock).not.toHaveBeenCalled()
    expect(copyFileMock).not.toHaveBeenCalled()
  })

  it('全部の元ファイルが無ければ、除いて書き出す指示があっても何も書かない', async () => {
    addImage(1, false)

    expect(await exportImages([1], { skipMissing: true })).toEqual({ canceled: false, missing: 1, exportable: 0 })
    expect(openDialogMock).not.toHaveBeenCalled()
  })

  it('除いて書き出す指示があれば、元ファイルのあるものだけ書き出す', async () => {
    addImage(1, true)
    addImage(2, false)
    addImage(3, true)

    const result = await exportImages([1, 2, 3], { skipMissing: true })
    expect(result).toMatchObject({ canceled: false, count: 2 })
    expect(copyFileMock).toHaveBeenCalledTimes(2)
  })

  it('書き出し先に保存できなければ、それまでに書いた分を消して何も書き出していないと返す', async () => {
    addImage(1, true)
    addImage(2, true)
    addImage(3, true)
    copyFileMock
      .mockImplementationOnce(async (_src, dest) => { calls.push(`copy ${dest}`) })
      .mockImplementationOnce(async () => { throw new Error('ENOSPC') })

    expect(await exportImages([1, 2, 3])).toEqual({ canceled: false, writeFailed: true })
    expect(copyFileMock).toHaveBeenCalledTimes(2)
    const firstWritten = calls.find((c) => c.startsWith('copy '))!.slice('copy '.length)
    expect(unlinkMock).toHaveBeenCalledWith(firstWritten)
  })
})

describe('images:deleteBulk', () => {
  it('DB の行をまとめて先に消し、そのあと原本とサムネを消す', async () => {
    stored.set(1, { filepath: '/cap/1.png', thumb_path: '/cap/1.thumb.jpg' })
    stored.set(2, { filepath: '/cap/2.webm', thumb_path: null })

    const results = await deleteBulk([1, 2])

    expect(deleteImagesBulkMock).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('db 1,2')
    expect(calls.slice(1).sort()).toEqual(['unlink /cap/1.png', 'unlink /cap/1.thumb.jpg', 'unlink /cap/2.webm'])
    expect(results).toEqual(expect.arrayContaining([{ ok: true, id: 1 }, { ok: true, id: 2 }]))
  })

  it('ファイルが消せなくても DB は戻さず、削除できたものとして返す', async () => {
    stored.set(1, { filepath: '/cap/1.png', thumb_path: null })
    unlinkMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const results = await deleteBulk([1])

    expect(results).toEqual([{ ok: true, id: 1 }])
    expect(deleteImagesBulkMock).toHaveBeenCalledTimes(1)
  })

  it('既に無い行は not found で返し、DB とファイルには触れない', async () => {
    stored.set(1, { filepath: '/cap/1.png', thumb_path: null })

    const results = await deleteBulk([1, 99])

    expect(deleteImagesBulkMock).toHaveBeenCalledWith([1])
    expect(results).toEqual(expect.arrayContaining([{ ok: false, id: 99, error: 'not found' }, { ok: true, id: 1 }]))
    expect(unlinkMock).toHaveBeenCalledTimes(1)
  })

  it('不正な id・重複は落とし、上限を超えた分は扱わない', async () => {
    for (let id = 1; id <= MAX_BULK_IDS + 5; id++) stored.set(id, { filepath: `/cap/${id}.png`, thumb_path: null })

    const ids = [1, 1, -3, 0, 2.5, 'x', null, ...Array.from({ length: MAX_BULK_IDS + 5 }, (_, i) => i + 1)]
    await deleteBulk(ids)

    const deleted = deleteImagesBulkMock.mock.calls[0][0]
    expect(deleted).toHaveLength(MAX_BULK_IDS)
    expect(new Set(deleted).size).toBe(MAX_BULK_IDS)
    expect(deleted.every((id: number) => Number.isInteger(id) && id > 0)).toBe(true)
  })

  it('配列でなければ何もしない', async () => {
    expect(await deleteBulk('1,2')).toEqual([])
    expect(deleteImagesBulkMock).not.toHaveBeenCalled()
  })

  it('保存先の外を指すパスのファイルは消さない（行は消す）', async () => {
    stored.set(1, { filepath: '/outside/1.png', thumb_path: null })

    const results = await deleteBulk([1])

    expect(deleteImagesBulkMock).toHaveBeenCalledWith([1])
    expect(unlinkMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ ok: true, id: 1 }])
  })
})
