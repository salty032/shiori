import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 手動タグと AI タグが同じ表に同居する規則（手動は AI に降格しない）の回帰テスト。
// 破ると、利用者が手で付けたタグが AI 由来として一覧から黙って消える。
// 本物のスキーマ（initDb）に、実物の SQLite で SQL を流す（test-sqlite-shim.ts）。

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false },
}))
vi.mock('better-sqlite3', async () => ({ default: (await import('./test-sqlite-shim')).SqliteShim }))

import { initDb } from './db-schema'
import { getDb, prepare } from './db-core'
import {
  addTag, addTagsBulk, addTagBulk, getImageTags, deleteAllAiTags, listAllTags, removeTagFromAllImages
} from './db-tags'

let dir: string

function insertImage(name: string): number {
  return Number(prepare('INSERT INTO images (filepath, captured_at) VALUES (?, ?)').run(join(dir, name), 1).lastInsertRowid)
}

function sourceOf(imageId: number, tag: string): string | undefined {
  return getImageTags(imageId).find((t) => t.name === tag)?.source
}

function tagNames(): string[] {
  return (prepare('SELECT name FROM tags ORDER BY name').all() as { name: string }[]).map((r) => r.name)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiori-tags-'))
  state.userData = dir
  initDb()
})

afterEach(() => {
  (getDb() as unknown as { close(): void }).close()
  rmSync(dir, { recursive: true, force: true })
})

describe('手動タグは AI タグに降格しない', () => {
  it('手で付けたタグに AI が同じタグを付けても、手動のまま', () => {
    const id = insertImage('a.png')
    addTag(id, 'sky', 'manual')
    addTag(id, 'sky', 'ai')
    expect(sourceOf(id, 'sky')).toBe('manual')
  })

  it('AI が付けたタグを手で付け直すと、手動に上がる', () => {
    const id = insertImage('a.png')
    addTag(id, 'sky', 'ai')
    addTag(id, 'sky', 'manual')
    expect(sourceOf(id, 'sky')).toBe('manual')
  })

  it('自動タグ付けの一括書き込み（addTagsBulk）でも降格しない', () => {
    const id = insertImage('a.png')
    addTag(id, 'sky', 'manual')
    addTagsBulk(id, [{ name: 'sky', source: 'ai' }, { name: 'cloud', source: 'ai' }])
    expect(sourceOf(id, 'sky')).toBe('manual')
    expect(sourceOf(id, 'cloud')).toBe('ai')
  })

  it('複数選択への一括付与（addTagBulk）でも同じ規則', () => {
    const a = insertImage('a.png')
    const b = insertImage('b.png')
    addTag(a, 'sky', 'manual')
    addTag(b, 'sky', 'ai')
    addTagBulk([a, b], 'sky', 'ai')
    expect(sourceOf(a, 'sky')).toBe('manual')
    expect(sourceOf(b, 'sky')).toBe('ai')
    addTagBulk([a, b], 'sky', 'manual')
    expect(sourceOf(b, 'sky')).toBe('manual')
  })
})

describe('消えた画像へのタグ付け', () => {
  it('自動タグ付けが終わる前に画像が消えていたら、何もせず落ちない', () => {
    const id = insertImage('a.png')
    prepare('DELETE FROM images WHERE id = ?').run(id)
    expect(() => addTagsBulk(id, [{ name: 'sky', source: 'ai' }])).not.toThrow()
    expect(prepare('SELECT COUNT(*) AS n FROM image_tags').get()).toEqual({ n: 0 })
  })

  it('一括付与の中に消えた画像があっても、残っている画像には付く', () => {
    const a = insertImage('a.png')
    const gone = insertImage('gone.png')
    prepare('DELETE FROM images WHERE id = ?').run(gone)
    addTagBulk([gone, a], 'sky')
    expect(sourceOf(a, 'sky')).toBe('manual')
  })
})

describe('AI タグの一括削除（モデルの削除）', () => {
  it('AI タグだけを消し、手動タグは残す。どの画像にも付かなくなったタグ名も消す', () => {
    const a = insertImage('a.png')
    const b = insertImage('b.png')
    addTag(a, 'sky', 'manual')
    addTag(b, 'sky', 'ai')
    addTag(a, 'cloud', 'ai')

    expect(deleteAllAiTags()).toBe(2)

    expect(getImageTags(a)).toEqual([{ name: 'sky', source: 'manual' }])
    expect(getImageTags(b)).toEqual([])
    expect(tagNames()).toEqual(['sky'])
  })
})

describe('タグを全画像から外す', () => {
  it('手動も AI も外し、外した枚数を返す。タグ名も消える', () => {
    const a = insertImage('a.png')
    const b = insertImage('b.png')
    addTag(a, 'sky', 'manual')
    addTag(b, 'sky', 'ai')
    addTag(a, 'cloud', 'manual')

    expect(removeTagFromAllImages('sky')).toBe(2)
    expect(tagNames()).toEqual(['cloud'])
  })
})

describe('タグ一覧', () => {
  it('既定では手動タグだけを、手動で付いた枚数で数える', () => {
    const a = insertImage('a.png')
    const b = insertImage('b.png')
    addTag(a, 'sky', 'manual')
    addTag(b, 'sky', 'ai')
    addTag(a, 'cloud', 'ai')
    expect(listAllTags()).toEqual([{ name: 'sky', source: 'manual', count: 1 }])
  })

  it('AI も含めると、手動が 1 件でもあるタグは手動として上に並ぶ', () => {
    const a = insertImage('a.png')
    const b = insertImage('b.png')
    const c = insertImage('c.png')
    addTag(a, 'cloud', 'ai')
    addTag(b, 'cloud', 'ai')
    addTag(c, 'cloud', 'ai')
    addTag(a, 'sky', 'manual')
    addTag(b, 'sky', 'ai')
    expect(listAllTags(true)).toEqual([
      { name: 'sky', source: 'manual', count: 2 },
      { name: 'cloud', source: 'ai', count: 3 },
    ])
  })
})
