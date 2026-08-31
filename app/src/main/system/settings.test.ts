import { vi, describe, expect, it } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import { normalizeSettings, stripDedicatedSettingKeys } from './settings'

const DEFAULT_EXTENSION_ID = 'cgoodmpndbpjjlhpeimjjjjccioebdpn'

const DEFAULTS = {
  titleStrip: [],
  thumbnailSize: 230,
  frameFps: 24,
  frameFpsAuto: true,
  smartFolders: [],
  captureHotkey: 'Alt+S',
  clipHotkey: 'Alt+D',
  clipMaxSeconds: 30,
  clipNotify: true,
  captureNotify: true,
  allowedExtensionIds: [DEFAULT_EXTENSION_ID],
  serviceOrder: [],
  showAiTags: false,
  theme: 'dark',
  // 無効・未指定の language は 'ja' へ倒す（normalizeSettings は OS ロケールを見ない。
  // 新規インストール時の OS ロケール判定は loadSettings 側の責務）。
  language: 'ja',
  videoExportFormat: 'original',
  captureResize: 'source',
  captureRoot: null,
  previousCaptureRoots: [],
  lastRunVersion: null,
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
    it('NaN → デフォルト 230', () => expect(normalizeSettings({ thumbnailSize: NaN }).thumbnailSize).toBe(230))
    it('Infinity → デフォルト 230', () => expect(normalizeSettings({ thumbnailSize: Infinity }).thumbnailSize).toBe(230))
    it('浮動小数点は切り捨て: 180.9 → 180', () => expect(normalizeSettings({ thumbnailSize: 180.9 }).thumbnailSize).toBe(180))
    // 旧 S/M/L からの読み替え。既存ユーザーが更新後も前の大きさのままにならないこと。
    it('旧S 120 → 新S 150', () => expect(normalizeSettings({ thumbnailSize: 120 }).thumbnailSize).toBe(150))
    it('旧M 160 → 新M 230', () => expect(normalizeSettings({ thumbnailSize: 160 }).thumbnailSize).toBe(230))
    it('旧L 220 → 新L 320', () => expect(normalizeSettings({ thumbnailSize: 220 }).thumbnailSize).toBe(320))
    it('表に無い値は読み替えない: 200', () => expect(normalizeSettings({ thumbnailSize: 200 }).thumbnailSize).toBe(200))
    // 現行の3値が読み替え表のキーに入っていると、起動のたびに隣の段へ移ってしまう。
    it('現行S 150 はそのまま', () => expect(normalizeSettings({ thumbnailSize: 150 }).thumbnailSize).toBe(150))
    it('現行M 230 はそのまま', () => expect(normalizeSettings({ thumbnailSize: 230 }).thumbnailSize).toBe(230))
    it('現行L 320 はそのまま', () => expect(normalizeSettings({ thumbnailSize: 320 }).thumbnailSize).toBe(320))
  })

  describe('clipMaxSeconds', () => {
    it('有効値: 20', () => expect(normalizeSettings({ clipMaxSeconds: 20 }).clipMaxSeconds).toBe(20))
    it('下限 5 未満 → 5', () => expect(normalizeSettings({ clipMaxSeconds: 1 }).clipMaxSeconds).toBe(5))
    // 著作権対策として録画時間を厳格に上限30秒とする（設定でもこれ以上には出来ない）
    it('上限 30 超 → 30', () => expect(normalizeSettings({ clipMaxSeconds: 300 }).clipMaxSeconds).toBe(30))
    it('NaN → デフォルト 30', () => expect(normalizeSettings({ clipMaxSeconds: NaN }).clipMaxSeconds).toBe(30))
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

  describe('lastRunVersion', () => {
    it('有効な文字列を保持', () => {
      expect(normalizeSettings({ lastRunVersion: '1.1.2' }).lastRunVersion).toBe('1.1.2')
    })
    it('未指定 → null（初回起動）', () => {
      expect(normalizeSettings({}).lastRunVersion).toBeNull()
    })
    it('文字列以外 → null', () => {
      expect(normalizeSettings({ lastRunVersion: 42 }).lastRunVersion).toBeNull()
    })
    it('空白のみ → null', () => {
      expect(normalizeSettings({ lastRunVersion: '   ' }).lastRunVersion).toBeNull()
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

  describe('theme', () => {
    it('有効な値: light', () => expect(normalizeSettings({ theme: 'light' }).theme).toBe('light'))
    it('有効な値: system', () => expect(normalizeSettings({ theme: 'system' }).theme).toBe('system'))
    it('無効な値 → デフォルト dark', () => expect(normalizeSettings({ theme: 'invalid' }).theme).toBe('dark'))
    it('値なし → デフォルト dark', () => expect(normalizeSettings({}).theme).toBe('dark'))
  })
})

describe('captureResize', () => {
  it("'fhd' はそのまま", () => expect(normalizeSettings({ captureResize: 'fhd' }).captureResize).toBe('fhd'))
  it("'hd' はそのまま", () => expect(normalizeSettings({ captureResize: 'hd' }).captureResize).toBe('hd'))
  it("'screen' はそのまま", () => expect(normalizeSettings({ captureResize: 'screen' }).captureResize).toBe('screen'))
  it('知らない値 → 既定', () => expect(normalizeSettings({ captureResize: '4k' }).captureResize).toBe('source'))
  it('未指定 → 既定（水増しを省く）', () => expect(normalizeSettings({}).captureResize).toBe('source'))
})

describe('captureRoot', () => {
  it('絶対パスはそのまま', () => {
    // 先頭が / のパスは Windows でも絶対パス扱いなので、両方の環境で同じ値を使える。
    const p = '/data/shiori'
    expect(normalizeSettings({ captureRoot: p }).captureRoot).toBe(p)
  })
  // 相対パスは実行時の作業ディレクトリ次第で別の場所を指す。どこへ保存したのか
  // 分からなくなるので受け付けない。
  it('相対パスは受け付けない', () => expect(normalizeSettings({ captureRoot: 'captures' }).captureRoot).toBeNull())
  it('空文字は既定へ倒す', () => expect(normalizeSettings({ captureRoot: '  ' }).captureRoot).toBeNull())
  it('未指定は既定へ倒す', () => expect(normalizeSettings({}).captureRoot).toBeNull())
  it('過去の保存先は重複を落とす', () => {
    const a = '/a'
    expect(normalizeSettings({ previousCaptureRoots: [a, a, 'rel'] }).previousCaptureRoots).toEqual([a])
  })
})

describe('videoExportFormat', () => {
  it("'h264' はそのまま", () => expect(normalizeSettings({ videoExportFormat: 'h264' }).videoExportFormat).toBe('h264'))
  it("'original' はそのまま", () => expect(normalizeSettings({ videoExportFormat: 'original' }).videoExportFormat).toBe('original'))
  // 知らない値で「変換するつもりが無いのに変換される」ほうが困るので、既定の
  // 'original'（そのままコピー）へ倒す。
  it('知らない値 → そのまま', () => expect(normalizeSettings({ videoExportFormat: 'av1' }).videoExportFormat).toBe('original'))
  it('未指定 → そのまま', () => expect(normalizeSettings({}).videoExportFormat).toBe('original'))
})

// 設定の汎用保存口（CH.settingsSet）は「値を書き換える」以外に main 側でやることがある項目を
// 通してはいけない。通すと、設定画面の表示と実際に効いているもの（登録済みホットキー・
// 書き込み確認を通った保存先）が食い違い、**その食い違いは画面に出ない。**
describe('stripDedicatedSettingKeys - 専用 IPC が要る項目は汎用口を通さない', () => {
  it('ホットキーは静止画・クリップとも落とす', () => {
    const { safePatch, ignored } = stripDedicatedSettingKeys({ captureHotkey: 'Alt+X', clipHotkey: 'Alt+Y' })
    expect(safePatch).toEqual({})
    expect(ignored).toEqual(['captureHotkey', 'clipHotkey'])
  })

  it('保存先と過去の保存先を落とす', () => {
    const { safePatch, ignored } = stripDedicatedSettingKeys({ captureRoot: 'D:/nowhere', previousCaptureRoots: [] })
    expect(safePatch).toEqual({})
    expect(ignored).toEqual(['captureRoot', 'previousCaptureRoots'])
  })

  it('拡張の許可 ID を落とす', () => {
    const { safePatch, ignored } = stripDedicatedSettingKeys({ allowedExtensionIds: ['anything'] })
    expect(safePatch).toEqual({})
    expect(ignored).toEqual(['allowedExtensionIds'])
  })

  it('落とす項目が混ざっていても、他の項目はそのまま通る', () => {
    const { safePatch, ignored } = stripDedicatedSettingKeys({ thumbnailSize: 300, captureRoot: 'D:/nowhere', theme: 'dark' })
    expect(safePatch).toEqual({ thumbnailSize: 300, theme: 'dark' })
    expect(ignored).toEqual(['captureRoot'])
  })

  // 落とす側の一覧にしてある理由がここ。設定に項目が増えても、汎用口は従来どおり通す。
  it('知らない項目は落とさない（通す物の一覧にはしない）', () => {
    const { safePatch, ignored } = stripDedicatedSettingKeys({ somethingNew: 1 })
    expect(safePatch).toEqual({ somethingNew: 1 })
    expect(ignored).toEqual([])
  })

  it('オブジェクトでないものを渡されても落ちない', () => {
    expect(stripDedicatedSettingKeys(null)).toEqual({ safePatch: {}, ignored: [] })
    expect(stripDedicatedSettingKeys('x')).toEqual({ safePatch: {}, ignored: [] })
  })
})
