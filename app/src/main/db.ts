// 画像行の読み書き（images）と、そこにぶら下がるタイムシート。
// スキーマと起動処理は db-schema.ts、タグは db-tags.ts、フレーム表は db-video-frames.ts。
import type { ImageQuery, ImageListRequest, ImageRow as ImageRowBase } from '../shared/types'
import { buildSearchText, normalizeSearchText } from '../shared/normalize'
import { getDb, prepare } from './db-core'
import { pruneOrphanTags } from './db-tags'

const MAX_LIST_LIMIT = 200
// ランダムソートはカーソルページングできず一括返却するため、グリッドでも
// ライブラリ全体からサンプリングできるよう専用の上限を設ける（タイムラインと揃える）。
const MAX_RANDOM_LIMIT = 5000

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

// 1語を「連続したフレーズ」として MATCH させる（部分一致 LIKE と同じ「まるごと一致」の
// セマンティクスに合わせるため）。FTS5 のフレーズ構文はダブルクォートのエスケープだけ
// 気をつければよい。
function ftsPhraseQuery(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

// 検索語を空白で区切り、**すべて含む**行を引く（AND）。
//
// **区切りは正規化の前に取る。** normalizeSearchText は空白を落とすので、後から分けようが
// ない。分けずに 1 フレーズのまま当てていた頃は、打った語順どおりに並んでいる行しか
// 引けなかった（`指揮官 春野` で `春野…指揮官` のタイトルが出ない）。配信のタイトルは
// 作品名・話数・配信元が任意の順で並ぶので、語順を要求する方が実態に合っていない。
//
// 1 語だけのときの結果は従来と同じ（フレーズ 1 つの AND）。
const MAX_SEARCH_TERMS = 8
export function searchTerms(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((term) => normalizeSearchText(term))
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS)
}

// DB の images 行。レンダラー公開用の ImageRow（shared/types.ts）を単一の情報源とし、
// それにレンダラーへは渡さない DB 専用カラム（host）を足したもの。
// 共有契約に列を足すとここにも自動で反映され、両者がズレない。
export type ImageRow = ImageRowBase & {
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
  '"original_captured_at"',
  '"title"',
  '"current_time"',
  '"url"',
  '"colors"',
  '"memo"',
  '"media_type"',
  '"duration"',
  '"fps"',
  '"width"',
  '"height"',
  '"uncaptured_frames"',
  '"ambiguous_frames"',
  '"source_frames"',
  '"unreported_frames"',
  '"misaligned_frames"',
  '"thumb_path"',
  '"source"'
].join(', ')

export function insertImage(params: Omit<ImageRow, 'id' | 'host' | 'source'> & { source?: 'capture' | 'import' }): number {
  let host: string | null = null
  try { if (params.url) host = new URL(params.url).hostname.replace(/^www\./, '') } catch { /* ignore */ }
  const source = params.source ?? 'capture'
  const searchText = buildSearchText(params.title, params.memo)
  const stmt = prepare(
    `INSERT INTO images (filepath, captured_at, original_captured_at, title, current_time, url, width, height, colors, memo, media_type, duration, fps, thumb_path, host, source, search_text)
     VALUES (@filepath, @captured_at, @original_captured_at, @title, @current_time, @url, @width, @height, @colors, @memo, @media_type, @duration, @fps, @thumb_path, @host, @source, @search_text)`
  )
  const result = stmt.run({
    ...params,
    current_time: normalizeCurrentTime(params.current_time),
    original_captured_at: params.original_captured_at ?? null,
    host, source, search_text: searchText
  })
  return Number(result.lastInsertRowid)
}

// ImageQuery（共有のフィルタ契約）に、カーソルページング用の before/beforeId と
// 並び順を足したものが WHERE 句ビルダーの入力。
type ImageFilter = ImageQuery & {
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
    // 検索語も保存側と同じ normalizeSearchText を通してから当てる。長さ判定は正規化後の
    // 長さで行う（正規化前が3文字以上でも、空白や記号が落ちて trigram を作れない長さに
    // 縮む入力があるため）。正規化で空文字になった（記号だけを打った等）場合は絞り込み
    // 自体を付けない — 0件にするより素直。
    //
    // 空白区切りの語は**すべて含む**行に絞る（searchTerms）。3文字以上の語は FTS の
    // フレーズを AND でまとめて 1 回の MATCH に載せ、trigram を作れない短い語だけ
    // LIKE を足す。**短い語を FTS 側へ混ぜない**——1 つでもトライグラムを作れない
    // フレーズが入ると、その MATCH は他の語ごと 0 件になる。
    const terms = searchTerms(f.search)
    const ftsTerms = terms.filter((term) => term.length >= FTS_MIN_LEN)
    const likeTerms = terms.filter((term) => term.length < FTS_MIN_LEN)
    if (ftsTerms.length > 0) {
      conds.push('id IN (SELECT rowid FROM images_fts_v2 WHERE images_fts_v2 MATCH ?)')
      params.push(ftsTerms.map(ftsPhraseQuery).join(' AND '))
    }
    for (const term of likeTerms) {
      conds.push("search_text LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(term)}%`)
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

export function getImage(id: number): ImageRowBase | null {
  const row = prepare(`SELECT ${PUBLIC_IMAGE_COLUMNS} FROM images WHERE id = ?`).get(id) as RawImageRowBase | undefined
  return row ? normalizeImageRow(row) as ImageRowBase : null
}

// 一括削除の DB 側を 1 トランザクションにまとめる（B-7）。1枚ずつ IPC 往復していた旧経路は
// 数千枚だと分単位になっていた。実ファイル削除は非トランザクショナルな後始末として
// 呼び出し元（ipc-images.ts）が逐次ベストエフォートで行う。
export function deleteImagesBulk(ids: number[]): void {
  if (ids.length === 0) return
  const delTags = prepare('DELETE FROM image_tags WHERE image_id = ?')
  const delImg = prepare('DELETE FROM images WHERE id = ?')
  getDb().transaction(() => {
    for (const id of ids) {
      delTags.run(id)
      delImg.run(id)
    }
    // 孤児タグの掃除はループ内ではなく最後に1回だけ（件数に比例して重くならないように）。
    pruneOrphanTags()
  })()
}

export function updateImageTitle(id: number, title: string): void {
  const row = prepare('SELECT memo FROM images WHERE id = ?').get(id) as { memo: string | null } | undefined
  const searchText = buildSearchText(title || null, row?.memo ?? null)
  prepare('UPDATE images SET title = ?, search_text = ? WHERE id = ?').run(title || null, searchText, id)
}

export function updateImageMemo(id: number, memo: string): void {
  const row = prepare('SELECT title FROM images WHERE id = ?').get(id) as { title: string | null } | undefined
  const searchText = buildSearchText(row?.title ?? null, memo || null)
  prepare('UPDATE images SET memo = ?, search_text = ? WHERE id = ?').run(memo || null, searchText, id)
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

// 撮り逃した枚数と、その母数である素材のコマ総数。**必ず一緒に書く** —— 片方だけ更新すると
// 割合が別々の時点の数から算出され、詳細パネルの「多い / 少ない」が静かに狂う。
// unreportedMeasured は「抜けの枚数に裏が取れているか」。**既定を false にしない**——
// 呼び忘れた経路が黙って「確定」を名乗るより、推定と出る方が安全側（db-schema の注記）。
export function setFrameCounts(
  id: number, uncaptured: number, total: number, unreported: number,
  misaligned = 0, unreportedMeasured = false
): void {
  prepare(
    'UPDATE images SET uncaptured_frames = ?, source_frames = ?, unreported_frames = ?,' +
    ' misaligned_frames = ?, unreported_measured = ? WHERE id = ?'
  ).run(uncaptured, total, unreported, misaligned, unreportedMeasured ? 1 : 0, id)
}

// 検証で「絵が変わっていて特定できない」と分かったコマ数。検証を通していないクリップと
// 「検証したが0コマだった」クリップを区別する必要があるため、0 も明示的に書く。
export function setAmbiguousFrames(id: number, count: number): void {
  prepare('UPDATE images SET ambiguous_frames = ? WHERE id = ?').run(count, id)
}

// 保存先の移動用。**id とパスだけ**を引く（数万件で無駄に重くしないため）。
export function listImagePaths(): { id: number; filepath: string }[] {
  return prepare('SELECT id, filepath FROM images').all() as { id: number; filepath: string }[]
}

// 移した先のパスをまとめて書き換える。**1 トランザクションで確定させる**——
// 1 件ずつ書くと、途中で落ちたときに記録とファイルが半分ずつ食い違う
// （move-captures.ts の注記）。
export function setImagePaths(updates: readonly { id: number; filepath: string }[]): void {
  if (updates.length === 0) return
  const stmt = prepare('UPDATE images SET filepath = ? WHERE id = ?')
  getDb().transaction(() => {
    for (const row of updates) stmt.run(row.filepath, row.id)
  })()
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

type ExportRow = ImageRow & { manualTags: string[] }

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

// 手打ちのタイムシート。空になったら行ごと消す（打っていないクリップと同じ状態へ戻す）。
export function saveTimesheet(imageId: number, data: string): void {
  if (data === '[]') {
    prepare('DELETE FROM timesheets WHERE image_id = ?').run(imageId)
    return
  }
  prepare('INSERT OR REPLACE INTO timesheets (image_id, data) VALUES (?, ?)').run(imageId, data)
}

export function getTimesheet(imageId: number): string | null {
  const row = prepare('SELECT data FROM timesheets WHERE image_id = ?').get(imageId) as { data: string } | undefined
  return row?.data ?? null
}
