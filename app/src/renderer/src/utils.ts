import type { ImageRow, ImageTag, ImageTagSource } from './types'
import { MAX_BULK_IDS, MAX_TAG_LENGTH } from '../../shared/constants'

export { MAX_TAG_LENGTH }

// DetailPanel/QuickTagInput/TagEditor で個別に持っていた同一実装を集約（B7/Q1）。
// main 側（ipc-tagger.ts）も taggerAddTag* で同じ正規化を最終防衛として適用しており、
// 表記ゆれ（"Tag Name" 等）で別タグ化しないよう両側で揃える。
export function normalizeTag(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_').slice(0, MAX_TAG_LENGTH)
}

// タグ入力欄向け: 正規化（小文字化・空白→_）で確定後の見た目が入力値と変わる場合だけ、
// その見た目をプレビューとして返す（変わらないなら null）。入力中に「打ったものと
// 違うタグが付いた」と感じさせないよう、確定前に予告する（UX-4）。
export function tagNormalizePreview(input: string): string | null {
  const normalized = normalizeTag(input)
  return normalized && normalized !== input ? normalized : null
}

// taggerGetTagsBulk/taggerAddTagBulk/taggerRemoveTagBulk は main 側で MAX_BULK_IDS 件に
// 打ち切られるため、renderer 側で MAX_BULK_IDS 件ずつに分割して逐次呼び出し、全件を処理する。
export function chunkIds(ids: number[], size = MAX_BULK_IDS): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

export function tagSuggestions(
  input: string,
  allTags: string[],
  shouldInclude: (tag: string) => boolean,
): string[] {
  const q = input.trim().toLowerCase()
  if (!q) return []
  return allTags
    .filter((tag) => tag.toLowerCase().includes(q) && shouldInclude(tag))
    .slice(0, 8)
}

// 複数画像へのタグ一括操作（DetailPanelの一括編集/QuickTagInputで個別に持っていた
// 取得・追加・削除ロジックを集約: F-9）。

// タグ名 → 「何枚に付いているか(count)」と「集約後の由来(source)」。source は
// 「手動が1件でもあれば manual」で畳む（DB の listAllTags や UPSERT 昇格と同じルール）。
export type BulkTagInfo = { count: number; source: ImageTagSource }

// imageIds 各々のタグを chunked で取得し、上記の頻度＋由来表にする。
// 呼び出し側は count===imageIds.length で「全員に付いている」か判定する。
export async function fetchBulkTagFrequency(imageIds: number[]): Promise<Map<string, BulkTagInfo>> {
  const results = await Promise.all(chunkIds(imageIds).map((chunk) => window.api.taggerGetTagsBulk(chunk)))
  const byId = Object.assign({}, ...results) as Record<number, ImageTag[]>
  const freq = new Map<string, BulkTagInfo>()
  for (const id of imageIds) {
    for (const { name, source } of byId[id] ?? []) {
      const prev = freq.get(name)
      if (prev) {
        prev.count += 1
        if (source === 'manual') prev.source = 'manual'
      } else {
        freq.set(name, { count: 1, source })
      }
    }
  }
  return freq
}

export async function addTagToImages(imageIds: number[], tag: string): Promise<void> {
  for (const chunk of chunkIds(imageIds)) {
    await window.api.taggerAddTagBulk(chunk, tag, 'manual')
  }
}

export async function removeTagFromImages(imageIds: number[], tag: string): Promise<void> {
  for (const chunk of chunkIds(imageIds)) {
    await window.api.taggerRemoveTagBulk(chunk, tag)
  }
}

const ACCELERATOR_KEY_MAP: Record<string, string> = {
  ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'Enter': 'Return', 'Backspace': 'Backspace', 'Delete': 'Delete', 'Escape': 'Escape',
  'Tab': 'Tab', 'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
}

// キー入力からホットキー設定UI用のアクセラレータ文字列（例: "Ctrl+Alt+S"）を組み立てる。
// 修飾キー単体のキー押下や修飾キーなしの入力は null（未確定）を返す。
export function buildAccelerator(e: React.KeyboardEvent | KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  if (mods.length === 0) return null
  const key = ACCELERATOR_KEY_MAP[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return [...mods, key].join('+')
}

export function cleanTitle(title: string | null, patterns: string[]): string {
  if (!title) return '—'
  for (const pat of patterns) {
    if (!pat) continue
    const idx = title.lastIndexOf(pat)
    if (idx > 0) return title.slice(0, idx).trim()
  }
  return title
}

export type TextSegment = { text: string; match: boolean }

// 検索キーワードにヒットした箇所をハイライト表示するための分割。DB 側の検索（FTS trigram /
// LIKE）と同じ「大文字小文字を無視した部分一致」に合わせ、最初の1箇所だけでなく全ての
// 出現箇所を分割する。query が空なら分割せず全体を非マッチとして返す。
export function splitHighlight(text: string, query: string): TextSegment[] {
  const q = query.trim()
  if (!q) return [{ text, match: false }]
  const lowerText = text.toLowerCase()
  const lowerQuery = q.toLowerCase()
  const segments: TextSegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor)
    if (idx === -1) {
      segments.push({ text: text.slice(cursor), match: false })
      break
    }
    if (idx > cursor) segments.push({ text: text.slice(cursor, idx), match: false })
    segments.push({ text: text.slice(idx, idx + q.length), match: true })
    cursor = idx + q.length
  }
  return segments.length > 0 ? segments : [{ text, match: false }]
}

export const SITE_NAME_MAP: Record<string, string> = {
  'youtube.com': 'YouTube',
  'netflix.com': 'Netflix',
  'nicovideo.jp': 'niconico',
  'abema.tv': 'ABEMA',
  'amazon.co.jp': 'Prime Video',
  'primevideo.com': 'Prime Video',
  'disneyplus.com': 'Disney+',
  'tv.dmm.com': 'DMM TV',
  'd.dmm.com': 'DMM TV',
  'video.unext.jp': 'U-NEXT',
  'u-next.com': 'U-NEXT',
  'animestore.docomo.ne.jp': 'dアニメストア',
  'animestore.co.jp': 'dアニメストア',
}

export function siteName(url: string | null): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return SITE_NAME_MAP[host] ?? host
  } catch {
    return null
  }
}

export function formatTime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

// メディア URL の解決口。既定は Electron の capfile:// プロトコル（bootstrap.ts が処理する）。
// Web デモ版は capfile:// を持てないため、起動時に web/mockApi.ts が同梱アセットの URL を
// 返す関数へ差し替える。features/registry.ts と同じく「コアは差し替え口だけ知る」形にして、
// 呼び出し側（ThumbCell / Viewer / VideoPlayer）は分岐を持たない。
type MediaUrlResolver = (id: number, kind: 'media' | 'thumb') => string
let mediaUrlResolver: MediaUrlResolver | null = null

export function setMediaUrlResolver(fn: MediaUrlResolver): void {
  mediaUrlResolver = fn
}

// capfile:// プロトコルでメディア本体／サムネを取得する URL を組み立てる。
export function mediaUrl(id: number, kind: 'media' | 'thumb' = 'media'): string {
  if (mediaUrlResolver) return mediaUrlResolver(id, kind)
  return `capfile://img?id=${id}&kind=${kind}`
}

// サムネ表示用 URL。thumb_path があれば軽量サムネ、なければ原本を指す
// （capfile プロトコル側で kind=thumb は thumb_path ?? filepath にフォールバックする）。
export function thumbSrc(img: ImageRow): string {
  return mediaUrl(img.id, img.thumb_path ? 'thumb' : 'media')
}

// グリッド/タイムラインの列数・セル幅・セル高(16:9)を共通計算する。
// グリッド表示の実描画(App.tsx)とキーボードナビゲーションの列数想定(App.tsx)、
// タイムラインの実描画(TimelineView.tsx)が同じ式をそれぞれ持っていると、
// gap の値がどこか一箇所だけズレたときに「見た目の列数とナビゲーションの列数が
// 静かに食い違う」バグを生みやすいため、ここに一本化する。
export type GridLayout = { columns: number; cellWidth: number; cellHeight: number }
export function computeGridLayout(containerWidth: number, minCellWidth: number, gap: number): GridLayout {
  if (containerWidth <= 0) return { columns: 1, cellWidth: minCellWidth, cellHeight: minCellWidth * 9 / 16 }
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (minCellWidth + gap)))
  const cellWidth = (containerWidth - gap * (columns - 1)) / columns
  return { columns, cellWidth, cellHeight: cellWidth * 9 / 16 }
}

export type TimelineItem = { img: ImageRow; flatIndex: number }
export type TimelineGroup = { key: string; title: string | null; items: TimelineItem[] }

// LCG (Linear Congruential Generator) ベースのシャッフル。
// Math.random() を useMemo 内で使うと Concurrent Mode で毎描画再計算されるため、
// seed を受け取り決定的なシャッフルを行う。seed が同じなら常に同じ順序になる。
function lcgShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr]
  let s = seed | 0
  for (let i = a.length - 1; i > 0; i--) {
    s = Math.imul(s, 1664525) + 1013904223 | 0
    const j = (s >>> 0) % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 作品別タイムライン用のグルーピング。
// - グループキーは cleanTitle 後のタイトルで厳密一致（表記揺れの吸収は今回はしない）
// - グループ内は再生時刻(current_time)昇順、時刻なしは末尾（撮影時刻昇順）
// - グループ自体は最新の撮影時刻が新しい作品を先頭に並べる
// ordered は groups をフラット化した配列で、ビューア／キーボード移動のインデックス基準になる。
export function buildTimeline(images: ImageRow[], titleStrip: string[], sortOrder: string = 'date_desc', shuffleSeed?: number): { groups: TimelineGroup[]; ordered: ImageRow[] } {
  const map = new Map<string, { title: string | null; items: ImageRow[]; latest: number }>()
  for (const img of images) {
    const key = cleanTitle(img.title, titleStrip)
    const bucket = map.get(key)
    if (bucket) {
      bucket.items.push(img)
      if (img.captured_at > bucket.latest) bucket.latest = img.captured_at
    } else {
      map.set(key, { title: img.title, items: [img], latest: img.captured_at })
    }
  }

  const entries = [...map.entries()]
  const sortedKeys = sortOrder === 'date_asc'
    ? entries.sort((a, b) => a[1].latest - b[1].latest)
    : sortOrder === 'random'
      ? lcgShuffle(entries, shuffleSeed ?? 0)
      : entries.sort((a, b) => b[1].latest - a[1].latest)
  const groups: TimelineGroup[] = []
  const ordered: ImageRow[] = []
  for (const [key, bucket] of sortedKeys) {
    bucket.items.sort((a, b) => {
      const at = a.current_time, bt = b.current_time
      if (at == null && bt == null) return a.captured_at - b.captured_at
      if (at == null) return 1
      if (bt == null) return -1
      return at - bt || a.captured_at - b.captured_at
    })
    const items: TimelineItem[] = bucket.items.map((img) => {
      const flatIndex = ordered.length
      ordered.push(img)
      return { img, flatIndex }
    })
    groups.push({ key, title: bucket.title, items })
  }
  return { groups, ordered }
}
