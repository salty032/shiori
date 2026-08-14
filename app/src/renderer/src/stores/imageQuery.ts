import type { ImageQuery } from '../types'
import type { CommittedFilters } from './filterStore'

// 検索文字列のパース（tag:/from:/to:）と確定フィルタを 1 つの ImageQuery にまとめる。
// グリッド一覧・タイムライン・件数集計が共有する「フィルタとは何か」の単一定義。
// ストア（imageStore）とフック双方から参照するため、循環参照回避でここに独立させている。

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

export function parseSearchQuery(raw: string): { q: string | undefined; fromDate: number | null; toDate: number | null; tags: string[]; site: string | null; mediaType: 'image' | 'video' | null } {
  const fromMatch = raw.match(/(?:^|\s)from:(\S+)/i)
  const toMatch = raw.match(/(?:^|\s)to:(\S+)/i)
  const siteMatch = raw.match(/(?:^|\s)site:(\S+)/i)
  const typeMatch = raw.match(/(?:^|\s)type:(\S+)/i)
  const tagMatches = [...raw.matchAll(/(?:^|\s)tag:(\S+)/gi)]
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
  const q = raw.replace(/(?:^|\s)(?:from|to|tag|site|type):\S+/gi, '').trim() || undefined
  return { q, fromDate, toDate, tags, site, mediaType }
}

const FILTER_TOKEN_RE = /(?:^|\s)(?:from|to|tag|site|type):\S+/gi

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

function mergeTags(selectedTags: string[], queryTags: string[]): string[] | undefined {
  const merged = [...new Set([...selectedTags, ...queryTags])]
  return merged.length > 0 ? merged : undefined
}

export function buildImageQuery(f: CommittedFilters): ImageQuery {
  const { q, fromDate, toDate, tags, site, mediaType } = parseSearchQuery(f.search)
  return {
    search: q,
    after: fromDate ?? undefined,
    site: site ?? undefined,
    mediaType: mediaType ?? undefined,
    tags: mergeTags(f.tagFilters, tags),
    tagMode: f.tagMode,
    toDate: toDate ?? undefined,
  }
}
