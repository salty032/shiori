// Web デモ版が読み込むデモ素材の目録。
//
// 実体は app/demo-assets/ に置いた画像・動画で、manifest.json は
// app/scripts/build-demo-manifest.mjs がビルド時に生成する（gitignore 対象）。
// 目録をコードに埋め込まずビルド時生成 + 実行時 fetch にしているのは、素材を
// 差し替えるときに TypeScript を一切触らずに済ませるため。

import type { ImageRow, ImageTag } from '../types'

type DemoItem = {
  // demo-assets/ からの相対パス。そのまま base URL に連結すると配信 URL になる。
  file: string
  mediaType: 'image' | 'video'
  title: string | null
  host: string
  url: string | null
  currentTime: number | null
  capturedAt: number
  duration: number | null
  fps: number | null
  memo: string | null
  tags: ImageTag[]
}

export type DemoManifest = { items: DemoItem[] }

// 目録の形を確かめる。**目録は 2 つのスクリプトが型検査なしで書く**（build-demo-manifest.mjs と、
// 画面の確認の verify-renderer.cjs）。DemoItem に項目を足しても書く側は落ちず、デモは undefined を
// 黙って表示していた。ここで項目ごとに確かめ、違えば読み込みを止める（verify:renderer もそこで落ちる）。
// Record<keyof DemoItem, …> なので、DemoItem に項目を足すとここの書き忘れは型で落ちる。
const isText = (v: unknown): boolean => typeof v === 'string'
const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const orNull = (check: (v: unknown) => boolean) => (v: unknown): boolean => v === null || check(v)
const ITEM_FIELDS: Record<keyof DemoItem, (v: unknown) => boolean> = {
  file: isText,
  mediaType: (v) => v === 'image' || v === 'video',
  title: orNull(isText),
  host: isText,
  url: orNull(isText),
  currentTime: orNull(isNumber),
  capturedAt: isNumber,
  duration: orNull(isNumber),
  fps: orNull(isNumber),
  memo: orNull(isText),
  tags: (v) => Array.isArray(v) && v.every((tag: unknown) =>
    typeof tag === 'object' && tag !== null &&
    isText((tag as ImageTag).name) && ((tag as ImageTag).source === 'manual' || (tag as ImageTag).source === 'ai')),
}

export function parseDemoManifest(raw: unknown): DemoManifest {
  const items = (raw as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) throw new Error('demo manifest: items がありません')
  items.forEach((item: unknown, i) => {
    if (typeof item !== 'object' || item === null) throw new Error(`demo manifest: items[${i}] が項目の形をしていません`)
    const record = item as Record<string, unknown>
    for (const [key, check] of Object.entries(ITEM_FIELDS)) {
      if (!check(record[key])) throw new Error(`demo manifest: items[${i}].${key} の形が違います（${JSON.stringify(record[key])}）`)
    }
    const unknownKeys = Object.keys(record).filter((key) => !(key in ITEM_FIELDS))
    if (unknownKeys.length > 0) throw new Error(`demo manifest: items[${i}] に知らない項目があります（${unknownKeys.join(', ')}）`)
  })
  return raw as DemoManifest
}

// 目録に載った 1 件を、UI が扱う ImageRow へ変換する。id は目録の並び順で採番する
// （デスクトップ版の DB 採番と同じく「新しいものほど大きい id」にはしない。デモは
// 並び替えを captured_at で行うため id の大小に意味を持たせる必要がない）。
function toImageRow(item: DemoItem, id: number): ImageRow {
  return {
    id,
    filepath: item.file,
    captured_at: item.capturedAt,
    title: item.title,
    current_time: item.currentTime,
    url: item.url,
    memo: item.memo,
    media_type: item.mediaType,
    duration: item.duration,
    fps: item.fps,
    // 目録は画素数を持たない（静的解析では出せない）。デモは画質の判断をする場ではないので
    // 空欄のままにして、詳細パネルの解像度行を出さない。
    width: null,
    height: null,
    // デモ素材は原本をそのままサムネにも使う（サムネ生成器が main プロセス側の機能のため）。
    thumb_path: null,
    source: 'capture',
  }
}

type DemoLibrary = {
  rows: ImageRow[]
  // id → 配信 URL。mediaUrl() の差し替え先が引く。
  urlById: Map<number, string>
  // id → タグ。デモ中の編集はこの Map 上で完結する（永続化しない）。
  tagsById: Map<number, ImageTag[]>
  hostById: Map<number, string>
}

// 動画の尺は目録に無ければブラウザに読ませて埋める。ffprobe 相当を持てないビルド時に
// null で出しておき、起動時に <video> のメタデータから 1 度だけ解決する。
async function resolveDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement('video')
    el.preload = 'metadata'
    const done = (value: number | null): void => {
      el.removeAttribute('src')
      resolve(value)
    }
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null)
    el.onerror = () => done(null)
    el.src = url
  })
}

export async function loadDemoLibrary(): Promise<DemoLibrary> {
  const base = import.meta.env.BASE_URL
  const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`demo manifest not found (${res.status})`)
  const manifest = parseDemoManifest(await res.json())

  const rows: ImageRow[] = []
  const urlById = new Map<number, string>()
  const tagsById = new Map<number, ImageTag[]>()
  const hostById = new Map<number, string>()

  manifest.items.forEach((item, index) => {
    const id = index + 1
    rows.push(toImageRow(item, id))
    urlById.set(id, `${base}${item.file}`)
    tagsById.set(id, item.tags.map((tag) => ({ ...tag })))
    hostById.set(id, item.host)
  })

  await Promise.all(
    rows
      .filter((row) => row.media_type === 'video' && row.duration == null)
      .map(async (row) => {
        row.duration = await resolveDuration(urlById.get(row.id)!)
      })
  )

  return { rows, urlById, tagsById, hostById }
}
