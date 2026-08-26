import { vi, describe, expect, it, beforeEach } from 'vitest'
import { join, resolve } from 'path'

const { countImages, listReferencedPaths } = vi.hoisted(() => ({
  countImages: vi.fn<() => number>(),
  listReferencedPaths: vi.fn<() => { filepath: string; thumb_path: string | null }[]>(),
}))
const { readFile, readdir, stat, unlink, writeFile } = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))
vi.mock('../db', () => ({ countImages, listReferencedPaths }))
vi.mock('fs/promises', () => ({ readFile, readdir, stat, unlink, writeFile }))

import { isOrphanSweepDue, ORPHAN_SWEEP_INTERVAL_MS, selectOrphans, sweepOrphanFiles, sweepOrphanFilesIfDue, type SweepCandidate } from './sweep-orphans'

const NOW = 1_800_000_000_000
const OLD = NOW - 24 * 60 * 60 * 1000   // 掃除対象になる古さ
const FRESH = NOW - 60 * 1000           // 取り込み中かもしれない新しさ

const file = (path: string, mtimeMs = OLD): SweepCandidate => ({ path, mtimeMs, size: 100 })

// 誤削除はユーザーのライブラリが黙って壊れる事故になる。消さない側の条件を厚く固定する。
describe('selectOrphans', () => {
  it('DB が参照していない古いファイルは孤立として拾う', () => {
    const orphan = file('/mock/userData/captures/2026-07/cap_1.png')
    expect(selectOrphans([orphan], [], NOW)).toEqual([orphan])
  })

  it('DB が参照しているファイルは消さない', () => {
    const kept = file('/mock/userData/captures/2026-07/cap_1.png')
    expect(selectOrphans([kept], [kept.path], NOW)).toEqual([])
  })

  it('thumb_path で参照されているサムネも消さない', () => {
    const thumb = file('/mock/userData/thumbnails/cap_1_t.jpg')
    expect(selectOrphans([thumb], [thumb.path], NOW)).toEqual([])
  })

  it('新しいファイルは消さない（DB 登録前の取り込み中を巻き込まない）', () => {
    const inFlight = file('/mock/userData/captures/2026-07/cap_new.webm', FRESH)
    expect(selectOrphans([inFlight], [], NOW)).toEqual([])
  })

  it('大文字小文字の綴り違いを同一視する（Windows）', () => {
    const onDisk = file('/mock/userData/captures/2026-07/CAP_1.PNG')
    const inDb = '/mock/userData/captures/2026-07/cap_1.png'
    expect(selectOrphans([onDisk], [inDb], NOW)).toEqual([])
  })

  it('相対表記と絶対表記の揺れを同一視する', () => {
    const onDisk = file(resolve('/mock/userData/captures/2026-07/cap_1.png'))
    const inDb = '/mock/userData/captures/2026-07/./cap_1.png'
    expect(selectOrphans([onDisk], [inDb], NOW)).toEqual([])
  })

  it('扱う形式でないファイルは触らない（ユーザーが置いたメモ等）', () => {
    const userFile = file('/mock/userData/captures/memo.txt')
    expect(selectOrphans([userFile], [], NOW)).toEqual([])
  })

  it('thumb_path が null の行があっても落ちない', () => {
    const orphan = file('/mock/userData/captures/2026-07/cap_1.png')
    expect(selectOrphans([orphan], ['', null as unknown as string], NOW)).toEqual([orphan])
  })
})

describe('sweepOrphanFiles の安全弁', () => {
  beforeEach(() => {
    countImages.mockReset()
    listReferencedPaths.mockReset()
    readFile.mockReset()
    readdir.mockReset()
    stat.mockReset()
    unlink.mockReset()
    writeFile.mockReset()
  })

  // DB を作り直した直後に走ると、実ファイル全部が「参照なし」になりライブラリが消える。
  it('DB が空なら走査すらしない', async () => {
    countImages.mockReturnValue(0)
    const result = await sweepOrphanFiles()
    expect(result).toEqual({ removed: 0, bytes: 0 })
    expect(listReferencedPaths).not.toHaveBeenCalled()
  })

  it('DB に無い原本は自動削除のために走査しない', async () => {
    countImages.mockReturnValue(1)
    listReferencedPaths.mockReturnValue([])
    readdir.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    await sweepOrphanFiles()

    expect(readdir).toHaveBeenCalledTimes(1)
    expect(readdir).toHaveBeenCalledWith(join('/mock/userData', 'thumbnails'), { withFileTypes: true })
    expect(unlink).not.toHaveBeenCalled()
  })
})

describe('孤立ファイル掃除の実行間隔', () => {
  beforeEach(() => {
    countImages.mockReset()
    listReferencedPaths.mockReset()
    readFile.mockReset()
    readdir.mockReset()
    stat.mockReset()
    unlink.mockReset()
    writeFile.mockReset()
  })

  it('未実行なら掃除対象になる', () => {
    expect(isOrphanSweepDue(null, NOW)).toBe(true)
  })

  it('前回成功から7日未満なら省略する', () => {
    expect(isOrphanSweepDue(NOW - ORPHAN_SWEEP_INTERVAL_MS + 1, NOW)).toBe(false)
  })

  it('7日経過したら再び掃除対象になる', () => {
    expect(isOrphanSweepDue(NOW - ORPHAN_SWEEP_INTERVAL_MS, NOW)).toBe(true)
  })

  it('壊れた記録値は未実行として扱う', () => {
    expect(isOrphanSweepDue(Number.NaN, NOW)).toBe(true)
  })

  it('時計が巻き戻って前回記録が未来になった場合も掃除対象に戻す', () => {
    expect(isOrphanSweepDue(NOW + 1000, NOW)).toBe(true)
  })

  it('7日未満ならファイル走査を始めない', async () => {
    readFile.mockResolvedValue(String(NOW - 1000))
    const result = await sweepOrphanFilesIfDue(NOW)
    expect(result.skipped).toBe(true)
    expect(countImages).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })

  it('掃除が成功した後だけ成功時刻を記録する', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    countImages.mockReturnValue(1)
    listReferencedPaths.mockReturnValue([])
    readdir.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    writeFile.mockResolvedValue(undefined)

    const result = await sweepOrphanFilesIfDue(NOW)
    expect(result.skipped).toBe(false)
    expect(writeFile).toHaveBeenCalledWith(join('/mock/userData', '.orphan-sweep-last'), String(NOW), 'utf8')
  })

  it('掃除が途中で失敗したら成功時刻を記録せず、次回に再試行できる', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    countImages.mockReturnValue(1)
    listReferencedPaths.mockImplementation(() => { throw new Error('db failed') })

    await expect(sweepOrphanFilesIfDue(NOW)).rejects.toThrow('db failed')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
