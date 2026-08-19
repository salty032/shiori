import type Database from 'better-sqlite3'

// スキーマ（db-schema.ts）とクエリ（db.ts / db-tags.ts / db-video-frames.ts）で接続を
// 共有するための内部モジュール。
// **ここを外から import してよいのは src/main/db*.ts だけ。** 接続そのものを配ると
// 呼び出し側が勝手にスキーマを触れてしまい、db-schema.ts の initDb を通さない経路ができる。
let db: Database.Database | undefined

// SQL文字列をキーとしてコンパイル済みステートメントをキャッシュする。
// 固定SQLは1回だけコンパイル、動的SQLも同一パターンが再利用される。
const stmtCache = new Map<string, Database.Statement>()

// initDb が接続を張り直すたびに呼ぶ。前の接続で作ったステートメントは新しい接続では
// 使えないため、ここで必ずキャッシュを捨てる。
export function setDatabase(next: Database.Database): void {
  db = next
  stmtCache.clear()
}

export function getDb(): Database.Database {
  if (!db) throw new Error('database is not open yet (initDb before use)')
  return db
}

export function prepare(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql)
  if (!stmt) { stmt = getDb().prepare(sql); stmtCache.set(sql, stmt) }
  return stmt
}
