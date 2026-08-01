import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type { ImageQuery, ImageListRequest, ImageRow as ImageRowBase, ImageTag, TagWithCount } from '../shared/types'

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
    // 列が既に存在する（＝このマイグレーションは実行済み）以外のエラーは、ディスクフル・
    // 破損等で ALTER が本当に失敗したことを意味する。ここを warn で握りつぶすと、
    // 一部の列が欠けた半端なスキーマのまま起動が続行し、後続クエリが不可解に壊れる。
    // throw して initDb 呼び出し元（bootstrap.ts）の起動失敗ダイアログに乗せる（N-2）。
    if (!/duplicate column/i.test(message)) throw err
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
      thumb_path   TEXT,
      media_type   TEXT,
      duration     REAL
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
    -- 録画クリップのフレーム表。素材の1コマごとに「素材上の時刻」と「ファイル内の
    -- 何枚目に写っているか」を持つ。コマ送りを素材の実コマへ揃えるための土台。
    --
    -- images に持たせず別テーブルにするのは、1クリップで数百〜千数百要素の JSON になり、
    -- グリッド一覧のような images を舐めるクエリを不必要に重くするため。
    -- image_id を主キーにすることで 1 クリップ 1 行を保証する。
    CREATE TABLE IF NOT EXISTS video_frames (
      image_id INTEGER PRIMARY KEY,
      data     TEXT NOT NULL,
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_images_captured_at ON images(captured_at);
    CREATE INDEX IF NOT EXISTS idx_image_tags_image   ON image_tags(image_id);
    CREATE INDEX IF NOT EXISTS idx_image_tags_tag     ON image_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_image_tags_source  ON image_tags(source);
  `)
  addColumnIfMissing('ALTER TABLE images ADD COLUMN url TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN colors TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN memo TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN thumb_path TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN media_type TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN duration REAL')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN fps REAL')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN host TEXT')
  addColumnIfMissing("ALTER TABLE images ADD COLUMN source TEXT NOT NULL DEFAULT 'capture'")
  // 素材のコマのうち、自分の表示区間内に絵を撮れなかった枚数。
  // 画面キャプチャの供給が素材の2倍に届かないと発生し、絵の変わり目に当たると
  // コマ打ちの数を誤る。研究用途では黙って間違えるのが最悪なので数として保持し、
  // 詳細パネルに出す。NULL はコマ精度の情報が無いクリップ（従来のもの・非対応サイト）。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN uncaptured_frames INTEGER')
  // 上記のうち「前後で絵が変わっており、どのコマで変わったか特定できない」枚数。
  // 撮り逃したコマの大半は同じ絵が続く区間に当たっており実害が無い。それを区別せず
  // 全部を「未取得」と出すと、本当に数え直しが要る数コマが埋もれる。
  // NULL は「まだ検証していない」（保存直後・検証に失敗したクリップ・従来の行）。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN ambiguous_frames INTEGER')
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
  `)
  // title/memo に限らず全ての UPDATE（サムネ backfill・host backfill 等）で発火する旧トリガーが
  // 既存 DB に残っている可能性があるため、毎回 DROP してから title/memo 限定版で作り直す（N-1）。
  // 冪等なので何度実行しても害はない。
  db.exec(`
    DROP TRIGGER IF EXISTS images_fts_au;
    CREATE TRIGGER images_fts_au AFTER UPDATE OF title, memo ON images BEGIN
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
  '"fps"',
  '"uncaptured_frames"',
  '"ambiguous_frames"',
  '"thumb_path"',
  '"source"'
].join(', ')

export function insertImage(params: Omit<ImageRow, 'id' | 'host' | 'source'> & { source?: 'capture' | 'import' }): number {
  let host: string | null = null
  try { if (params.url) host = new URL(params.url).hostname.replace(/^www\./, '') } catch { /* ignore */ }
  const source = params.source ?? 'capture'
  const stmt = prepare(
    `INSERT INTO images (filepath, captured_at, title, current_time, url, width, height, colors, memo, media_type, duration, fps, thumb_path, host, source)
     VALUES (@filepath, @captured_at, @title, @current_time, @url, @width, @height, @colors, @memo, @media_type, @duration, @fps, @thumb_path, @host, @source)`
  )
  const result = stmt.run({ ...params, current_time: normalizeCurrentTime(params.current_time), host, source })
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
  // renderer 側（Toolbar の site: チップ）は「実在ホストと完全一致」のときだけ絞り込み中
  // として表示するため、クエリも完全一致に揃える。部分一致だと入力途中の断片（例:
  // "site:a"）が複数ホスト（abema.tv・amazon.co.jp 等）に同時ヒットし、チップは
  // 出ないのに結果だけ絞り込まれる中途半端な状態になっていた（BUG-6）。
  if (f.site) { conds.push('host = ?'); params.push(f.site) }
  if (f.mediaType) {
    if (f.mediaType === 'image') {
      conds.push("(media_type IS NULL OR media_type = 'image')")
    } else {
      conds.push('media_type = ?')
      params.push(f.mediaType)
    }
  }
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

// どの画像にも付かなくなった tags 行を落とす。image_tags は画像削除で消えるが tags 自体は
// 残るため（deleteAllAiTags のコメントと同じ理由）、放置すると削除を繰り返すたびに tags
// テーブルだけが肥大化する。画像削除の直後に同じトランザクション内で呼ぶ。
function pruneOrphanTags(): void {
  prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM image_tags)').run()
}

export function deleteImage(id: number): string | null {
  return db.transaction(() => {
    const row = prepare('SELECT filepath FROM images WHERE id = ?').get(id) as { filepath: string } | undefined
    if (!row) return null
    prepare('DELETE FROM image_tags WHERE image_id = ?').run(id)
    prepare('DELETE FROM images WHERE id = ?').run(id)
    pruneOrphanTags()
    return row.filepath
  })()
}

// 一括削除の DB 側を 1 トランザクションにまとめる（B-7）。1枚ずつ IPC 往復していた旧経路は
// 数千枚だと分単位になっていた。実ファイル削除は非トランザクショナルな後始末として
// 呼び出し元（ipc-images.ts）が逐次ベストエフォートで行う。
export function deleteImagesBulk(ids: number[]): void {
  if (ids.length === 0) return
  const delTags = prepare('DELETE FROM image_tags WHERE image_id = ?')
  const delImg = prepare('DELETE FROM images WHERE id = ?')
  db.transaction(() => {
    for (const id of ids) {
      delTags.run(id)
      delImg.run(id)
    }
    // 孤児タグの掃除はループ内ではなく最後に1回だけ（件数に比例して重くならないように）。
    pruneOrphanTags()
  })()
}

// 既存タグとの衝突時、手動追加(excluded.source='manual')なら source を 'manual' に昇格させ、
// AI追加は既存行（手動で確定済みかもしれない）を降格させない。これがないと、AIが既に付けた
// タグをユーザーが手動追加しても 'ai' のまま残り、manual のみを見るタグ一覧/件数に出てこない。
const UPSERT_IMAGE_TAG =
  "INSERT INTO image_tags (image_id, tag_id, source) VALUES (?, ?, ?) " +
  "ON CONFLICT(image_id, tag_id) DO UPDATE SET source='manual' WHERE excluded.source='manual'"

export function addTag(imageId: number, tagName: string, source: 'manual' | 'ai' = 'manual'): void {
  prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName)
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number }
  prepare(UPSERT_IMAGE_TAG).run(imageId, tag.id, source)
}

export function addTagsBulk(imageId: number, tags: { name: string; source: 'manual' | 'ai' }[]): void {
  if (tags.length === 0) return
  const insertTag = prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
  const getTag    = prepare('SELECT id FROM tags WHERE name = ?')
  const insertIt  = prepare(UPSERT_IMAGE_TAG)
  const imageExists = prepare('SELECT 1 FROM images WHERE id = ?')
  db.transaction(() => {
    // 画像が（非同期の自動タグ付け完了前などに）削除済みなら、存在しない image_id への
    // insert（FK違反）を避けて静かに何もしない。存在確認と insert を同一 transaction に
    // 収めることで、呼び出し側の事前チェックに依存せず race をDB層で閉じる。
    if (!imageExists.get(imageId)) return
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
  const insertIt = prepare(UPSERT_IMAGE_TAG)
  const imageExists = prepare('SELECT 1 FROM images WHERE id = ?')
  db.transaction(() => {
    // addTagsBulk と同じ理由: 選択中に画像が削除済み（Undo 猶予明けのコミットと競合等）だと
    // FK 違反で transaction 全体がロールバックし、有効な画像への付与まで巻き添えで失敗する。
    // 存在しない id はスキップして続行する。
    for (const id of imageIds) {
      if (!imageExists.get(id)) continue
      insertIt.run(id, tag.id, source)
    }
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
// 削除後にどの image_tags からも参照されなくなった tags 行（孤児）も併せて掃除する。
// image_tags は CASCADE で消えても tags 自体は残る仕様のため、ここで放置すると
// AIタグ削除を繰り返すたびに tags テーブルが肥大化する。
export function deleteAllAiTags(): number {
  return db.transaction(() => {
    const changes = prepare("DELETE FROM image_tags WHERE source = 'ai'").run().changes
    prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM image_tags)').run()
    return changes
  })()
}

// タグ名から該当する image_tags 行を全件削除する（対象画像を listImagesAll 等で列挙してから
// removeTagBulk する経路だと MAX_TIMELINE_LIMIT で切り詰められてしまうため、SQL 側で
// tag_id 一致だけで直接消す。件数上限なし）。戻り値は削除件数（画像から見た「消えた枚数」）。
export function removeTagFromAllImages(tagName: string): number {
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number } | undefined
  if (!tag) return 0
  // 対象タグが誰からも参照されなくなったら tags 行自体も消す（孤児防止。deleteAllAiTags と同じ理由）。
  return db.transaction(() => {
    const changes = prepare('DELETE FROM image_tags WHERE tag_id = ?').run(tag.id).changes
    prepare('DELETE FROM tags WHERE id = ? AND id NOT IN (SELECT DISTINCT tag_id FROM image_tags)').run(tag.id)
    return changes
  })()
}

// includeAi=false（既定）: 手動タグのみ、件数の多い順。
// includeAi=true: 手動タグを常に上位ブロックとし（人間のタグを優先）、その後にAI専用タグを
// 件数順で続ける。同じタグ名で手動画像とAI画像が混在していても、手動が1件でもあれば
// 「手動タグブロック」に属する扱いにする（MAX(...)で判定）。source も同じ「手動が1件でもあれば
// manual」ルールで畳んで返し、サイドバー等の集約表示で手動/AIを色分けできるようにする。
export function listAllTags(includeAi = false): TagWithCount[] {
  if (!includeAi) {
    return (prepare(
      'SELECT t.name, COUNT(*) AS cnt FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.source = \'manual\' GROUP BY t.id ORDER BY COUNT(*) DESC, t.name'
    ).all() as { name: string; cnt: number }[]).map((r) => ({ name: r.name, source: 'manual' as const, count: r.cnt }))
  }
  return (prepare(
    `SELECT t.name, COUNT(*) AS cnt, MAX(CASE WHEN it.source = 'manual' THEN 1 ELSE 0 END) AS hasManual
     FROM tags t JOIN image_tags it ON it.tag_id = t.id
     GROUP BY t.id
     ORDER BY hasManual DESC, COUNT(*) DESC, t.name`
  ).all() as { name: string; cnt: number; hasManual: number }[]).map((r) => ({
    name: r.name,
    source: r.hasManual ? 'manual' as const : 'ai' as const,
    count: r.cnt
  }))
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

// 起動時の補完用（S4-2）。サムネ未生成の行だけを返す。全件返して 1 枚ずつ実ファイルの
// 有無を確認すると、数万枚のライブラリでは起動のたびに同数のディスクアクセスが発生するため、
// 通常起動では DB だけで判定できるこの条件に絞る。記録済みサムネの実在確認は
// listImagesForThumbCheck()（手動修復）の担当。
export function listImagesMissingThumb(): { id: number; filepath: string; media_type: 'image' | 'video' | null }[] {
  return prepare(
    `SELECT id, filepath, media_type FROM images
     WHERE thumb_path IS NULL
     ORDER BY captured_at DESC`
  ).all() as { id: number; filepath: string; media_type: 'image' | 'video' | null }[]
}

// 手動修復用。thumb_path が記録済みでも実ファイルが消えている場合を拾うため全件返す。
export function listImagesForThumbCheck(): { id: number; filepath: string; thumb_path: string | null; media_type: 'image' | 'video' | null }[] {
  return prepare(
    `SELECT id, filepath, thumb_path, media_type FROM images
     ORDER BY captured_at DESC`
  ).all() as { id: number; filepath: string; thumb_path: string | null; media_type: 'image' | 'video' | null }[]
}

export function setThumbPath(id: number, thumbPath: string): void {
  prepare('UPDATE images SET thumb_path = ? WHERE id = ?').run(thumbPath, id)
}

// fps 未計測の動画（この機能を追加する前に録画・取り込み済みだった行、または録画時の
// フレーム数検証に失敗した行）を起動時バックフィルの対象にする（backfillFps、ipc-images.ts）。
export function listImagesMissingFps(): { id: number; filepath: string; duration: number | null }[] {
  return prepare(
    `SELECT id, filepath, duration FROM images
     WHERE media_type = 'video' AND fps IS NULL
     ORDER BY captured_at DESC`
  ).all() as { id: number; filepath: string; duration: number | null }[]
}

export function setUncapturedFrames(id: number, count: number): void {
  prepare('UPDATE images SET uncaptured_frames = ? WHERE id = ?').run(count, id)
}

// 検証で「絵が変わっていて特定できない」と分かったコマ数。検証を通していないクリップと
// 「検証したが0コマだった」クリップを区別する必要があるため、0 も明示的に書く。
export function setAmbiguousFrames(id: number, count: number): void {
  prepare('UPDATE images SET ambiguous_frames = ? WHERE id = ?').run(count, id)
}

export function setFps(id: number, fps: number): void {
  prepare('UPDATE images SET fps = ? WHERE id = ?').run(fps, id)
}

// 孤立ファイル掃除用（sweep-orphans.ts）。DB が参照している実ファイルの一覧。
// パス列だけを引き、id や captured_at は載せない（数万件で無駄に重くしないため）。
export function listReferencedPaths(): { filepath: string; thumb_path: string | null }[] {
  return prepare('SELECT filepath, thumb_path FROM images').all() as
    { filepath: string; thumb_path: string | null }[]
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

// --- 録画クリップのフレーム表 ---
//
// 素材の1コマごとに「素材上の時刻」と「ファイル内の何枚目に写っているか」を持つ。
// これがあるとコマ送りを素材の実コマ単位で動かせる（無い場合はファイルのフレームを
// そのまま辿るため、素材のコマとは対応しない）。
//
// captured=false は「そのコマ専用の絵が無く、直前のコマの絵を流用している」印。
// 画面キャプチャの供給が素材のコマ数の2倍に届かないと発生する。24fps 素材では供給が足りる
// ようになった（recorder.ts の startCaptureTicker、実測 100%）が、30/60fps 素材や高負荷時は
// 依然足りない。絵の変わり目に当たるとコマ打ちの数を誤るため、黙って潰さず印として残す。
//
// verified は撮り逃したコマ（captured=false）を録画後に検証した結果（frame-verify.ts）。
//   'unknown' … 未検証（保存直後・検証失敗・従来の行）
//   'same'    … 前後のキャプチャで絵が変わっていない。流用は正しく、実害が無いと確定
//   'changed' … 前後で絵が変わっている。どのコマで変わったかは特定できない＝要確認
// captured=true のコマでは意味を持たない（常に 'unknown'）。
export type FrameVerify = 'unknown' | 'same' | 'changed'

export interface StoredFrame {
  mediaTime: number
  frameIndex: number
  captured: boolean
  verified?: FrameVerify
}

// 直列化時のコード。文字列をそのまま並べると1クリップ千数百要素ぶん嵩む。
const VERIFY_CODE: Record<FrameVerify, number> = { unknown: 0, same: 1, changed: 2 }
const VERIFY_NAME: FrameVerify[] = ['unknown', 'same', 'changed']

// 直列化は DB アクセスから切り離した純粋関数にする。better-sqlite3 は Electron の ABI で
// ビルドされ素の Node からは読めないため、実 DB を張るテストが書けない。壊れると
// コマ送りが静かに従来動作へ落ちる箇所なので、ここだけでも検証できる形にしておく。
//
// 配列の配列で持つ。1クリップで千数百要素になるため、キー名を繰り返さない。
// 4 要素目（検証結果）は後から足したもの。3 要素しか無い古い行も読めるようにしてあるため
// （decodeFrames の length チェックは >= 3 のまま）、既存のクリップは未検証として扱われる。
export function encodeFrames(frames: StoredFrame[]): string {
  return JSON.stringify(frames.map((f) => [f.mediaTime, f.frameIndex, f.captured ? 1 : 0, VERIFY_CODE[f.verified ?? 'unknown']]))
}

// 壊れた行・想定外の形は null（＝表が無い）として扱い、従来のフレーム走査へ退避させる。
// 半端に解釈してコマ送りが不可解に狂うより、精度を諦めて動く方がよい。
export function decodeFrames(data: string): StoredFrame[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const out: StoredFrame[] = []
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length < 3) return null
    const [mediaTime, frameIndex, captured] = item
    if (typeof mediaTime !== 'number' || !Number.isFinite(mediaTime)) return null
    if (!Number.isInteger(frameIndex) || frameIndex < 0) return null
    // 検証結果は補助情報なので、見慣れないコードが入っていても表ごと捨てはしない
    // （コマ送りの土台である mediaTime/frameIndex まで巻き添えで失う方が損失が大きい）。
    // 未検証として扱えば、表示は「検証していない」に落ちるだけで嘘にはならない。
    const verified = item.length >= 4 ? VERIFY_NAME[item[3] as number] ?? 'unknown' : 'unknown'
    out.push({ mediaTime, frameIndex, captured: captured === 1, verified })
  }
  return out
}

export function saveVideoFrames(imageId: number, frames: StoredFrame[]): void {
  if (frames.length === 0) return
  prepare('INSERT OR REPLACE INTO video_frames (image_id, data) VALUES (?, ?)').run(imageId, encodeFrames(frames))
}

export function getVideoFrames(imageId: number): StoredFrame[] | null {
  const row = prepare('SELECT data FROM video_frames WHERE image_id = ?').get(imageId) as { data: string } | undefined
  if (!row) return null
  const frames = decodeFrames(row.data)
  if (!frames) console.warn('[db] video_frames row is unusable, falling back to raw frame order', { imageId })
  return frames
}
