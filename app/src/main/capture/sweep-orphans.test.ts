import { vi, describe, expect, it, beforeEach } from 'vitest'
import { resolve } from 'path'

const { countImages, listReferencedPaths } = vi.hoisted(() => ({
  countImages: vi.fn<() => number>(),
  listReferencedPaths: vi.fn<() => { filepath: string; thumb_path: string | null }[]>(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))
vi.mock('../db', () => ({ countImages, listReferencedPaths }))

import { selectOrphans, sweepOrphanFiles, type SweepCandidate } from './sweep-orphans'

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
  })

  // DB を作り直した直後に走ると、実ファイル全部が「参照なし」になりライブラリが消える。
  it('DB が空なら走査すらしない', async () => {
    countImages.mockReturnValue(0)
    const result = await sweepOrphanFiles()
    expect(result).toEqual({ removed: 0, bytes: 0 })
    expect(listReferencedPaths).not.toHaveBeenCalled()
  })
})
