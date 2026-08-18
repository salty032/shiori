import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  DatabaseCorruptError,
  backupDatabase,
  backupDirFor,
  backupTimestamp,
  integrityProblem,
  isDatabaseDamaged,
  listBackups,
  pruneBackups,
  readSchemaVersion,
  consumeRestoreMarker,
  restoreDatabase,
  setAsideBrokenDatabase,
  writeRestoreMarker,
  writeSchemaVersion,
  type SqlRunner
} from './db-maintenance'

// 本番は better-sqlite3（Electron の ABI 向けにビルドされていて素の Node からは読めない）だが、
// Node 24 同梱の node:sqlite は同じ SQLite。壊れたファイルの検出も VACUUM INTO も本物の挙動で
// 確認できる。差はバインディングだけなので、ここで固定した振る舞いは本番でもそのまま通る。
function runnerFor(db: DatabaseSync): SqlRunner {
  return {
    pragma: (sql) => {
      const row = db.prepare(`PRAGMA ${sql}`).get() as Record<string, unknown> | undefined
      if (!row) return null
      return Object.values(row)[0] as string | number | null
    },
    exec: (sql) => { db.exec(sql) }
  }
}

let dir: string
let dbPath: string
let db: DatabaseSync

/** タイムシートの打鍵に相当する「撮り直しの効かない手入力」を1行入れた DB を作る */
function createDatabase(path: string): DatabaseSync {
  const handle = new DatabaseSync(path)
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('CREATE TABLE timesheets (id INTEGER PRIMARY KEY, image_id INTEGER, cell TEXT)')
  handle.exec("INSERT INTO timesheets (image_id, cell) VALUES (1, 'a')")
  return handle
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiori-db-'))
  dbPath = join(dir, 'Shiori.db')
  db = createDatabase(dbPath)
})

afterEach(() => {
  try { db.close() } catch { /* 既に閉じている場合 */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('健全性の確認', () => {
  it('健全な DB では問題を返さない', () => {
    expect(integrityProblem(runnerFor(db))).toBeNull()
  })

  it('中身を壊したファイルは開けても検出できる（開けた＝健全ではない）', () => {
    // 1000 行入れてページを増やし、ヘッダーではなく中間のページを壊す。ヘッダーだけを
    // 壊すと open の時点で弾かれてしまい、「開けるが壊れている」状態にならない。
    for (let i = 0; i < 1000; i++) db.exec(`INSERT INTO timesheets (image_id, cell) VALUES (${i}, 'x${i}')`)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()

    const raw = readFileSync(dbPath)
    raw.fill(0x6a, 4096 * 3, 4096 * 4)
    writeFileSync(dbPath, raw)

    db = new DatabaseSync(dbPath)
    const problem = integrityProblem(runnerFor(db))
    expect(problem).not.toBeNull()
    expect(problem).not.toBe('ok')
  })
})

describe('スキーマの版', () => {
  it('新しい DB は 0 から始まり、書いた値を読み戻せる', () => {
    const runner = runnerFor(db)
    expect(readSchemaVersion(runner)).toBe(0)
    writeSchemaVersion(runner, 1)
    expect(readSchemaVersion(runner)).toBe(1)
  })

  it('整数でない版は書かせない（PRAGMA は文字列を差し込む形になるため）', () => {
    expect(() => writeSchemaVersion(runnerFor(db), 1.5)).toThrow()
    expect(() => writeSchemaVersion(runnerFor(db), -1)).toThrow()
  })
})

describe('退避', () => {
  it('WAL に残っている最新の書き込みまで含めて退避する', () => {
    // チェックポイントせずに書く＝本体ではなく -wal 側にある状態。ファイルコピーでは
    // 取りこぼす分が、VACUUM INTO なら入る。
    db.exec("INSERT INTO timesheets (image_id, cell) VALUES (99, 'wal-only')")
    const dest = backupDatabase(runnerFor(db), dbPath, new Date())

    expect(existsSync(dest)).toBe(true)
    const copy = new DatabaseSync(dest)
    const row = copy.prepare('SELECT cell FROM timesheets WHERE image_id = 99').get() as { cell: string }
    expect(row.cell).toBe('wal-only')
    copy.close()
  })

  it('同じ秒に 2 回取っても上書きしない', () => {
    const now = new Date()
    const first = backupDatabase(runnerFor(db), dbPath, now)
    const second = backupDatabase(runnerFor(db), dbPath, now)
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
  })

  it('古い世代から消し、新しい方を残す', () => {
    const runner = runnerFor(db)
    const made: string[] = []
    for (let i = 0; i < 5; i++) made.push(backupDatabase(runner, dbPath, new Date(2026, 0, 1 + i)))

    const removed = pruneBackups(dbPath, 3)
    expect(removed).toHaveLength(2)
    const left = listBackups(dbPath)
    expect(left).toHaveLength(3)
    // mtime 順（新しい順）で残る
    expect(left.map((p) => existsSync(p))).toEqual([true, true, true])
    expect(made.filter((p) => existsSync(p))).toHaveLength(3)
  })

  it('退避が 1 つも無ければ空を返す（復元を提案してよいかの判断に使う）', () => {
    expect(listBackups(dbPath)).toEqual([])
  })
})

describe('復元', () => {
  it('壊れた DB を消さずに退避フォルダへ移し、置き去りの -wal も一緒に連れて行く', () => {
    db.exec("INSERT INTO timesheets (image_id, cell) VALUES (7, 'later')")
    db.close()
    // 正常に閉じれば -wal は本体へ書き戻されて消える。残るのは異常終了や破損で
    // 書き戻せなかったときで、救いたい内容がここにあるのもその場合。
    writeFileSync(`${dbPath}-wal`, 'leftover')

    const moved = setAsideBrokenDatabase(dbPath, new Date())
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(moved)).toBe(true)
    expect(existsSync(`${moved}-wal`)).toBe(true)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)

    db = new DatabaseSync(dbPath)  // afterEach 用に開き直す
  })

  it('壊れた DB の退避は世代管理の対象に混ぜない（消えると救えなくなる）', () => {
    backupDatabase(runnerFor(db), dbPath, new Date())
    db.close()
    setAsideBrokenDatabase(dbPath, new Date())

    expect(listBackups(dbPath)).toHaveLength(1)
    expect(listBackups(dbPath)[0]).not.toContain('-broken-')

    db = new DatabaseSync(dbPath)
  })

  it('戻した DB は退避時点の中身を持ち、古い -wal は継ぎ足されない', () => {
    const backup = backupDatabase(runnerFor(db), dbPath, new Date())
    db.exec("INSERT INTO timesheets (image_id, cell) VALUES (2, '退避より後')")
    db.close()

    setAsideBrokenDatabase(dbPath, new Date())
    restoreDatabase(backup, dbPath)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)

    db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT cell FROM timesheets ORDER BY id').all() as { cell: string }[]
    expect(rows.map((r) => r.cell)).toEqual(['a'])
  })

  it('退避も壊れた DB も同じフォルダに置く', () => {
    const backup = backupDatabase(runnerFor(db), dbPath, new Date())
    expect(backup.startsWith(backupDirFor(dbPath))).toBe(true)
  })
})

describe('戻したことを次の起動へ伝える目印', () => {
  it('書いた退避のパスを 1 回だけ返し、次からは返さない', () => {
    const backup = backupDatabase(runnerFor(db), dbPath, new Date())
    writeRestoreMarker(dbPath, backup)
    expect(consumeRestoreMarker(dbPath)).toBe(backup)
    // 消し損ねると毎起動「戻しました」と言い続けることになる
    expect(consumeRestoreMarker(dbPath)).toBeNull()
  })

  it('目印が無ければ null（普通の起動では通知を出さない）', () => {
    expect(consumeRestoreMarker(dbPath)).toBeNull()
  })
})

describe('復元を提案してよいエラーかの判定', () => {
  it('破損なら提案する', () => {
    expect(isDatabaseDamaged(new DatabaseCorruptError('*** in database main ***'))).toBe(true)
    expect(isDatabaseDamaged(Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' }))).toBe(true)
    expect(isDatabaseDamaged(Object.assign(new Error('not a db'), { code: 'SQLITE_NOTADB' }))).toBe(true)
  })

  it('ロック・権限・不明なエラーでは提案しない（現在のファイルを動かしてはいけない）', () => {
    expect(isDatabaseDamaged(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }))).toBe(false)
    expect(isDatabaseDamaged(Object.assign(new Error('perm'), { code: 'SQLITE_CANTOPEN' }))).toBe(false)
    expect(isDatabaseDamaged(new Error('EBUSY'))).toBe(false)
    expect(isDatabaseDamaged(null)).toBe(false)
  })
})

describe('退避のファイル名', () => {
  it('文字列の並び順がそのまま新しい順になる', () => {
    const older = backupTimestamp(new Date(2026, 7, 9, 3, 4, 5))
    const newer = backupTimestamp(new Date(2026, 7, 18, 20, 30, 0))
    expect(older).toBe('20260809-030405')
    expect(newer > older).toBe(true)
  })
})
