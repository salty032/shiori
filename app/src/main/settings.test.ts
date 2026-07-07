import { vi, describe, expect, it } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import { normalizeSettings } from './settings'

const DEFAULT_EXTENSION_ID = 'cgoodmpndbpjjlhpeimjjjjccioebdpn'

const DEFAULTS = {
  titleStrip: [],
  thumbnailSize: 160,
  frameFps: 24,
  frameFpsAuto: true,
  smartFolders: [],
  captureHotkey: 'Alt+S',
  captureNotify: true,
  allowedExtensionIds: [DEFAULT_EXTENSION_ID],
  serviceOrder: [],
}

describe('normalizeSettings', () => {
  describe('デフォルト値', () => {
    it('空オブジェクト → デフォルト値', () => {
      expect(normalizeSettings({})).toEqual(DEFAULTS)
    })
    it('null → デフォルト値', () => {
      expect(normalizeSettings(null)).toEqual(DEFAULTS)
    })
    it('undefined → デフォルト値', () => {
      expect(normalizeSettings(undefined)).toEqual(DEFAULTS)
    })
    it('文字列 → デフォルト値', () => {
      expect(normalizeSettings('invalid')).toEqual(DEFAULTS)
    })
  })

  describe('thumbnailSize', () => {
    it('有効値: 200', () => expect(normalizeSettings({ thumbnailSize: 200 }).thumbnailSize).toBe(200))
    it('下限 80 未満 → 80', () => expect(normalizeSettings({ thumbnailSize: 10 }).thumbnailSize).toBe(80))
    it('上限 360 超 → 360', () => expect(normalizeSettings({ thumbnailSize: 9999 }).thumbnailSize).toBe(360))
    it('NaN → デフォルト 160', () => expect(normalizeSettings({ thumbnailSize: NaN }).thumbnailSize).toBe(160))
    it('Infinity → デフォルト 160', () => expect(normalizeSettings({ thumbnailSize: Infinity }).thumbnailSize).toBe(160))
    it('浮動小数点は切り捨て: 180.9 → 180', () => expect(normalizeSettings({ thumbnailSize: 180.9 }).thumbnailSize).toBe(180))
  })

  describe('captureHotkey', () => {
    it('有効なホットキー', () => expect(normalizeSettings({ captureHotkey: 'Ctrl+S' }).captureHotkey).toBe('Ctrl+S'))
    it('小文字を正規化', () => expect(normalizeSettings({ captureHotkey: 'alt+s' }).captureHotkey).toBe('Alt+S'))
    it('無効な値 → デフォルト Alt+S', () => expect(normalizeSettings({ captureHotkey: 'invalid' }).captureHotkey).toBe('Alt+S'))
    it('数値 → デフォルト Alt+S', () => expect(normalizeSettings({ captureHotkey: 42 }).captureHotkey).toBe('Alt+S'))
  })

  describe('titleStrip', () => {
    it('有効な文字列配列 (trim される)', () => {
      // stringList は .trim() するため先頭スペースは除去される
      expect(normalizeSettings({ titleStrip: [' - Netflix', ' - YouTube'] }).titleStrip)
        .toEqual(['- Netflix', '- YouTube'])
    })
    it('空文字は除外 (trim 後に空になる文字列も除外)', () => {
      expect(normalizeSettings({ titleStrip: ['', ' - Netflix', ''] }).titleStrip)
        .toEqual(['- Netflix'])
    })
    it('200 文字超は切り詰め', () => {
      const long = 'a'.repeat(250)
      const result = normalizeSettings({ titleStrip: [long] }).titleStrip[0]
      expect(result).toHaveLength(200)
    })
    it('配列でない → 空配列', () => {
      expect(normalizeSettings({ titleStrip: 'not-array' }).titleStrip).toEqual([])
    })
    it('100件超は切り捨て', () => {
      const many = Array.from({ length: 150 }, (_, i) => `item${i}`)
      expect(normalizeSettings({ titleStrip: many }).titleStrip).toHaveLength(100)
    })
  })

  describe('allowedExtensionIds', () => {
    it('有効な Chrome 拡張 ID (32文字 [a-p])', () => {
      const validId = 'abcdefghijklmnopabcdefghijklmnop'
      expect(normalizeSettings({ allowedExtensionIds: [validId] }).allowedExtensionIds)
        .toEqual([validId])
    })
    it('大文字を小文字化して検証', () => {
      const id = 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP'.toLowerCase()
      expect(normalizeSettings({ allowedExtensionIds: [id] }).allowedExtensionIds)
        .toHaveLength(1)
    })
    it('31 文字 → 除外されデフォルト ID にフォールバック', () => {
      expect(normalizeSettings({ allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmno'] }).allowedExtensionIds)
        .toEqual([DEFAULT_EXTENSION_ID])
    })
    it('[a-p] 以外の文字を含む → 除外されデフォルト ID にフォールバック', () => {
      // 'q' は [a-p] 範囲外
      expect(normalizeSettings({ allowedExtensionIds: ['qbcdefghijklmnopabcdefghijklmnop'] }).allowedExtensionIds)
        .toEqual([DEFAULT_EXTENSION_ID])
    })
    it('配列でない → デフォルト ID にフォールバック', () => {
      expect(normalizeSettings({ allowedExtensionIds: 'not-array' }).allowedExtensionIds).toEqual([DEFAULT_EXTENSION_ID])
    })
  })

  describe('boolean フラグ', () => {
    it('frameFpsAuto: false を保持', () => {
      expect(normalizeSettings({ frameFpsAuto: false }).frameFpsAuto).toBe(false)
    })
    it('frameFpsAuto: デフォルト true (値なし)', () => {
      expect(normalizeSettings({}).frameFpsAuto).toBe(true)
    })
  })

  describe('smartFolders', () => {
    it('有効なスマートフォルダ', () => {
      const folder = { id: 'f1', name: 'テスト', tags: [], tagMode: 'and', site: null, search: '' }
      const result = normalizeSettings({ smartFolders: [folder] }).smartFolders
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('テスト')
    })
    it('tagMode が "or" 以外 → "and"', () => {
      const folder = { id: 'f1', name: 'テスト', tags: [], tagMode: 'invalid', site: null, search: '' }
      const result = normalizeSettings({ smartFolders: [folder] }).smartFolders
      expect(result[0].tagMode).toBe('and')
    })
    it('配列でない → 空配列', () => {
      expect(normalizeSettings({ smartFolders: 'not-array' }).smartFolders).toEqual([])
    })
  })
})
