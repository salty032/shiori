// Web デモ版のデモ素材目録（demo-assets/manifest.json）を生成する。
//
// app/demo-assets/ に置かれた画像・動画を走査し、ファイル名から既定のメタデータを組み立てる。
// 素材ごとの値を指定したいときは demo-assets/meta.json で上書きする（下記 META 参照）。
//
// 「素材を差し替えるのに TypeScript を触らなくていい」ことがこのスクリプトの存在理由。
// 生成物は gitignore 対象で、web:build / GitHub Actions が毎回作り直す。

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname, extname, basename } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_DIR = resolve(ROOT, 'demo-assets')
const META_PATH = resolve(ASSET_DIR, 'meta.json')
const OUT_PATH = resolve(ASSET_DIR, 'manifest.json')

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov'])

// 目録に載せない管理用ファイル。publicDir ごと配信されるので、走査対象からだけ外す。
const SKIP = new Set(['manifest.json', 'meta.json', 'README.md', '.gitkeep'])

// 既定の配信サービス。1 日 1 サービスで巡回させると、サイドバーのサービス絞り込みと
// タイムラインの日付グルーピングが両方とも意味のある見た目になる。
const SERVICES = [
  { host: 'youtube.com', url: 'https://www.youtube.com/' },
  { host: 'netflix.com', url: 'https://www.netflix.com/' },
  { host: 'abema.tv', url: 'https://abema.tv/' },
  { host: 'nicovideo.jp', url: 'https://www.nicovideo.jp/' },
  { host: 'animestore.docomo.ne.jp', url: 'https://animestore.docomo.ne.jp/' },
]

const DEFAULT_TAGS = ['OP', 'ED', '背景', '作画', '表情']

// 1 セッション（＝同じ日にまとめて撮った塊）あたりの枚数と、その中の撮影間隔。
const SESSION_SIZE = 5
const STEP_MS = 7 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 基準時刻。生成のたびに日付が動くとデモの見た目が変わるので、固定値にする。
const BASE_AT = new Date('2026-07-20T21:00:00').getTime()

function loadMeta() {
  if (!existsSync(META_PATH)) return { defaults: {}, files: {} }
  const parsed = JSON.parse(readFileSync(META_PATH, 'utf-8'))
  return { defaults: parsed.defaults ?? {}, files: parsed.files ?? {} }
}

function titleFromFileName(file) {
  return basename(file, extname(file)).replace(/[_-]+/g, ' ').trim() || null
}

function buildItem(file, index, meta) {
  const ext = extname(file).toLowerCase()
  const mediaType = VIDEO_EXT.has(ext) ? 'video' : 'image'
  const day = Math.floor(index / SESSION_SIZE)
  const slot = index % SESSION_SIZE
  const service = SERVICES[day % SERVICES.length]
  const override = meta.files[file] ?? {}

  const tags = override.tags ?? [DEFAULT_TAGS[index % DEFAULT_TAGS.length]]
  const aiTags = override.aiTags ?? []

  return {
    file,
    mediaType,
    title: override.title ?? titleFromFileName(file),
    host: override.host ?? meta.defaults.host ?? service.host,
    url: override.url ?? meta.defaults.url ?? service.url,
    // 再生位置はセッション内で進んでいく方が自然に見える（同じ話数を見ている想定）。
    currentTime: override.currentTime ?? 120 + slot * 420,
    capturedAt: override.capturedAt != null
      ? new Date(override.capturedAt).getTime()
      : BASE_AT - day * DAY_MS - slot * STEP_MS,
    // 動画の尺は静的解析では出せない。null のままにしておくと、起動時にブラウザが
    // メタデータから解決する（src/renderer/src/web/manifest.ts）。
    duration: override.duration ?? null,
    fps: override.fps ?? null,
    memo: override.memo ?? null,
    tags: [
      ...tags.map((name) => ({ name, source: 'manual' })),
      ...aiTags.map((name) => ({ name, source: 'ai' })),
    ],
  }
}

function main() {
  if (!existsSync(ASSET_DIR)) {
    console.error(`demo-assets/ が見つかりません: ${ASSET_DIR}`)
    process.exit(1)
  }

  const meta = loadMeta()
  const files = readdirSync(ASSET_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = extname(name).toLowerCase()
      return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)
    })
    .sort((a, b) => a.localeCompare(b))

  const items = files.map((file, index) => buildItem(file, index, meta))
  writeFileSync(OUT_PATH, JSON.stringify({ items }, null, 2) + '\n', 'utf-8')

  const videos = items.filter((item) => item.mediaType === 'video').length
  console.log(`demo manifest: ${items.length} 件（画像 ${items.length - videos} / 動画 ${videos}）→ demo-assets/manifest.json`)
  if (items.length === 0) {
    console.warn('デモ素材が 1 件もありません。app/demo-assets/ に画像や動画を置いてください。')
  }
}

main()
