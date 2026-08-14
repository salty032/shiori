import { vi, describe, expect, it } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import {
  sanitizeFilename, imageQuery, imageListRequest,
  formatDateForFilename, formatTimecodeForFilename,
  normalizeTagName, optionalText, tagsFilter,
  MAX_IMAGE_LIMIT, MAX_TAGS_PER_FILTER, MAX_TAG_LOOKUP_LENGTH,
} from './ipc-validation'

describe('sanitizeFilename', () => {
  it('禁止文字を _ に置換', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('連続する空白は1つに詰める', () => {
    expect(sanitizeFilename('a   b')).toBe('a b')
  })

  it('末尾のドット・空白を除去', () => {
    expect(sanitizeFilename('title...  ')).toBe('title')
  })

  it('空文字 → capture フォールバック', () => {
    expect(sanitizeFilename('')).toBe('capture')
  })

  it('空白のみの入力 → capture フォールバック', () => {
    expect(sanitizeFilename('   ')).toBe('capture')
  })

  it('120文字に切り詰め', () => {
    const long = 'a'.repeat(200)
    const result = sanitizeFilename(long)
    expect(result).toHaveLength(120)
  })
})

describe('imageQuery', () => {
  it('不正型の各フィールドは既定値に落ちる', () => {
    const q = imageQuery({ search: 123, after: 'x', site: 456, tags: 'not-array', tagMode: 'xor', toDate: 'x' })
    expect(q).toEqual({
      search: undefined, after: undefined, site: undefined,
      tags: undefined, tagMode: 'and', toDate: undefined,
    })
  })

  it('null → 全フィールド既定値', () => {
    const q = imageQuery(null)
    expect(q.tagMode).toBe('and')
    expect(q.search).toBeUndefined()
  })

  it('正常値はそのまま通る', () => {
    const q = imageQuery({ search: 'foo', tagMode: 'or' })
    expect(q.search).toBe('foo')
    expect(q.tagMode).toBe('or')
  })

  it('mediaType: video/image はそのまま通る', () => {
    expect(imageQuery({ mediaType: 'video' }).mediaType).toBe('video')
    expect(imageQuery({ mediaType: 'image' }).mediaType).toBe('image')
  })

  it('mediaType: 不正値は undefined に落ちる', () => {
    expect(imageQuery({ mediaType: 'audio' }).mediaType).toBeUndefined()
    expect(imageQuery({}).mediaType).toBeUndefined()
  })

  it('tags: 重複除去', () => {
    const q = imageQuery({ tags: ['a', 'a', 'b'] })
    expect(q.tags).toEqual(['a', 'b'])
  })

  it('tags: 上限 MAX_TAGS_PER_FILTER 件でクランプ', () => {
    const many = Array.from({ length: MAX_TAGS_PER_FILTER + 20 }, (_, i) => `tag${i}`)
    const q = imageQuery({ tags: many })
    expect(q.tags).toHaveLength(MAX_TAGS_PER_FILTER)
  })

  it('tags: 各タグは MAX_TAG_LOOKUP_LENGTH 文字で切り詰め（参照用の上限）', () => {
    const q = imageQuery({ tags: ['a'.repeat(MAX_TAG_LOOKUP_LENGTH + 10)] })
    expect(q.tags?.[0]).toHaveLength(MAX_TAG_LOOKUP_LENGTH)
  })

  it('tags: WD Tagger の AI タグ（17字超）が絞り込みで生き残る（B-1回帰）', () => {
    // looking_at_viewer / simple_background 等、MAX_TAG_LENGTH(16→64) 以前の
    // 上限だと切り詰められて照合が一致しなくなっていた
    const q = imageQuery({ tags: ['looking_at_viewer', 'simple_background'] })
    expect(q.tags).toEqual(['looking_at_viewer', 'simple_background'])
  })
})

describe('tagsFilter', () => {
  it('MAX_TAG_LOOKUP_LENGTH 以下のタグ名はそのまま通す（B-1回帰）', () => {
    expect(tagsFilter(['looking_at_viewer'])).toEqual(['looking_at_viewer'])
  })

  it('MAX_TAG_LOOKUP_LENGTH 超は切り詰める', () => {
    const long = 'a'.repeat(MAX_TAG_LOOKUP_LENGTH + 10)
    expect(tagsFilter([long])?.[0]).toHaveLength(MAX_TAG_LOOKUP_LENGTH)
  })
})

describe('normalizeTagName', () => {
  it('既定(MAX_TAG_LENGTH)で切り詰め・小文字化・空白を_に変換', () => {
    expect(normalizeTagName('Tag Name')).toBe('tag_name')
  })

  it('MAX_TAG_LENGTH(64) までの手動タグ名はそのまま通る', () => {
    const name = 'a'.repeat(60)
    expect(normalizeTagName(name)).toBe(name)
  })

  it('明示的な max 指定（削除系の参照用途）を尊重する', () => {
    const long = 'looking_at_viewer'
    expect(normalizeTagName(long, MAX_TAG_LOOKUP_LENGTH)).toBe(long)
  })
})

describe('optionalText（remove系での参照用途）', () => {
  it('17字超のタグ名も MAX_TAG_LOOKUP_LENGTH 指定なら切り詰めずに残る（B-1回帰）', () => {
    const long = 'looking_at_viewer'
    expect(optionalText(long, MAX_TAG_LOOKUP_LENGTH)).toBe(long)
  })
})

describe('imageListRequest', () => {
  it('limit: 未指定 → 既定 50', () => {
    expect(imageListRequest({}).limit).toBe(50)
  })

  it('limit: 下限 1 未満はクランプ', () => {
    expect(imageListRequest({ limit: 0 }).limit).toBe(1)
    expect(imageListRequest({ limit: -5 }).limit).toBe(1)
  })

  it(`limit: 上限 ${MAX_IMAGE_LIMIT} 超でクランプ`, () => {
    expect(imageListRequest({ limit: 99999 }).limit).toBe(MAX_IMAGE_LIMIT)
  })

  it('limit: NaN → 既定 50', () => {
    expect(imageListRequest({ limit: NaN }).limit).toBe(50)
  })

  it('sortOrder: 不正値は date_desc にフォールバック', () => {
    expect(imageListRequest({ sortOrder: 'invalid' }).sortOrder).toBe('date_desc')
  })

  it('sortOrder: date_asc / random はそのまま通る', () => {
    expect(imageListRequest({ sortOrder: 'date_asc' }).sortOrder).toBe('date_asc')
    expect(imageListRequest({ sortOrder: 'random' }).sortOrder).toBe('random')
  })

  it('imageQuery のフィールドも同時に検証される', () => {
    const r = imageListRequest({ tagMode: 'xor', limit: 10 })
    expect(r.tagMode).toBe('and')
    expect(r.limit).toBe(10)
  })
})

describe('formatDateForFilename', () => {
  it('YYYYMMDD_HHmmss 形式', () => {
    const d = new Date(2026, 0, 5, 9, 3, 7) // 2026-01-05 09:03:07 (ローカルタイム)
    expect(formatDateForFilename(d.getTime())).toBe('20260105_090307')
  })

  it('月日時分秒を2桁ゼロパディング', () => {
    const d = new Date(2026, 11, 31, 23, 59, 59)
    expect(formatDateForFilename(d.getTime())).toBe('20261231_235959')
  })
})

describe('formatTimecodeForFilename', () => {
  it('null → 空文字', () => {
    expect(formatTimecodeForFilename(null)).toBe('')
  })

  it('NaN/Infinity → 空文字', () => {
    expect(formatTimecodeForFilename(NaN)).toBe('')
    expect(formatTimecodeForFilename(Infinity)).toBe('')
  })

  it('1時間未満: mmss 形式(時間桁なし)', () => {
    expect(formatTimecodeForFilename(65)).toBe('0105') // 1:05
  })

  it('0秒 → 0000', () => {
    expect(formatTimecodeForFilename(0)).toBe('0000')
  })

  it('1時間以上: hmmss 形式', () => {
    // 3661秒 = 1時間1分1秒 → h(1) + mm(01) + ss(01)
    expect(formatTimecodeForFilename(3661)).toBe('10101')
  })

  it('負値は0扱い', () => {
    expect(formatTimecodeForFilename(-5)).toBe('0000')
  })

  it('小数は切り捨て', () => {
    expect(formatTimecodeForFilename(65.9)).toBe('0105')
  })
})
