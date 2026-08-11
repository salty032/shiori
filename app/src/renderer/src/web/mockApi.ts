// Web デモ版の window.api 実装。
//
// renderer はネイティブ依存を ShioriApi（+ VideoApi）1 本に集約してあるので、この型を
// ブラウザ内で満たすものを 1 つ用意すれば UI はそのまま動く。main プロセス・preload・
// SQLite は一切関与しない。
//
// 方針:
//   * ライブラリ閲覧に関わる操作（一覧・検索・フィルタ・タグ編集・削除）は db.ts の
//     意味論を写して**本当に動かす**。デモの目的が「どう動くかを触って確かめる」ことなので、
//     ここを飾りにすると意味がない。
//   * OS・ファイルシステム・外部プロセスが要る操作（キャプチャ / 録画 / エクスポート /
//     AI タグ付け / トリミング）は notice で断る。無言の no-op にすると壊れて見える。
//   * 状態はメモリのみ。リロードで初期状態へ戻る（デモを次に触る人へ持ち越さない）。

import type { ShioriApi } from '../../../shared/api'
import type { VideoApi } from '../../../shared/api.video'
import { SETTINGS_DEFAULTS } from '../../../shared/settingsDefaults'
import type {
  AppNotice, DeleteImageResult, ImageListRequest, ImageQuery, ImageRow,
  ImageTag, ImageTagSource, Settings, TagWithCount,
} from '../types'
import { t } from '../i18n'
import { setMediaUrlResolver } from '../utils'
import { normalizeSearchText } from '../../../shared/normalize'
import { loadDemoLibrary } from './manifest'

// vite.web.config.ts の define がビルド時に app/package.json の version を埋める。
declare const __APP_VERSION__: string

const MAX_LIST_LIMIT = 200
const MAX_TIMELINE_LIMIT = 5000

// main → renderer の push チャンネル用の最小の購読管理。preload の on* と同じく
// 解除関数を返す契約に揃える。
function channel<T>(): { emit: (data: T) => void; on: (cb: (data: T) => void) => () => void } {
  const subscribers = new Set<(data: T) => void>()
  return {
    emit: (data) => subscribers.forEach((cb) => cb(data)),
    on: (cb) => {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
  }
}

export async function installMockApi(): Promise<void> {
  const lib = await loadDemoLibrary()

  // capfile:// の代わりに同梱アセットの URL を返す。thumb / media の区別は無い
  // （デモ素材は原本をそのままサムネにも使う）。
  setMediaUrlResolver((id) => lib.urlById.get(id) ?? '')

  const state = {
    rows: lib.rows,
    tagsById: lib.tagsById,
    hostById: lib.hostById,
    settings: { ...SETTINGS_DEFAULTS } as Settings,
  }

  const notice = channel<AppNotice>()
  const noop = channel<never>()

  // デスクトップ専用機能を押されたときの共通の断り方。Promise を返す API は
  // 「呼べたが何も起きなかった」ではなくトーストで理由を出す。
  function unsupported(): void {
    notice.emit({ level: 'info', message: t('demo.unavailable') })
  }

  function tagsOf(id: number): ImageTag[] {
    return state.tagsById.get(id) ?? []
  }

  // db.ts の buildImageFilter を写した絞り込み。FTS は持たないので検索は
  // title / memo の部分一致に統一する（デモ規模では体感差が出ない）。search_text 相当を
  // その場で組み立て、db.ts と同じ normalizeSearchText を通してから当てる
  // （docs/SEARCH-NORMALIZE.md）。
  function matches(row: ImageRow, f: ImageQuery): boolean {
    if (f.search) {
      const needle = normalizeSearchText(f.search)
      if (needle) {
        const haystack = normalizeSearchText(`${row.title ?? ''}\n${row.memo ?? ''}`)
        if (!haystack.includes(needle)) return false
      }
    }
    if (f.after != null && row.captured_at < f.after) return false
    if (f.toDate != null && row.captured_at >= f.toDate) return false
    if (f.site && state.hostById.get(row.id) !== f.site) return false
    if (f.mediaType === 'image' && row.media_type === 'video') return false
    if (f.mediaType === 'video' && row.media_type !== 'video') return false
    if (f.tags && f.tags.length > 0) {
      const names = new Set(tagsOf(row.id).map((tag) => tag.name))
      const hit = f.tags.filter((name) => names.has(name)).length
      if (f.tagMode === 'or' ? hit === 0 : hit < f.tags.length) return false
    }
    return true
  }

  function sorted(rows: ImageRow[], order: ImageListRequest['sortOrder']): ImageRow[] {
    if (order === 'random') return [...rows].sort(() => Math.random() - 0.5)
    const sign = order === 'date_asc' ? 1 : -1
    return [...rows].sort((a, b) =>
      a.captured_at === b.captured_at ? sign * (a.id - b.id) : sign * (a.captured_at - b.captured_at))
  }

  // カーソル（before / beforeId）より後ろだけを残す。listImages のページングは
  // main 側では WHERE 句で表現されているが、ここではソート後に切る方が読みやすい。
  function afterCursor(rows: ImageRow[], req: ImageListRequest): ImageRow[] {
    if (req.sortOrder === 'random' || req.before == null) return rows
    const asc = req.sortOrder === 'date_asc'
    return rows.filter((row) => {
      if (row.captured_at !== req.before) return asc ? row.captured_at > req.before! : row.captured_at < req.before!
      if (req.beforeId == null) return false
      return asc ? row.id > req.beforeId : row.id < req.beforeId
    })
  }

  function removeRows(ids: number[]): DeleteImageResult[] {
    const targets = new Set(ids)
    state.rows = state.rows.filter((row) => !targets.has(row.id))
    for (const id of targets) state.tagsById.delete(id)
    return ids.map((id) => ({ ok: true, id }) as DeleteImageResult)
  }

  function addTag(id: number, name: string, source: ImageTagSource): void {
    const tags = tagsOf(id)
    if (tags.some((tag) => tag.name === name)) return
    state.tagsById.set(id, [...tags, { name, source }])
  }

  function removeTag(id: number, name: string): void {
    state.tagsById.set(id, tagsOf(id).filter((tag) => tag.name !== name))
  }

  const api: ShioriApi & VideoApi = {
    // ── 一覧・検索 ──────────────────────────────────────────────
    listImages: async (req) => {
      const limit = req.sortOrder === 'random'
        ? MAX_TIMELINE_LIMIT
        : Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(req.limit ?? 50)))
      const hits = state.rows.filter((row) => matches(row, req))
      return afterCursor(sorted(hits, req.sortOrder ?? 'date_desc'), req).slice(0, limit)
    },
    countImages: async (query) => state.rows.filter((row) => matches(row, query)).length,
    listAllImages: async (query) =>
      sorted(state.rows.filter((row) => matches(row, query)), 'date_desc').slice(0, MAX_TIMELINE_LIMIT),
    listSites: async () => [...new Set(state.rows.map((row) => state.hostById.get(row.id)!))].filter(Boolean).sort(),
    listSiteCounts: async () => {
      const counts: Record<string, number> = {}
      for (const row of state.rows) {
        const host = state.hostById.get(row.id)
        if (host) counts[host] = (counts[host] ?? 0) + 1
      }
      return counts
    },
    listAllTags: async (includeAi = false) => {
      const acc = new Map<string, TagWithCount>()
      for (const row of state.rows) {
        for (const tag of tagsOf(row.id)) {
          if (!includeAi && tag.source !== 'manual') continue
          const found = acc.get(tag.name)
          if (found) {
            found.count += 1
            if (tag.source === 'manual') found.source = 'manual'
          } else {
            acc.set(tag.name, { name: tag.name, source: tag.source, count: 1 })
          }
        }
      }
      // db.ts と同じ並び：手動タグ優先 → 件数降順 → 名前昇順。
      return [...acc.values()].sort((a, b) =>
        (a.source === b.source ? 0 : a.source === 'manual' ? -1 : 1)
        || b.count - a.count
        || a.name.localeCompare(b.name))
    },
    listTagCounts: async () => {
      const counts: Record<string, number> = {}
      for (const row of state.rows) {
        for (const tag of tagsOf(row.id)) {
          if (tag.source !== 'manual') continue
          counts[tag.name] = (counts[tag.name] ?? 0) + 1
        }
      }
      return counts
    },
    getImage: async (id) => state.rows.find((row) => row.id === id) ?? null,

    // ── 編集 ────────────────────────────────────────────────────
    updateImageTitle: async (id, title) => {
      const row = state.rows.find((r) => r.id === id)
      if (row) row.title = title || null
    },
    updateImageMemo: async (id, memo) => {
      const row = state.rows.find((r) => r.id === id)
      if (row) row.memo = memo || null
    },
    deleteImage: async (id) => removeRows([id])[0],
    deleteImagesBulk: async (ids) => removeRows(ids),

    // ── タグ ────────────────────────────────────────────────────
    taggerAddTag: async (id, name, source = 'manual') => addTag(id, name, source),
    taggerRemoveTag: async (id, name) => removeTag(id, name),
    taggerGetTags: async (id) => tagsOf(id).map((tag) => ({ ...tag })),
    taggerGetTagsBulk: async (ids) =>
      Object.fromEntries(ids.map((id) => [id, tagsOf(id).map((tag) => ({ ...tag }))])),
    taggerAddTagBulk: async (ids, name, source = 'manual') => ids.forEach((id) => addTag(id, name, source)),
    taggerRemoveTagBulk: async (ids, name) => ids.forEach((id) => removeTag(id, name)),
    taggerRemoveTagFromAll: async (name) => {
      const hit = state.rows.filter((row) => tagsOf(row.id).some((tag) => tag.name === name))
      hit.forEach((row) => removeTag(row.id, name))
      return hit.length
    },

    // ── 設定 ────────────────────────────────────────────────────
    getSettings: async () => ({ ...state.settings }),
    setSettings: async (patch) => { state.settings = { ...state.settings, ...patch } },
    setCaptureHotkey: async (hotkey) => {
      // 登録先のグローバルホットキーがブラウザには無いので、設定値の保持だけ行う。
      state.settings = { ...state.settings, captureHotkey: hotkey }
      return true
    },
    setClipHotkey: async (hotkey) => {
      state.settings = { ...state.settings, clipHotkey: hotkey }
      return true
    },
    getStartup: async () => false,
    setStartup: async () => unsupported(),
    getAppVersion: async () => __APP_VERSION__,
    getExtensionPath: async () => t('demo.unavailable'),

    // ── ブラウザで代替できるもの ────────────────────────────────
    openUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') },

    // ── デスクトップ専用（断る） ────────────────────────────────
    exportImages: async () => { unsupported(); return { canceled: true } },
    imagesExportCancel: async () => {},
    imagesRepairThumbs: async () => { unsupported(); return { repaired: 0, failed: 0 } },
    showInFolder: async () => unsupported(),
    showExtensionFolder: async () => unsupported(),
    startImageDrag: () => unsupported(),
    updaterQuitAndInstall: async () => {},
    taggerEnsure: async () => unsupported(),
    taggerCancelDownload: async () => {},
    taggerDelete: async () => ({ removedTags: 0 }),
    taggerIsDownloaded: async () => false,
    taggerRetagAll: async () => unsupported(),
    taggerRetagCancel: async () => {},
    shareExport: async () => { unsupported(); return { canceled: true } },
    shareExportCancel: async () => {},
    shareImport: async () => { unsupported(); return { canceled: true } },
    shareImportCancel: async () => {},
    importFiles: async () => { unsupported(); return { count: 0, errors: [], truncated: false } },
    clipboardPaste: async () => { unsupported(); return { ok: false, reason: 'error' } },
    clipboardCopyImage: async () => { unsupported(); return false },
    getPathForFile: () => '',
    // 実フレーム（PTS）解析は ffmpeg 側の仕事。空配列を返すとビューアは fps 換算の
    // コマ送りへフォールバックするので、動画の再生・コマ送り自体は成立する。
    getFramePts: async () => [],
    getTimelineStrip: async () => null,
    trimVideo: async () => { unsupported(); return { ok: false, error: t('demo.unavailable') } },

    // ── push チャンネル（デモでは発火しないものは購読だけ受ける） ──
    onAppNotice: notice.on,
    onCapture: noop.on,
    onOpenSettings: noop.on,
    onWhatsNew: noop.on,
    onExtensionTimecode: noop.on,
    onExportProgress: noop.on,
    onShareImportProgress: noop.on,
    onImagesDragTruncated: noop.on,
    onTaggerDone: noop.on,
    onTaggerDownloadProgress: noop.on,
    onTaggerError: noop.on,
    onTaggerRetagProgress: noop.on,
    onTaggerRetagDone: noop.on,
    onUpdateDownloaded: noop.on,
    onFpsBackfilled: noop.on,
    onFramesVerified: noop.on,
  }

  window.api = api

  // 初回のトーストは App がマウントして onAppNotice を購読し終えてから流す。
  setTimeout(() => notice.emit({ level: 'info', message: t('demo.welcome') }), 800)
}
