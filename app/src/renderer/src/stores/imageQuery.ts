import type { ImageQuery } from '../types'
import type { CommittedFilters } from './filterStore'

// 検索文字列のパース（tag:/site:/type:/from:/to:）と確定フィルタを 1 つの ImageQuery にまとめる。
// グリッド一覧・タイムライン・件数集計が共有する「フィルタとは何か」の単一定義。
// ストア（imageStore）とフック双方から参照するため、循環参照回避でここに独立させている。

// 検索欄で使える接頭辞。**足す・変えるときはここだけを触る。** 解析・入力中の候補・チップ・
// サイドバーのタグ・履歴がこの一覧と下の関数を読む。以前は 7 か所に正規表現を手書きしていて、
// 1 か所漏れると「絞り込めるのに履歴に残る」のように黙って食い違う作りだった。
export const SEARCH_PREFIXES = ['tag', 'from', 'to', 'site', 'type'] as const
export type SearchPrefix = (typeof SEARCH_PREFIXES)[number]
const ANY_PREFIX = SEARCH_PREFIXES.join('|')

// 値の付いたトークン（tag:abc）。1 つ目を拾う。
function tokenRe(prefix: SearchPrefix, flags = 'i'): RegExp {
  return new RegExp(`(?:^|\\s)${prefix}:(\\S+)`, flags)
}

// 末尾で入力中のトークン（値は空でもよい）。候補を出す・選んだ値で置き換えるのに使う。
export const TYPING_PREFIX_RE: Readonly<Record<SearchPrefix, RegExp>> = Object.fromEntries(
  SEARCH_PREFIXES.map((p) => [p, new RegExp(`(?:^|\\s)${p}:(\\S*)$`, 'i')])
) as Record<SearchPrefix, RegExp>

// 接頭辞を打ちかけている（"ta"・"from:" など）。打ちかけの部分を候補で補う。
const PREFIX_PARTIALS = [...new Set(SEARCH_PREFIXES.flatMap((p) => [...p].map((_, i) => p.slice(0, p.length - i))))]
export const PREFIX_HINT_RE = new RegExp(`(?:^|\\s)(${PREFIX_PARTIALS.join('|')}):?$`, 'i')

// 接頭辞だけで値が無い（"from:"）。検索として意味が無いので履歴に残さない。
const BARE_PREFIX_RE = new RegExp(`^(?:${ANY_PREFIX}):$`, 'i')
export function isBarePrefix(value: string): boolean {
  return BARE_PREFIX_RE.test(value.trim())
}

// その接頭辞のトークンを外す。matches を渡すと、値がそれに当てはまるものだけを外す。
export function removeSearchTokens(raw: string, prefix: SearchPrefix, matches?: (value: string) => boolean): string {
  return raw
    .replace(new RegExp(`(^|\\s)${prefix}:(\\S+)`, 'gi'), (match, lead: string, value: string) =>
      !matches || matches(value) ? lead : match)
    .replace(/\s+/g, ' ')
    .trim()
}

// トークンを足す。プログラムからの追加なので、絞り込みを前・フリーワードを後ろに揃える。
export function addSearchToken(raw: string, prefix: SearchPrefix, value: string): string {
  return moveFreeTextToEnd(`${raw} ${prefix}:${value}`)
}

function parseDateParts(s: string): number[] | null {
  const rawParts = s.replace(/\//g, '-').split('-')
  if (rawParts.some((p) => p === '')) return null
  const parts = rawParts.map(Number)
  if (parts.length === 0 || parts.some(isNaN)) return null
  const [, m, d] = parts
  if (m !== undefined && (m < 1 || m > 12)) return null
  if (d !== undefined && (d < 1 || d > 31)) return null
  return parts
}

function parseSearchDate(s: string): number | null {
  const parts = parseDateParts(s)
  if (!parts) return null
  if (parts.length >= 3) {
    const d = new Date(parts[0], parts[1] - 1, parts[2])
    if (d.getFullYear() !== parts[0] || d.getMonth() !== parts[1] - 1 || d.getDate() !== parts[2]) return null
    return d.getTime()
  }
  if (parts.length === 2) return new Date(parts[0], parts[1] - 1, 1).getTime()
  if (parts.length === 1 && s.length === 4) return new Date(parts[0], 0, 1).getTime()
  return null
}

function parseSearchDateEnd(s: string): number | null {
  const parts = parseDateParts(s)
  if (!parts) return null
  if (parts.length >= 3) {
    const d = new Date(parts[0], parts[1] - 1, parts[2])
    if (d.getFullYear() !== parts[0] || d.getMonth() !== parts[1] - 1 || d.getDate() !== parts[2]) return null
    return new Date(parts[0], parts[1] - 1, parts[2] + 1).getTime()
  }
  if (parts.length === 2) return new Date(parts[0], parts[1], 1).getTime()
  if (parts.length === 1 && s.length === 4) return new Date(parts[0] + 1, 0, 1).getTime()
  return null
}

// どの接頭辞かを問わない、値の付いたトークン。
const FILTER_TOKEN_RE = new RegExp(`(?:^|\\s)(?:${ANY_PREFIX}):\\S+`, 'gi')

export function parseSearchQuery(raw: string): { q: string | undefined; fromDate: number | null; toDate: number | null; tags: string[]; site: string | null; mediaType: 'image' | 'video' | null } {
  const fromMatch = raw.match(tokenRe('from'))
  const toMatch = raw.match(tokenRe('to'))
  const siteMatch = raw.match(tokenRe('site'))
  const typeMatch = raw.match(tokenRe('type'))
  const tagMatches = [...raw.matchAll(tokenRe('tag', 'gi'))]
  const fromDate = fromMatch ? parseSearchDate(fromMatch[1]) : null
  const toDate = toMatch ? parseSearchDateEnd(toMatch[1]) : null
  const tags = [...new Set(tagMatches.map((m) => m[1].trim().toLowerCase()).filter(Boolean))]
  const site = siteMatch ? siteMatch[1].trim().toLowerCase() : null
  const type = typeMatch ? typeMatch[1].trim().toLowerCase() : ''
  const mediaType = type === 'video' || type === '動画'
    ? 'video'
    : type === 'image' || type === '画像'
      ? 'image'
      : null
  const q = raw.replace(FILTER_TOKEN_RE, '').trim() || undefined
  return { q, fromDate, toDate, tags, site, mediaType }
}


// tag:/site:/type:/from:/to: の構造化フィルタをまとめて前に、フリーワード部分を末尾に
// 揃える。フィルタリング結果自体は parseSearchQuery がトークンの位置に関係なく q を
// 抽出するので、並び替えても検索結果は変わらない（表示上の見やすさのためだけの整形）。
// タグクリックなどプログラムによる追加/削除の直後にだけ呼ぶこと。ユーザーが検索欄に
// 手で入力している最中に呼ぶと、打っている途中でテキストが動いて混乱させてしまう。
export function moveFreeTextToEnd(raw: string): string {
  const tokens = raw.match(FILTER_TOKEN_RE)?.map((t) => t.trim()) ?? []
  const rest = raw.replace(FILTER_TOKEN_RE, '').replace(/\s+/g, ' ').trim()
  return [...tokens, rest].filter(Boolean).join(' ')
}

function uniqueTags(queryTags: string[]): string[] | undefined {
  const unique = [...new Set(queryTags)]
  return unique.length > 0 ? unique : undefined
}

export function buildImageQuery(f: CommittedFilters): ImageQuery {
  const { q, fromDate, toDate, tags, site, mediaType } = parseSearchQuery(f.search)
  return {
    search: q,
    after: fromDate ?? undefined,
    site: site ?? undefined,
    mediaType: mediaType ?? undefined,
    tags: uniqueTags(tags),
    tagMode: f.tagMode,
    toDate: toDate ?? undefined,
  }
}
