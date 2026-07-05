// IPC ハンドラ向けの入力バリデーション・サニタイズ・整形ヘルパー。
// すべてモジュール state に依存しない純粋関数（テスト容易・index.ts から切り出し）。
import { join, extname } from 'path'
import { access } from 'fs/promises'
import { resolveRealCapturePath } from './paths'
import type { ImageQuery, ImageListRequest, SortOrder } from '../shared/types'

export const MAX_IMAGE_LIMIT = 200
export const MAX_TEXT_LENGTH = 500
export const MAX_TAGS_PER_FILTER = 50
export const MAX_TAG_LENGTH = 16
export const MAX_EXPORT_IDS = 1000

export function clampImageLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50
  return Math.min(MAX_IMAGE_LIMIT, Math.max(1, Math.trunc(value)))
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function optionalText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

// renderer 側（DetailPanel/QuickTagInput/TagEditor）と同じ正規化規則。main を最終防衛にし、
// renderer を経由しない・改修漏れの経路でも "Tag Name" のような表記ゆれで別タグ化しないようにする。
export function normalizeTagName(value: unknown, max = MAX_TAG_LENGTH): string | undefined {
  const text = optionalText(value, max)
  if (!text) return undefined
  const normalized = text.toLowerCase().replace(/\s+/g, '_')
  return normalized || undefined
}

export function optionalColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}

export function tagMode(value: unknown): 'and' | 'or' {
  return value === 'or' ? 'or' : 'and'
}

export function tagSource(value: unknown): 'manual' | 'ai' {
  return value === 'manual' ? 'manual' : 'ai'
}

export function tagsFilter(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags = value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
    .filter(Boolean)
  return [...new Set(tags)].slice(0, MAX_TAGS_PER_FILTER)
}

function sortOrder(value: unknown): SortOrder {
  return value === 'date_asc' ? 'date_asc' : value === 'random' ? 'random' : 'date_desc'
}

// renderer から届いた未検証のフィルタ条件を、検証済みの ImageQuery に正規化する。
// 各フィールドは既存のフィールド単位バリデータを再利用する。
export function imageQuery(raw: unknown): ImageQuery {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    search: optionalText(o.search),
    after: optionalNumber(o.after),
    site: optionalText(o.site),
    tags: tagsFilter(o.tags),
    tagMode: tagMode(o.tagMode),
    color: optionalColor(o.color),
    toDate: optionalNumber(o.toDate),
  }
}

// グリッド一覧用：ImageQuery にカーソルページング・件数上限・並び順を足して検証する。
export function imageListRequest(raw: unknown): ImageListRequest {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    ...imageQuery(raw),
    limit: clampImageLimit(o.limit),
    before: optionalNumber(o.before),
    beforeId: optionalPositiveInteger(o.beforeId),
    sortOrder: sortOrder(o.sortOrder),
  }
}

export async function requireRealCapturePath(value: unknown): Promise<string> {
  const filePath = await resolveRealCapturePath(value)
  if (!filePath) throw new Error('Invalid capture path')
  return filePath
}

export function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return (cleaned || 'capture').slice(0, 120)
}

export function formatDateForFilename(value: number): string {
  const d = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function formatTimecodeForFilename(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return ''
  const total = Math.max(0, Math.floor(value))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}${pad(m)}${pad(s)}` : `${pad(m)}${pad(s)}`
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false)
}

// 一括共有エクスポート用：basename をそのまま使い、衝突時のみ `_n` を付与する。
export async function uniqueExportFilename(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = name
  let n = 1
  while (true) {
    try { await access(join(dir, candidate)) } catch { return candidate }
    candidate = `${base}_${n}${ext}`
    n++
  }
}

// 選択エクスポート用：タイトル等から組んだ名前をサニタイズし、衝突時は ` (n)` を付与する。
export async function uniqueExportPath(destDir: string, preferredName: string, used: Set<string>): Promise<string> {
  const parsedExt = extname(preferredName) || '.png'
  const base = sanitizeFilename(preferredName.slice(0, preferredName.length - parsedExt.length))
  const ext = parsedExt.toLowerCase() === '.png' ? '.png' : parsedExt
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`
    const target = join(destDir, name)
    const key = target.toLowerCase()
    if (!used.has(key) && !await fileExists(target)) {
      used.add(key)
      return target
    }
  }
}
