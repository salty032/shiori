import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// initDb（列の追加・索引の作り直し・埋め直し）の回帰テスト。
//
// **全員が起動のたびに通る唯一の経路**なのに、移行した後が想定した形になっているかを
// 確かめるものが無かった。退避とロールバックがあるので最悪は避けられるが、それは
// 「失敗したときに戻せる」だけで、「成功したときに正しい」の保証ではない。
//
// 本番の better-sqlite3 は Electron の ABI 向けにビルドされていて素の Node からは読めないが、
// Node 24 同梱の node:sqlite は同じ SQLite（db-maintenance.test.ts と同じ理由）。ここでは
// better-sqlite3 を node:sqlite の薄い包みに差し替えて、**移行の SQL を実物の SQLite へ流す**。
// 差はバインディングだけで、エンジンは同じ。

const state = vi.hoisted(() => ({ userData: '', packaged: false }))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    get isPackaged() { return state.packaged },
  },
}))

// better-sqlite3 の、initDb が使う分だけを node:sqlite で満たす包み。
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync: Sync } = await import('node:sqlite')
  class Shim {
    #db: InstanceType<typeof Sync>
    constructor(path: string) { this.#db = new Sync(path) }
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
  return { default: Shim }
})

import { SCHEMA_VERSION, DatabaseVersionTooNewError } from './system/db-maintenance'
import { initDb, databasePath } from './db-schema'
import { getDb, prepare } from './db-core'

let dir: string

function tableNames(): string[] {
  return (prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[])
    .map((r) => r.name)
}

function columnNames(table: string): string[] {
  return (prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

function closeDb(): void {
  try { (getDb() as unknown as { close(): void }).close() } catch { /* まだ開いていない */ }
}

// 移行前の DB を作る。一度 initDb を通して現行の形にしてから中身を入れ、閉じる。
function seed(rows: (db: typeof prepare) => void): void {
  initDb()
  rows(prepare)
  closeDb()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiori-db-'))
  state.userData = dir
  state.packaged = false
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('新規インストール', () => {
  it('必要なテーブルが一通り作られる', () => {
    initDb()
    const names = tableNames()
    for (const t of ['images', 'tags', 'image_tags', 'video_frames', 'timesheets', 'app_meta', 'images_fts_v2']) {
      expect(names).toContain(t)
    }
  })

  it('現行のスキーマ版が記録される', () => {
    initDb()
    expect((prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
  })

  // 中身の無い DB を退避しても意味が無い。世代を 1 つ無駄に使う。
  it('退避は取らない', () => {
    initDb()
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('二度目の起動でも通る（何度実行しても同じ形になる）', () => {
    initDb()
    const before = columnNames('images')
    closeDb()
    initDb()
    expect(columnNames('images')).toEqual(before)
  })
})

describe('古い DB を開いたとき', () => {
  // **足りない列は足す。** 途中で落ちて一部の列が欠けた状態も、次の起動で埋まる。
  it('欠けている列を足し、既存の行は残す', () => {
    seed((p) => {
      p('INSERT INTO images (filepath, captured_at, title) VALUES (?, ?, ?)').run('/a.png', 1700000000000, 'あ')
    })
    // 後から足した列を落として「古い形」に戻す
    const raw = new DatabaseSync(databasePath())
    raw.exec('ALTER TABLE images DROP COLUMN original_captured_at')
    raw.exec('PRAGMA user_version = 1')
    raw.close()

    initDb()

    expect(columnNames('images')).toContain('original_captured_at')
    expect((prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n).toBe(1)
    expect((prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
  })

  // **作りを変える前の退避は必須。** ここを飛ばすと、まさに戻したい移行失敗時に戻り先が無い。
  it('スキーマの版が上がるときは、移行の前に退避を取る', () => {
    seed(() => {})
    const raw = new DatabaseSync(databasePath())
    raw.exec('PRAGMA user_version = 1')
    raw.close()

    initDb()

    expect(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.db'))).toHaveLength(1)
  })

  // 旧版のアプリで新しい DB を開くと、知らない列を無視したまま書き込んでしまう。
  it('自分より新しい版の DB は開かずに投げる', () => {
    seed(() => {})
    const raw = new DatabaseSync(databasePath())
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()

    expect(() => initDb()).toThrow(DatabaseVersionTooNewError)
  })
})

describe('host の埋め直し', () => {
  const hostOf = (url: string | null): string | null => {
    seed((p) => {
      p('INSERT INTO images (filepath, captured_at, url) VALUES (?, ?, ?)').run('/a.png', 1700000000000, url)
      p('UPDATE images SET host = NULL').run()
    })
    initDb()
    return (prepare('SELECT host FROM images').get() as { host: string | null }).host
  }

  it('URL からホスト名を取り出す', () => expect(hostOf('https://youtube.com/watch?v=x')).toBe('youtube.com'))
  it('www. は落とす', () => expect(hostOf('https://www.nicovideo.jp/watch/sm1')).toBe('nicovideo.jp'))

  // **空文字は「処理済み・ホストなし」の印。** NULL のまま残すと、毎起動で同じ行を
  // 読み直して同じ失敗を繰り返す。
  it('URL が壊れていれば空文字を入れて、次回は読み直さない', () => expect(hostOf('not a url')).toBe(''))

  it('URL が無い行は触らない', () => expect(hostOf(null)).toBeNull())
})

describe('検索用テキストの埋め直し', () => {
  // SQLite には NFKC も Unicode プロパティ判定も無いので、正規化は書き込み側の JS で行って
  // 結果をここへ書く（docs/SPEC.md 5章）。**カタカナはひらがなへ寄せる**ので、カタカナで
  // 打った作品名はひらがなでも見つかる。
  it('タイトルとメモが正規化されて入り、FTS の索引からも引ける', () => {
    seed((p) => {
      p('INSERT INTO images (filepath, captured_at, title, memo) VALUES (?, ?, ?, ?)')
        .run('/a.png', 1700000000000, 'ワルプルギス', 'メモ')
      p('UPDATE images SET search_text = NULL').run()
    })
    initDb()

    const row = prepare('SELECT search_text FROM images').get() as { search_text: string }
    expect(row.search_text).toBe('わるぷるぎす\nめも')
    const hit = prepare("SELECT COUNT(*) AS n FROM images_fts_v2 WHERE images_fts_v2 MATCH 'わるぷるぎす'").get() as { n: number }
    expect(hit.n).toBe(1)
  })
})

// 配った版で打ち込まれたタイムシートを消す（2026-08-31 の指示）。表が並べているコマ番号は
// 抜けた区間の枚数を推定したまま組み立てているので、残しておくと次に開いたときに
// **画面上は正しく見えるまま**「前に打ったもの」として通ってしまう。
describe('配布版の初回起動でタイムシートを消す', () => {
  const seedTimesheet = (): void => {
    seed((p) => {
      p('INSERT INTO images (id, filepath, captured_at) VALUES (1, ?, ?)').run('/a.webm', 1700000000000)
      p('INSERT INTO timesheets (image_id, data) VALUES (1, ?)').run('[]')
    })
  }
  const count = (): number => (prepare('SELECT COUNT(*) AS n FROM timesheets').get() as { n: number }).n

  it('配布版では消える', () => {
    seedTimesheet()
    state.packaged = true
    initDb()
    expect(count()).toBe(0)
  })

  // **印が置いてあれば二度と消さない。** 毎起動で消すと、機能を開け直した後に打ったものまで消える。
  it('二度目の起動では消さない', () => {
    seedTimesheet()
    state.packaged = true
    initDb()
    prepare('INSERT INTO timesheets (image_id, data) VALUES (1, ?)').run('["あとで打った"]')
    closeDb()

    initDb()
    expect(count()).toBe(1)
  })

  // 消す対象は配った先の打ち込み。開発版でも消すと、直している最中の材料が毎回無くなる。
  it('開発版では消さない', () => {
    seedTimesheet()
    state.packaged = false
    initDb()
    expect(count()).toBe(1)
  })
})
