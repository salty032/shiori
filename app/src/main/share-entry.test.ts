import { vi, describe, expect, it } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import { parseShareEntry, isValidCapturedAt, SHARE_IMAGE_EXTS, SHARE_VIDEO_EXTS } from './share-entry'

const NOW = 1700000000000

describe('parseShareEntry', () => {
  it('不正な JSON はエラーを返す', () => {
    const result = parseShareEntry('{not json', NOW)
    expect(result).toEqual({ error: expect.stringContaining('invalid JSON') })
  })

  it('オブジェクト以外の JSON 行（null / 数値 / 配列）は throw せずエラーを返す', () => {
    // "null" は valid な JSON なので JSON.parse は成功する。ここで throw すると
    // ipc-share の取り込みループ（catch 無し）を突き抜けてインポート全体が reject される。
    expect(parseShareEntry('null', NOW)).toEqual({ error: expect.stringContaining('invalid entry') })
    expect(parseShareEntry('123', NOW)).toEqual({ error: expect.stringContaining('invalid entry') })
    expect(parseShareEntry('[]', NOW)).toEqual({ error: expect.stringContaining('invalid entry') })
  })

  it('file フィールドが無い行はエラー報告なしで null（旧バージョン等）', () => {
    expect(parseShareEntry(JSON.stringify({ version: 1 }), NOW)).toBeNull()
    expect(parseShareEntry(JSON.stringify({ file: '' }), NOW)).toBeNull()
    expect(parseShareEntry(JSON.stringify({ file: 123 }), NOW)).toBeNull()
  })

  it('basename と一致しないファイル名（パストラバーサル）はエラー', () => {
    const result = parseShareEntry(JSON.stringify({ file: '../../etc/passwd.png' }), NOW)
    expect(result).toEqual({ error: expect.stringContaining('unsafe filename') })
  })

  it('未対応の拡張子はエラー', () => {
    const result = parseShareEntry(JSON.stringify({ file: 'note.txt' }), NOW)
    expect(result).toEqual({ error: expect.stringContaining('unsupported extension') })
  })

  it('対応する画像拡張子はすべて通り mediaType=image になる', () => {
    for (const ext of SHARE_IMAGE_EXTS) {
      const result = parseShareEntry(JSON.stringify({ file: `a${ext}` }), NOW)
      expect(result).not.toBeNull()
      expect(result).not.toHaveProperty('error')
      expect((result as { mediaType: string }).mediaType).toBe('image')
    }
  })

  it('対応する動画拡張子はすべて通り mediaType=video になる', () => {
    for (const ext of SHARE_VIDEO_EXTS) {
      const result = parseShareEntry(JSON.stringify({ file: `a${ext}` }), NOW)
      expect(result).not.toBeNull()
      expect(result).not.toHaveProperty('error')
      expect((result as { mediaType: string }).mediaType).toBe('video')
    }
  })

  it('動画エントリの duration は正の有限値のみ受け付ける', () => {
    const ok = parseShareEntry(JSON.stringify({ file: 'a.webm', duration: 12.5 }), NOW)
    expect((ok as { duration: number | null }).duration).toBe(12.5)
    const bad = parseShareEntry(JSON.stringify({ file: 'a.webm', duration: -1 }), NOW)
    expect((bad as { duration: number | null }).duration).toBeNull()
    const missing = parseShareEntry(JSON.stringify({ file: 'a.webm' }), NOW)
    expect((missing as { duration: number | null }).duration).toBeNull()
  })

  it('正常な最小エントリを正しく正規化する', () => {
    const result = parseShareEntry(JSON.stringify({ file: 'cap_1.png', title: 'Title', current_time: 12.5 }), NOW)
    expect(result).toMatchObject({
      file: 'cap_1.png', ext: '.png', thumbFile: null, thumbExt: null,
      title: 'Title', currentTime: 12.5, tags: [], memo: null,
    })
  })

  it('captured_at が妥当な範囲外なら now にフォールバック', () => {
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', captured_at: -5 }), NOW)).toMatchObject({ capturedAt: NOW })
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', captured_at: 8640000000000000 }), NOW)).toMatchObject({ capturedAt: NOW })
    expect(parseShareEntry(JSON.stringify({ file: 'a.png' }), NOW)).toMatchObject({ capturedAt: NOW })
  })

  it('captured_at が妥当な範囲内ならそのまま使う', () => {
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', captured_at: 1600000000000 }), NOW)).toMatchObject({ capturedAt: 1600000000000 })
  })

  it('thumb が basename と一致しパストラバーサルでなければ採用する', () => {
    const result = parseShareEntry(JSON.stringify({ file: 'a.png', thumb: 'a_thumb.jpg' }), NOW)
    expect(result).toMatchObject({ thumbFile: 'a_thumb.jpg', thumbExt: '.jpg' })
  })

  it('thumb がパストラバーサル or 未対応拡張子ならエラーにせず黙って無視する', () => {
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', thumb: '../evil.jpg' }), NOW)).toMatchObject({ thumbFile: null, thumbExt: null })
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', thumb: 'evil.exe' }), NOW)).toMatchObject({ thumbFile: null, thumbExt: null })
  })

  it('17字以上の AI タグ相当の名前も含め、タグは重複除去のうえ正規化される（B-1 と同じ経路）', () => {
    const result = parseShareEntry(JSON.stringify({ file: 'a.png', tags: ['Tag One', 'tag_one', 'looking_at_viewer'] }), NOW)
    expect(result).toMatchObject({ tags: ['tag_one', 'looking_at_viewer'] })
  })

  it('title/memo は最大長で切り詰められる', () => {
    const long = 'a'.repeat(6000)
    const result = parseShareEntry(JSON.stringify({ file: 'a.png', title: long, memo: long }), NOW)
    expect((result as { title: string }).title.length).toBeLessThan(6000)
    expect((result as { memo: string }).memo.length).toBeLessThan(6000)
  })

  it('current_time が数値以外/非有限なら null', () => {
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', current_time: 'x' }), NOW)).toMatchObject({ currentTime: null })
    expect(parseShareEntry(JSON.stringify({ file: 'a.png', current_time: Infinity }), NOW)).toMatchObject({ currentTime: null })
  })
})

describe('isValidCapturedAt', () => {
  it('0以下・非有限・2100年以降は無効', () => {
    expect(isValidCapturedAt(0)).toBe(false)
    expect(isValidCapturedAt(-1)).toBe(false)
    expect(isValidCapturedAt(NaN)).toBe(false)
    expect(isValidCapturedAt(new Date(2100, 0, 1).getTime())).toBe(false)
  })

  it('妥当な範囲は有効', () => {
    expect(isValidCapturedAt(1600000000000)).toBe(true)
  })
})
