import { describe, expect, it } from 'vitest'
import { normalizeSearchText, SEARCH_NORMALIZE_VERSION } from './normalize'

describe('normalizeSearchText', () => {
  it('半角カナは全角ひらがなへ寄せる', () => {
    expect(normalizeSearchText('ﾄﾞｷﾄﾞｷ')).toBe('どきどき')
    expect(normalizeSearchText('ドキドキ')).toBe('どきどき')
    expect(normalizeSearchText('ｷﾀ')).toBe('きた')
  })

  it('全角英数は半角へ、大文字は小文字へ', () => {
    expect(normalizeSearchText('ＤＡＹＢＹＥ')).toBe('daybye')
    expect(normalizeSearchText('DAYBYE')).toBe('daybye')
  })

  it('カタカナ/ひらがなの違いを吸収する', () => {
    expect(normalizeSearchText('リズと青い鳥')).toBe('りずと青い鳥')
    expect(normalizeSearchText('りずと青い鳥')).toBe('りずと青い鳥')
  })

  it('記号・空白（半角/全角）を除去する', () => {
    expect(normalizeSearchText('春野 - DAYBYE (Music Video)')).toBe('春野daybyemusicvideo')
    expect(normalizeSearchText('春野　－　DAYBYE　(Music　Video)')).toBe('春野daybyemusicvideo')
    expect(normalizeSearchText('【推しの子】')).toBe('推しの子')
  })

  it('長音符「ー」は記号として落とさず残す', () => {
    expect(normalizeSearchText('サーバー')).toContain('ー')
    expect(normalizeSearchText('サーバ')).not.toBe(normalizeSearchText('サーバー'))
  })

  it('実際の荒れた YouTube タイトルでも壊れずに処理できる', () => {
    const title = '【#42 🔰新人指揮官⚓️】新着せ替えｷﾀ━♪出演声優のまったりアズレン配信🐙🏴‍☠️ﾄﾞｷﾄﾞｷ試着タイム(ﾟ∀ﾟ)/// 【#ゅか生】'
    const result = normalizeSearchText(title)
    expect(result).toContain('新人指揮官')
    expect(result).toContain('新着せ替え')
    expect(result).toContain('きた')
    expect(result).toContain('どきどき')
    expect(result).toContain('試着たいむ')
    // 絵文字・ZWJ・異体字セレクタ・記号・空白がすべて落ちていること
    expect(result).not.toMatch(/[\p{P}\p{S}\p{Z}\s]/u)
  })

  it('冪等：一度正規化した文字列を再度正規化しても変化しない', () => {
    const inputs = ['ﾄﾞｷﾄﾞｷ', 'ＤＡＹＢＹＥ', '【推しの子】第1話', '🏴‍☠️']
    for (const s of inputs) {
      const once = normalizeSearchText(s)
      expect(normalizeSearchText(once)).toBe(once)
    }
  })

  it('空文字は空文字のまま', () => {
    expect(normalizeSearchText('')).toBe('')
  })
})

describe('SEARCH_NORMALIZE_VERSION', () => {
  // 版を上げ忘れないための関所。
  //
  // 保存側の images.search_text は書き込み時に一度だけ計算されるので、ルールを変えても
  // 既存の行は古い結果のまま残る。検索語だけが新ルールになり、同じ語が行によって当たったり
  // 当たらなかったりする。db.ts の initDb はこの版が上がったときだけ全行を作り直すため、
  // 「ルールは変えたが版は据え置き」が一番危ない（誰にも気付かれずに検索結果が濁る）。
  //
  // 下の期待値はルールを変えれば必ず動く。動かしたときは版も上げること。ここに版番号を
  // 並べて置いてあるのは、テストを直しに来た人の目に必ず入るようにするため。
  it('現在の版に対応する正規化結果を固定する（変えたら版も上げる）', () => {
    expect(SEARCH_NORMALIZE_VERSION).toBe(1)
    expect([
      'ﾄﾞｷﾄﾞｷ',
      'ＤＡＹＢＹＥ',
      '【推しの子】第1話',
      '春野 - DAYBYE (Music Video)',
      'サーバー',
      '🏴‍☠️'
    ].map(normalizeSearchText)).toEqual([
      'どきどき',
      'daybye',
      '推しの子第1話',
      '春野daybyemusicvideo',
      'さーばー',
      ''
    ])
  })
})
