import { describe, expect, it } from 'vitest'
import {
  SEARCH_PREFIXES, TYPING_PREFIX_RE, PREFIX_HINT_RE, isBarePrefix,
  removeSearchTokens, addSearchToken, parseSearchQuery
} from './imageQuery'

// 検索の接頭辞は imageQuery.ts の一覧 1 つから、解析・入力中の候補・履歴・タグの付け外しが作られる。
// 一覧に足した接頭辞がどこかで効かないと、「絞り込めるのに履歴に残る」のように黙って食い違う。
describe('検索の接頭辞は一覧 1 つから効く', () => {
  it.each(SEARCH_PREFIXES)('%s: は値付きならフリーワードから外れ、値無しなら履歴に残さない', (prefix) => {
    expect(parseSearchQuery(`${prefix}:x メモ`).q).toBe('メモ')
    expect(isBarePrefix(`${prefix}:`)).toBe(true)
    expect(isBarePrefix(` ${prefix.toUpperCase()}: `)).toBe(true)
    expect(isBarePrefix(`${prefix}:x`)).toBe(false)
  })

  it.each(SEARCH_PREFIXES)('%s: を打っている最中は入力中として拾い、打ちかけ（先頭 1 文字〜）は候補で補える', (prefix) => {
    expect(TYPING_PREFIX_RE[prefix].exec(`メモ ${prefix}:ab`)?.[1]).toBe('ab')
    expect(TYPING_PREFIX_RE[prefix].exec(`${prefix}:`)?.[1]).toBe('')
    for (let n = 1; n <= prefix.length; n++) {
      expect(PREFIX_HINT_RE.test(`メモ ${prefix.slice(0, n)}`)).toBe(true)
    }
  })

  it('入力中の判定は末尾のトークンだけ（確定済みの前のトークンでは拾わない）', () => {
    expect(TYPING_PREFIX_RE.tag.test('tag:sky メモ')).toBe(false)
    expect(TYPING_PREFIX_RE.tag.test('メモtag:sky')).toBe(false)
  })
})

describe('removeSearchTokens', () => {
  it('その接頭辞のトークンを全部外し、空白を詰める', () => {
    expect(removeSearchTokens('tag:a 夕焼け tag:b site:x', 'tag')).toBe('夕焼け site:x')
  })

  it('値で選んで外す', () => {
    expect(removeSearchTokens('tag:Sky tag:sea', 'tag', (v) => v.toLowerCase() === 'sky')).toBe('tag:sea')
  })

  it('語の途中の「tag:」は外さない', () => {
    expect(removeSearchTokens('メモtag:a', 'tag')).toBe('メモtag:a')
  })
})

describe('addSearchToken', () => {
  it('絞り込みを前、フリーワードを後ろに揃えて足す', () => {
    expect(addSearchToken('夕焼け site:x', 'tag', 'sky')).toBe('site:x tag:sky 夕焼け')
  })
})
