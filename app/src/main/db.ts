import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type { ImageQuery, ImageListRequest, ImageRow as ImageRowBase, ImageTag } from '../shared/types'

let db: Database.Database
const MAX_LIST_LIMIT = 200
// ランダムソートはカーソルページングできず一括返却するため、グリッドでも
// ライブラリ全体からサンプリングできるよう専用の上限を設ける（タイムラインと揃える）。
const MAX_RANDOM_LIMIT = 5000

// SQL文字列をキーとしてコンパイル済みステートメントをキャッシュする。
// 固定SQLは1回だけコンパイル、動的SQLも同一パターンが再利用される。
const stmtCache = new Map<string, Database.Statement>()
function prepare(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql)
  if (!stmt) { stmt = db.prepare(sql); stmtCache.set(sql, stmt) }
  return stmt
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(limit)))
}

// LIKE のワイルドカード（% _）と '\' をリテラル扱いにする。SQL 側は ESCAPE '\' を付ける。
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

// trigram トークナイザは3文字未満だと1つもトライグラムを生成できず何もヒットしないため、
// それ未満の短い検索語は従来どおり LIKE の全件走査にフォールバックする。
const FTS_MIN_LEN = 3

// search 文字列全体を「1つの連続したフレーズ」として MATCH させる（既存の部分一致 LIKE と
// 同じ「まるごと一致」のセマンティクスに合わせるため）。FTS5 のフレーズ構文はダブルクォートの
// エスケープだけ気をつければよい。
function ftsPhraseQuery(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function addColumnIfMissing(sql: string): void {
  try {
    db.exec(sql)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/duplicate column/i.test(message)) {
      console.warn('[db] migration failed', message)
    }
  }
}

export function initDb(): void {
  stmtCache.clear()
  db = new Database(join(app.getPath('userData'), 'Shiori.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // WAL 併用時は NORMAL で十分な耐久性があり、書き込みが速くなる（キャプチャ連打時に効く）
  db.pragma('synchronous = NORMAL')
  // 読み取りキャッシュを 16MB に拡大（負値は KB 指定）。一覧スクロール・フィルタ集計が軽くなる
  db.pragma('cache_size = -16000')
  // 一時テーブル・ソートをメモリ上で処理（ORDER BY / GROUP BY が速くなる）
  db.pragma('temp_store = MEMORY')
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      filepath     TEXT    NOT NULL UNIQUE,
      captured_at  INTEGER NOT NULL,
      title        TEXT,
      current_time REAL,
      url          TEXT,
      width        INTEGER,
      height       INTEGER,
      colors       TEXT,
      memo         TEXT,
      media_type   TEXT,
      duration     REAL,
      thumb_path   TEXT
    );
    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER NOT NULL,
      tag_id   INTEGER NOT NULL,
      source   TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (image_id, tag_id),
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id)   REFERENCES tags(id)   ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_images_captured_at ON images(captured_at);
    CREATE INDEX IF NOT EXISTS idx_image_tags_image   ON image_tags(image_id);
    CREATE INDEX IF NOT EXISTS idx_image_tags_tag     ON image_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_image_tags_source  ON image_tags(source);
  `)
  addColumnIfMissing('ALTER TABLE images ADD COLUMN url TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN colors TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN memo TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN media_type TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN duration REAL')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN thumb_path TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN host TEXT')
  addColumnIfMissing("ALTER TABLE images ADD COLUMN source TEXT NOT NULL DEFAULT 'capture'")
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_host ON images(host)')
  // カーソルページング・ホスト絞り込み・エクスポートで使う複合インデックス
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_cat       ON images(captured_at, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_host_cat  ON images(host, captured_at, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_src_cat   ON images(source, captured_at)')
  // タグ絞り込みで source + tag_id を同時に参照するケース向け
  db.exec('CREATE INDEX IF NOT EXISTS idx_image_tags_src_tag ON image_tags(source, tag_id)')

  // title/memo 検索用の FTS5 仮想テーブル（外部コンテンツ = images）。ライブラリが数万件規模に
  // なっても LIKE '%...%' のような毎回フルスキャンにならないよう、検索専用のインデックスを持つ。
  // トークナイザは trigram を使う：unicode61 だと分かち書きされない日本語がまるごと1トークンに
  // なり部分一致検索が壊れるため、文字3-gram単位でインデックスする trigram の方が、日本語混じりの
  // タイトル/メモに対しても従来の LIKE 部分一致に近い挙動を保てる。
  const ftsExisted = !!prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images_fts'").get()
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
      title, memo, content='images', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS images_fts_ai AFTER INSERT ON images BEGIN
      INSERT INTO images_fts(rowid, title, memo) VALUES (new.id, new.title, new.memo);
    END;
    CREATE TRIGGER IF NOT EXISTS images_fts_ad AFTER DELETE ON images BEGIN
      INSERT INTO images_fts(images_fts, rowid, title, memo) VALUES('delete', old.id, old.title, old.memo);
    END;
    CREATE TRIGGER IF NOT EXISTS images_fts_au AFTER UPDATE ON images BEGIN
      INSERT INTO images_fts(images_fts, rowid, title, memo) VALUES('delete', old.id, old.title, old.memo);
      INSERT INTO images_fts(rowid, title, memo) VALUES (new.id, new.title, new.memo);
    END;
  `)
  // 新規作成時（＝既存ユーザーのアップグレード直後）だけ既存行を一括で流し込む。
  if (!ftsExisted) {
    db.exec('INSERT INTO images_fts(rowid, title, memo) SELECT id, title, memo FROM images')
  }

  // 既存レコードの host を backfill（初回のみ実行される）
  const rows = prepare("SELECT id, url FROM images WHERE host IS NULL AND url IS NOT NULL").all() as { id: number; url: string }[]
  const setHost = prepare('UPDATE images SET host = ? WHERE id = ?')
  const backfill = db.transaction(() => {
    for (const { id, url } of rows) {
      // URL 不正時は host='' で「処理済み・ホストなし」を記録し、毎起動の再スキャンを防ぐ
      try { setHost.run(new URL(url).hostname.replace(/^www\./, ''), id) } catch { setHost.run('', id) }
    }
  })
  backfill()
}

// DB の images 行。レンダラー公開用の ImageRow（shared/types.ts）を単一の情報源とし、
// それにレンダラーへは渡さない DB 専用カラム（width/height/host）を足したもの。
// 共有契約に列を足すとここにも自動で反映され、両者がズレない。
export type ImageRow = ImageRowBase & {
  width: number | null
  height: number | null
  host: string | null
}

type RawImageRowBase = Omit<ImageRowBase, 'current_time'> & { current_time: unknown }
type RawImageRow = Omit<ImageRow, 'current_time'> & { current_time: unknown }

function normalizeCurrentTime(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  return null
}

function normalizeImageRow<T extends RawImageRowBase>(row: T): Omit<T, 'current_time'> & { current_time: number | null } {
  return { ...row, current_time: normalizeCurrentTime(row.current_time) }
}

const PUBLIC_IMAGE_COLUMNS = [
  '"id"',
  '"filepath"',
  '"captured_at"',
  '"title"',
  '"current_time"',
  '"url"',
  '"colors"',
  '"memo"',
  '"media_type"',
  '"duration"',
  '"thumb_path"',
  '"source"'
].join(', ')

// listColors の結果キャッシュ。insertImage / deleteImage で無効化する
let _colorsCache: string[] | null = null

export function insertImage(params: Omit<ImageRow, 'id' | 'host' | 'source'> & { source?: 'capture' | 'import' }): number {
  let host: string | null = null
  try { if (params.url) host = new URL(params.url).hostname.replace(/^www\./, '') } catch { /* ignore */ }
  const source = params.source ?? 'capture'
  const stmt = prepare(
    `INSERT INTO images (filepath, captured_at, title, current_time, url, width, height, colors, memo, media_type, duration, thumb_path, host, source)
     VALUES (@filepath, @captured_at, @title, @current_time, @url, @width, @height, @colors, @memo, @media_type, @duration, @thumb_path, @host, @source)`
  )
  const result = stmt.run({ ...params, current_time: normalizeCurrentTime(params.current_time), host, source })
  _colorsCache = null
  return Number(result.lastInsertRowid)
}

// ImageQuery（共有のフィルタ契約）に、カーソルページング用の before/beforeId と
// 並び順を足したものが WHERE 句ビルダーの入力。
export type ImageFilter = ImageQuery & {
  before?: number
  beforeId?: number
  sortOrder?: 'date_desc' | 'date_asc' | 'random'
}

// listImages / countImages で共有する WHERE 句ビルダー。
// before（カーソル）は一覧のページングでのみ使い、件数集計では渡さない。
export function buildImageFilter(f: ImageFilter): { where: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []
  if (f.search) {
    if (f.search.length >= FTS_MIN_LEN) {
      conds.push('id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)')
      params.push(ftsPhraseQuery(f.search))
    } else {
      const s = `%${escapeLike(f.search)}%`
      conds.push("(title LIKE ? ESCAPE '\\' OR memo LIKE ? ESCAPE '\\')")
      params.push(s, s)
    }
  }
  if (f.after != null) { conds.push('captured_at >= ?'); params.push(f.after) }
  if (f.sortOrder !== 'random') {
    if (f.before != null && f.beforeId != null) {
      if (f.sortOrder === 'date_asc') {
        conds.push('(captured_at > ? OR (captured_at = ? AND id > ?))')
      } else {
        conds.push('(captured_at < ? OR (captured_at = ? AND id < ?))')
      }
      params.push(f.before, f.before, f.beforeId)
    } else if (f.before != null) {
      conds.push(f.sortOrder === 'date_asc' ? 'captured_at > ?' : 'captured_at < ?')
      params.push(f.before)
    }
  }
  if (f.toDate != null) { conds.push('captured_at < ?'); params.push(f.toDate) }
  if (f.site) { conds.push("host LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(f.site)}%`) }
  if (f.mediaType) { conds.push('media_type = ?'); params.push(f.mediaType) }
  if (f.tags && f.tags.length > 0) {
    const ph = f.tags.map(() => '?').join(', ')
    if (f.tagMode === 'or') {
      conds.push(`id IN (SELECT DISTINCT image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name IN (${ph}))`)
      params.push(...f.tags)
    } else {
      conds.push(`id IN (SELECT image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name IN (${ph}) GROUP BY image_id HAVING COUNT(DISTINCT t.name) = ?)`)
      params.push(...f.tags, f.tags.length)
    }
  }
  if (f.color) { conds.push("colors LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(f.color)}%`) }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params }
}

export function listImages(req: ImageListRequest = {}): ImageRowBase[] {
  const { limit = 50, before, beforeId, sortOrder = 'date_desc', ...query } = req
  const { where, params } = buildImageFilter({ ...query, before, beforeId, sortOrder })
  const order = sortOrder === 'random' ? 'RANDOM()' : sortOrder === 'date_asc' ? 'captured_at ASC, id ASC' : 'captured_at DESC, id DESC'
  const resolvedLimit = sortOrder === 'random' ? MAX_RANDOM_LIMIT : clampLimit(limit)
  params.push(resolvedLimit)
  return (prepare(`SELECT ${PUBLIC_IMAGE_COLUMNS} FROM images ${where} ORDER BY ${order} LIMIT ?`).all(...params) as RawImageRowBase[])
    .map(normalizeImageRow) as ImageRowBase[]
}

// タイムライン表示用：カーソルページングなしでフィルタ一致を一括取得する。
// 件数が膨大なライブラリでも描画が破綻しないよう上限でキャップする（クライアント側で作品別グルーピング）。
const MAX_TIMELINE_LIMIT = 5000
export function listImagesAll(query: ImageQuery = {}): ImageRowBase[] {
  const { where, params } = buildImageFilter(query)
  params.push(MAX_TIMELINE_LIMIT)
  return (prepare(`SELECT ${PUBLIC_IMAGE_COLUMNS} FROM images ${where} ORDER BY captured_at DESC, id DESC LIMIT ?`).all(...params) as RawImageRowBase[])
    .map(normalizeImageRow) as ImageRowBase[]
}

export function countImages(query: ImageQuery = {}): number {
  const { where, params } = buildImageFilter(query)
  const result = prepare(`SELECT COUNT(*) as cnt FROM images ${where}`).get(...params) as { cnt: number }
  return result.cnt
}

export function colorDist(h1: string, h2: string): number {
  const r1 = parseInt(h1.slice(1, 3), 16), g1 = parseInt(h1.slice(3, 5), 16), b1 = parseInt(h1.slice(5, 7), 16)
  const r2 = parseInt(h2.slice(1, 3), 16), g2 = parseInt(h2.slice(3, 5), 16), b2 = parseInt(h2.slice(5, 7), 16)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

export function listColors(limit = 20): string[] {
  const cappedLimit = clampLimit(limit)
  if (_colorsCache !== null) return _colorsCache.slice(0, cappedLimit)
  const rows = prepare('SELECT colors FROM images WHERE colors IS NOT NULL').all() as { colors: string }[]
  const freq = new Map<string, number>()
  for (const { colors } of rows) {
    for (const c of colors.split(',')) {
      const t = c.trim()
      if (t) freq.set(t, (freq.get(t) ?? 0) + 1)
    }
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const result: string[] = []
  for (const [hex] of sorted) {
    if (result.length >= MAX_LIST_LIMIT) break
    if (!result.some(c => colorDist(hex, c) < 60)) result.push(hex)
  }
  _colorsCache = result
  return result.slice(0, cappedLimit)
}

export function listSites(): string[] {
  return (prepare("SELECT DISTINCT host FROM images WHERE host IS NOT NULL AND host != '' ORDER BY host").all() as { host: string }[]).map((r) => r.host)
}

export function listSiteCounts(): Record<string, number> {
  const rows = prepare(
    "SELECT host, COUNT(*) as count FROM images WHERE host IS NOT NULL AND host != '' GROUP BY host"
  ).all() as { host: string; count: number }[]
  return Object.fromEntries(rows.map((r) => [r.host, r.count]))
}

export function getImage(id: number): ImageRowBase | null {
  const row = prepare(`SELECT ${PUBLIC_IMAGE_COLUMNS} FROM images WHERE id = ?`).get(id) as RawImageRowBase | undefined
  return row ? normalizeImageRow(row) as ImageRowBase : null
}

export function deleteImage(id: number): string | null {
  return db.transaction(() => {
    const row = prepare('SELECT filepath FROM images WHERE id = ?').get(id) as { filepath: string } | undefined
    if (!row) return null
    prepare('DELETE FROM image_tags WHERE image_id = ?').run(id)
    prepare('DELETE FROM images WHERE id = ?').run(id)
    _colorsCache = null
    return row.filepath
  })()
}

export function addTag(imageId: number, tagName: string, source: 'manual' | 'ai' = 'manual'): void {
  prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName)
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number }
  prepare(
    'INSERT OR IGNORE INTO image_tags (image_id, tag_id, source) VALUES (?, ?, ?)'
  ).run(imageId, tag.id, source)
}

export function addTagsBulk(imageId: number, tags: { name: string; source: 'manual' | 'ai' }[]): void {
  if (tags.length === 0) return
  const insertTag = prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
  const getTag    = prepare('SELECT id FROM tags WHERE name = ?')
  const insertIt  = prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, source) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const { name, source } of tags) {
      insertTag.run(name)
      const tag = getTag.get(name) as { id: number }
      insertIt.run(imageId, tag.id, source)
    }
  })()
}

// shared/types.ts の ImageTag を単一の情報源として再エクスポート（旧来の重複定義を撤去）。
export type { ImageTag }

export function getImageTags(imageId: number): ImageTag[] {
  return prepare(
    'SELECT t.name, it.source FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ?'
  ).all(imageId) as ImageTag[]
}

export function getImageTagsBulk(imageIds: number[]): Record<number, ImageTag[]> {
  const result: Record<number, ImageTag[]> = {}
  if (imageIds.length === 0) return result
  for (const id of imageIds) result[id] = []
  // ID ごとに SELECT すると複数選択のタグパネル・QuickTag を開くたびに最大 MAX_BULK_IDS 回
  // クエリが走っていた。IN 句 1 クエリにまとめて往復を減らす（呼び出し元で ID 数は上限済み）。
  const ph = imageIds.map(() => '?').join(', ')
  const rows = prepare(
    `SELECT it.image_id as imageId, t.name, it.source FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id IN (${ph})`
  ).all(...imageIds) as (ImageTag & { imageId: number })[]
  for (const { imageId, name, source } of rows) result[imageId].push({ name, source })
  return result
}

export function addTagBulk(imageIds: number[], tagName: string, source: 'manual' | 'ai' = 'manual'): void {
  if (imageIds.length === 0) return
  prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName)
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number }
  const insertIt = prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, source) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const id of imageIds) insertIt.run(id, tag.id, source)
  })()
}

export function removeTagBulk(imageIds: number[], tagName: string): void {
  if (imageIds.length === 0) return
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number } | undefined
  if (!tag) return
  const del = prepare('DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?')
  db.transaction(() => {
    for (const id of imageIds) del.run(id, tag.id)
  })()
}

// AIタグ付けモデル削除時に、AI由来のタグ（source='ai'）をライブラリ全体から一括削除する。
// 手動タグ（source='manual'）は対象外。Undo不可のため呼び出し元で確認を取ってから呼ぶこと。
export function deleteAllAiTags(): number {
  return prepare("DELETE FROM image_tags WHERE source = 'ai'").run().changes
}

export function listAllTags(): string[] {
  return (prepare(
    'SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.source = \'manual\' GROUP BY t.id ORDER BY COUNT(*) DESC, t.name'
  ).all() as { name: string }[]).map((r) => r.name)
}

export function listTagCounts(): Record<string, number> {
  const rows = prepare(
    'SELECT t.name, COUNT(*) as count FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.source = \'manual\' GROUP BY t.id'
  ).all() as { name: string; count: number }[]
  return Object.fromEntries(rows.map((r) => [r.name, r.count]))
}

export function updateImageTitle(id: number, title: string): void {
  prepare('UPDATE images SET title = ? WHERE id = ?').run(title || null, id)
}

export function removeImageTag(imageId: number, tagName: string): void {
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number } | undefined
  if (!tag) return
  prepare('DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?').run(imageId, tag.id)
}

export function updateImageMemo(id: number, memo: string): void {
  prepare('UPDATE images SET memo = ? WHERE id = ?').run(memo || null, id)
}

export function listImagesForThumbCheck(): { id: number; filepath: string; thumb_path: string | null; media_type: string | null }[] {
  return prepare(
    `SELECT id, filepath, thumb_path, media_type FROM images
     ORDER BY captured_at DESC`
  ).all() as { id: number; filepath: string; thumb_path: string | null; media_type: string | null }[]
}

export function setThumbPath(id: number, thumbPath: string): void {
  prepare('UPDATE images SET thumb_path = ? WHERE id = ?').run(thumbPath, id)
}

export function listImagesWithThumb(): { id: number; thumb_path: string }[] {
  return prepare(
    "SELECT id, thumb_path FROM images WHERE thumb_path IS NOT NULL AND thumb_path != ''"
  ).all() as { id: number; thumb_path: string }[]
}

export function listImagesForRetag(): { id: number; filepath: string; thumb_path: string | null }[] {
  return prepare(
    `SELECT id, filepath, thumb_path FROM images
     WHERE id NOT IN (SELECT DISTINCT image_id FROM image_tags WHERE source = 'ai')
     ORDER BY captured_at DESC`
  ).all() as { id: number; filepath: string; thumb_path: string | null }[]
}

export type ExportRow = ImageRow & { manualTags: string[] }

export function listImagesForExport(): ExportRow[] {
  const images = (prepare("SELECT * FROM images WHERE source = 'capture' ORDER BY captured_at ASC").all() as RawImageRow[])
    .map(normalizeImageRow) as ImageRow[]
  if (images.length === 0) return []
  const tagRows = prepare(
    `SELECT it.image_id, t.name FROM image_tags it
     JOIN tags t ON t.id = it.tag_id
     JOIN images i ON i.id = it.image_id
     WHERE it.source = 'manual' AND i.source = 'capture'`
  ).all() as { image_id: number; name: string }[]
  const tagsByImageId = new Map<number, string[]>()
  for (const { image_id, name } of tagRows) {
    const arr = tagsByImageId.get(image_id) ?? []
    arr.push(name)
    tagsByImageId.set(image_id, arr)
  }
  return images.map((img) => ({ ...img, manualTags: tagsByImageId.get(img.id) ?? [] }))
}
