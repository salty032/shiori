// タグの読み書き（tags / image_tags）。db.ts から切り出した。
//
// 手動タグ（source='manual'）と AI タグ（source='ai'）が同じ表に同居し、**手動が 1 件でも
// あれば手動として扱う**という規則がこのファイル全体に効いている（昇格はするが降格はしない）。
// 規則を破ると、ユーザーが手で付けたタグが AI 由来として一覧から消える。
import type { ImageTag, TagWithCount } from '../shared/types'
import { getDb, prepare } from './db-core'

// どの画像にも付かなくなった tags 行を落とす。image_tags は画像削除で消えるが tags 自体は
// 残るため（deleteAllAiTags のコメントと同じ理由）、放置すると削除を繰り返すたびに tags
// テーブルだけが肥大化する。画像削除の直後に同じトランザクション内で呼ぶ。
export function pruneOrphanTags(): void {
  prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM image_tags)').run()
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
  getDb().transaction(() => {
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
  getDb().transaction(() => {
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
  getDb().transaction(() => {
    for (const id of imageIds) del.run(id, tag.id)
  })()
}

// AIタグ付けモデル削除時に、AI由来のタグ（source='ai'）をライブラリ全体から一括削除する。
// 手動タグ（source='manual'）は対象外。Undo不可のため呼び出し元で確認を取ってから呼ぶこと。
// 削除後にどの image_tags からも参照されなくなった tags 行（孤児）も併せて掃除する。
// image_tags は CASCADE で消えても tags 自体は残る仕様のため、ここで放置すると
// AIタグ削除を繰り返すたびに tags テーブルが肥大化する。
export function deleteAllAiTags(): number {
  return getDb().transaction(() => {
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
  return getDb().transaction(() => {
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

export function removeImageTag(imageId: number, tagName: string): void {
  const tag = prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number } | undefined
  if (!tag) return
  prepare('DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?').run(imageId, tag.id)
}
