import type { ImageRow, ImageTag, ImageTagSource } from './types'
import { MAX_BULK_IDS, MAX_TAG_LENGTH } from '../../shared/constants'
import { normalizeSearchText } from '../../shared/normalize'

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
function chunkIds(ids: number[], size = MAX_BULK_IDS): number[][] {
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
type BulkTagInfo = { count: number; source: ImageTagSource }

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

type TextSegment = { text: string; match: boolean }

// text をコードポイント境界だけで区切った、元文字列側のオフセット一覧（サロゲートペアを
// 割らないため）。offsets[k] は k 番目のコードポイントの直前のオフセット。
function codepointOffsets(text: string): number[] {
  const offsets: number[] = [0]
  let offset = 0
  for (const ch of text) { offset += ch.length; offsets.push(offset) }
  return offsets
}

// 正規化後の位置 normPos に対応する元文字列側の境界を二分探索で求める。
// normalizeSearchText(text.slice(0, i)).length は i について単調非減少なので二分探索できる
// （文字ごとに正規化して足し合わせる方式は使えない。半角カナ+濁点→1文字のような合成は
// 前後の文字の組み合わせに依存し、実際の部分文字列を正規化しないと再現できないため）。
//
// upper=true（マッチ開始側）: その位置まで正規化後の長さが変わらない文字（例:
// 単語の前のスペース、記号）を手前の非マッチ側へ残す。
// upper=false（マッチ終了側）: 逆に後ろの非マッチ側へ残す。
// 半角カナの濁点合成のように、正規化後の1文字が複数の元文字にまたがる場合は境界が
// 最大1文字ずれうるが、ハイライトの見た目だけの問題で検索結果の件数には影響しない。
function mapNormalizedIndex(text: string, offsets: number[], normPos: number, upper: boolean): number {
  const lenAt = (k: number): number => normalizeSearchText(text.slice(0, offsets[k])).length
  let lo = 0
  let hi = offsets.length - 1
  if (upper) {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lenAt(mid) <= normPos) lo = mid
      else hi = mid - 1
    }
  } else {
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lenAt(mid) >= normPos) hi = mid
      else lo = mid + 1
    }
  }
  return offsets[lo]
}

// 検索キーワードにヒットした箇所をハイライト表示するための分割。DB 側の検索（FTS trigram /
// LIKE）と同じ normalizeSearchText を通してから当てるため、半角カナ・全角英数・カタカナ/
// ひらがな・記号や空白の有無といった表記ゆれもハイライトされる（docs/SPEC.md 5章）。
// 最初の1箇所だけでなく全ての出現箇所を分割する。query が正規化して空になる（未入力・
// 記号のみ）なら分割せず全体を非マッチとして返す。
export function splitHighlight(text: string, query: string): TextSegment[] {
  const q = normalizeSearchText(query)
  if (!q) return [{ text, match: false }]
  const normText = normalizeSearchText(text)
  const offsets = codepointOffsets(text)
  const segments: TextSegment[] = []
  let textCursor = 0
  let normCursor = 0
  while (normCursor <= normText.length) {
    const normIdx = normText.indexOf(q, normCursor)
    if (normIdx === -1) {
      if (textCursor < text.length) segments.push({ text: text.slice(textCursor), match: false })
      break
    }
    const startIdx = mapNormalizedIndex(text, offsets, normIdx, true)
    const endIdx = mapNormalizedIndex(text, offsets, normIdx + q.length, false)
    if (startIdx > textCursor) segments.push({ text: text.slice(textCursor, startIdx), match: false })
    if (endIdx > startIdx) segments.push({ text: text.slice(startIdx, endIdx), match: true })
    textCursor = Math.max(textCursor, endIdx)
    normCursor = normIdx + q.length
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
  'video.unext.jp': 'U-NEXT',
  'animestore.docomo.ne.jp': 'dアニメストア',
  'bilibili.com': 'Bilibili',
  'bilibili.tv': 'Bilibili',
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

// 使用量表示（設定 > データ）。桁数を揃えるのではなく有効数字を揃える——12.4 GB / 210 MB / 8 MB の
// ように、大きいものだけ小数第1位まで出す。1000 未満で単位を上げるのは、999 MB の次が 1.0 GB に
// なるより 0.98 GB のほうが読みにくいため。
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // 10 以上は整数（12 GB）、10 未満は小数第1位（8.4 GB）。桁が増えるほど小数の情報量は減る。
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
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
// **高さは整数に丸める。幅は丸めない。**
// 幅は「画面幅を列数で割り切る」値なので端数が出る（例 233.43px）。そのまま 9/16 を掛けると
// 行の高さも小数になり、仮想リストが行を index × 行高 の位置へ置くので、1 行ぶん送るたびに
// 実際の移動量が 161px の回と 162px の回に分かれる。行の隙間も 4px と 5px が交互に見え、
// 矢印キーで送ったときに画面が揺れて見えていた。
// 縦だけ整数にすれば送り幅が毎回同じになる。幅は横方向にしか効かないので丸めない
//（丸めると列の合計が画面幅に届かず、右端に半端な余りが残る）。
// 代償：セルの縦横比が厳密な 16:9 から最大 0.5px ずれる。絵は cover で敷いているので見えない。
export function computeGridLayout(containerWidth: number, minCellWidth: number, gap: number): GridLayout {
  if (containerWidth <= 0) return { columns: 1, cellWidth: minCellWidth, cellHeight: Math.round(minCellWidth * 9 / 16) }
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (minCellWidth + gap)))
  const cellWidth = (containerWidth - gap * (columns - 1)) / columns
  return { columns, cellWidth, cellHeight: Math.round(cellWidth * 9 / 16) }
}

type TimelineItem = { img: ImageRow; flatIndex: number }
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

// fps の表示。23.976023… のような値を 23.976 に、24.000 を 24 にする。
// 末尾の 0 を落とすのは、24fps 素材が「24.000fps」と出ると精度を主張しすぎるため。
export function formatFps(fps: number): string {
  return String(Math.round(fps * 1000) / 1000)
}

// キーボードで送ったときのスクロール。**ブラウザ標準の smooth は使わない。**
// 標準は 1 回の動きに数百 ms かけるので、矢印を押しっぱなしにすると画面が選択に
// まったく追いつかず、何十行も後ろを走る。かといって瞬間移動に戻すと 1 行ぶん飛ぶたびに
// 絵が入れ替わって目が追えない。180ms で詰める（90ms まで詰めたら「速すぎて目が痛い」）。
//
// 押すたびに前の動きは捨てて、今いる位置から新しい目的地へ引き直す。
// 端数は毎フレーム丸める（小数の scrollTop は描画時に丸められ、行の隙間が 1px 揺れて見える）。
// OS の「視差効果を減らす」設定時は動かさず即座に飛ぶ。
//
// **仮想リストの scrollToFn には差さない。** 差すと行き先の計算が仮想リスト側の
// 「今どこまでスクロールしたか」の記録を基準に行われるが、その記録はスクロールイベント
// 経由で遅れて届く。アニメーション中に次のキーが来ると古い位置を基準に計算してしまい、
// 送ったのに一瞬戻る動きが出る。**行き先は呼び出し側が実際の scrollTop から決めること。**
const SOFT_SCROLL_MS = 180

export function createSoftScroller(): (el: HTMLElement, top: number) => void {
  let raf = 0
  return (el, top) => {
    cancelAnimationFrame(raf)
    const to = Math.max(0, Math.round(top))
    const from = el.scrollTop
    const distance = to - from
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced || Math.abs(distance) < 1) { el.scrollTop = to; return }
    const startedAt = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / SOFT_SCROLL_MS)
      const eased = 1 - (1 - t) ** 2
      el.scrollTop = Math.round(from + distance * eased)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }
}
