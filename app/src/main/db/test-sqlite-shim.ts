// テスト専用。better-sqlite3 の、Shiori が使う分だけを node:sqlite で満たす包み。
//
// 本番の better-sqlite3 は Electron の ABI 向けにビルドされていて素の Node からは読めないが、
// Node 24 同梱の node:sqlite は同じ SQLite。差はバインディングだけで、SQL は実物のエンジンへ流れる。
// 使い方: vi.mock('better-sqlite3', async () => ({ default: (await import('./test-sqlite-shim')).SqliteShim }))
import { DatabaseSync } from 'node:sqlite'

export class SqliteShim {
  #db: DatabaseSync
  constructor(path: string) { this.#db = new DatabaseSync(path) }
  get inTransaction(): boolean { return this.#db.isTransaction }
  pragma(sql: string, opts?: { simple?: boolean }): unknown {
    const rows = this.#db.prepare(`PRAGMA ${sql}`).all() as Record<string, unknown>[]
    if (!opts?.simple) return rows
    return rows.length > 0 ? Object.values(rows[0])[0] : null
  }
  exec(sql: string): void { this.#db.exec(sql) }
  prepare(sql: string): unknown { return this.#db.prepare(sql) }
  // better-sqlite3 は「既にトランザクション中なら SAVEPOINT を使う」。initDb は移行全体を
  // BEGIN IMMEDIATE で囲んだ内側で transaction() を呼ぶので、ここを BEGIN にすると落ちる。
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]): T => {
      const nested = this.#db.isTransaction
      this.#db.exec(nested ? 'SAVEPOINT tx' : 'BEGIN')
      try {
        const result = fn(...args)
        this.#db.exec(nested ? 'RELEASE tx' : 'COMMIT')
        return result
      } catch (err) {
        this.#db.exec(nested ? 'ROLLBACK TO tx' : 'ROLLBACK')
        throw err
      }
    }
  }
  close(): void { this.#db.close() }
}
