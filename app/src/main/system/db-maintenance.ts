import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

// Shiori.db の退避・健全性確認・復元。
//
// タグ・メモ・URL・**タイムシートの打鍵**はこの 1 ファイルにしか無く、画像や動画と違って
// 撮り直しが効かない。これまでは「開けたら健全」とみなし、列を足す前の退避も取っていな
// かったため、壊れたまま上書きが進んで戻せなくなる余地があった。
//
// SQL を直に書かず SqlRunner 越しに投げているのは、テストで実物の SQLite を通すため。
// 本番の better-sqlite3 は Electron の ABI 向けにビルドされていて素の Node（vitest）から
// 読み込めないが、Node 24 同梱の node:sqlite は同じ SQLite なので、壊れたファイルの検出も
// VACUUM INTO も本物の挙動で確認できる。差はバインディングだけで、エンジンは同じ。
export interface SqlRunner {
  /** PRAGMA を 1 つ実行し、最初の列の値を返す */
  pragma(sql: string): string | number | null
  /** SQL をそのまま実行する */
  exec(sql: string): void
}

// 退避の要否を決めるスキーマの版。
//
// **images に列を足したり、テーブル・インデックスを増やしたら必ずここを上げる。**
// 上げ忘れると、作りを変える前の退避が取られないまま移行が走る。上げ忘れても画面には
// 何も起きないので、気づけるのは戻したくなった後になる。
export const SCHEMA_VERSION = 2

/** 残す退避の世代数。メタデータだけなので 1 世代は小さいが、無制限に貯めても意味が無い */
export const BACKUP_KEEP = 3

/** userData 直下に置く退避用フォルダ名 */
export const BACKUP_DIR_NAME = 'backups'

/** 壊れていたと判断した DB を、消さずに残しておく名前の目印 */
const BROKEN_MARK = 'broken'

/** DB と一緒に扱う必要のある付属ファイル（WAL モードで作られる） */
const SIDECAR_SUFFIXES = ['-wal', '-shm']

export class DatabaseCorruptError extends Error {
  constructor(readonly detail: string) {
    super(`database integrity check failed: ${detail}`)
    this.name = 'DatabaseCorruptError'
  }
}

/**
 * 開けたことと壊れていないことは別。quick_check を通さないと、壊れたファイルへ
 * 上書きを進めてしまう。健全なら null、壊れていれば SQLite が返した理由を返す。
 *
 * integrity_check ではなく quick_check なのは、起動のたびに全ページの相互参照まで
 * 検証すると素材が増えるほど起動が延びるため。ページ内の壊れは quick_check で拾える。
 */
export function integrityProblem(runner: SqlRunner): string | null {
  const result = runner.pragma('quick_check(1)')
  return result === 'ok' ? null : String(result ?? 'unknown')
}

export function readSchemaVersion(runner: SqlRunner): number {
  const value = Number(runner.pragma('user_version'))
  return Number.isFinite(value) ? value : 0
}

export function writeSchemaVersion(runner: SqlRunner, version: number): void {
  // user_version はプレースホルダを受け付けないので数値であることをここで担保する。
  if (!Number.isInteger(version) || version < 0) throw new Error(`invalid schema version: ${version}`)
  runner.exec(`PRAGMA user_version = ${version}`)
}

/** ファイル名に使える時刻。並べ替えがそのまま新しい順になるよう固定長で作る */
export function backupTimestamp(now: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export function backupDirFor(dbPath: string): string {
  return join(dirname(dbPath), BACKUP_DIR_NAME)
}

function dbStem(dbPath: string): string {
  return basename(dbPath).replace(/\.db$/i, '')
}

/**
 * 退避を 1 世代作り、作ったファイルのパスを返す。
 *
 * ファイルコピーではなく VACUUM INTO を使う。WAL モードでは最新の書き込みが本体ではなく
 * -wal 側にあるため、.db だけコピーすると「少し古い状態」を退避したことになる。
 * VACUUM INTO なら SQLite が今の内容を 1 ファイルにまとめて書き出す。
 */
export function backupDatabase(runner: SqlRunner, dbPath: string, now: Date): string {
  const dir = backupDirFor(dbPath)
  mkdirSync(dir, { recursive: true })
  let dest = join(dir, `${dbStem(dbPath)}-${backupTimestamp(now)}.db`)
  // VACUUM INTO は宛先が既にあると失敗する。同じ秒に 2 回来ても落とさない。
  let serial = 2
  while (existsSync(dest)) {
    dest = join(dir, `${dbStem(dbPath)}-${backupTimestamp(now)}-${serial}.db`)
    serial += 1
  }
  runner.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  return dest
}

/** 退避を新しい順に返す。壊れた DB の退避（broken）は世代管理の対象にしない */
export function listBackups(dbPath: string): string[] {
  const dir = backupDirFor(dbPath)
  if (!existsSync(dir)) return []
  const prefix = `${dbStem(dbPath)}-`
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db') && !name.includes(`-${BROKEN_MARK}-`))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/** 世代数を超えた古い退避を消し、消したパスを返す */
export function pruneBackups(dbPath: string, keep = BACKUP_KEEP): string[] {
  const removed: string[] = []
  for (const path of listBackups(dbPath).slice(keep)) {
    try { unlinkSync(path); removed.push(path) } catch { /* 消せなくても実害は無い */ }
  }
  return removed
}

/**
 * 壊れていた DB を消さずに退避フォルダへ移し、移した先を返す。
 *
 * -wal / -shm も一緒に移す。WAL には本体へ書き戻される前の新しい内容が残っていることが
 * あり、後から救い出せる可能性を捨てない。逆に、置き去りにしたまま復元した DB を開くと、
 * SQLite が別の DB の WAL を継ぎ足して読むおそれがある。
 */
export function setAsideBrokenDatabase(dbPath: string, now: Date): string {
  const dir = backupDirFor(dbPath)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${dbStem(dbPath)}-${BROKEN_MARK}-${backupTimestamp(now)}.db`)
  renameSync(dbPath, dest)
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`
    if (existsSync(sidecar)) {
      try { renameSync(sidecar, `${dest}${suffix}`) } catch { /* 残っても復元側で消す */ }
    }
  }
  return dest
}

/**
 * 退避を本体の位置へ戻す。戻す前に、現在の DB は setAsideBrokenDatabase で必ず退避しておく
 * こと（この関数は上書きする）。
 */
export function restoreDatabase(backupPath: string, dbPath: string): void {
  // 元の -wal / -shm が残っていると、復元した DB に別世代の WAL が継ぎ足される。
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`
    if (existsSync(sidecar)) {
      try { unlinkSync(sidecar) } catch { /* 消せなければ下のコピー後に SQLite が判断する */ }
    }
  }
  copyFileSync(backupPath, dbPath)
}

/**
 * 復元したことを次の起動へ伝える目印。
 *
 * 復元の直後はアプリを起動し直す（`bootstrap.ts` の recoverDatabase）ので、メモリ上の変数では
 * 引き継げない。ダイアログはボタンを押した瞬間に消えるため、「何が含まれていないのか」を
 * 起動後の画面にも出せないと、戻したこと自体を忘れたまま使い続けることになる。
 * `.thumbnails-migrated` / `.orphan-sweep-last` と同じ、userData 直下の目印ファイル。
 */
function restoreMarkerPath(dbPath: string): string {
  return join(dirname(dbPath), '.db-restored')
}

export function writeRestoreMarker(dbPath: string, backupPath: string): void {
  writeFileSync(restoreMarkerPath(dbPath), backupPath, 'utf8')
}

/** 目印があれば戻した退避のパスを返して消す。無ければ null */
export function consumeRestoreMarker(dbPath: string): string | null {
  const marker = restoreMarkerPath(dbPath)
  if (!existsSync(marker)) return null
  let value: string | null = null
  try { value = readFileSync(marker, 'utf8').trim() || null } catch { value = null }
  // 読めなくても必ず消す。残ると毎起動「戻しました」と言い続ける。
  try { unlinkSync(marker) } catch { /* 消せなければ次回また出るだけ */ }
  return value
}

/**
 * 「開けたが壊れている」だけでなく、開く時点で壊れていると分かる場合も復元の対象にする。
 * ロック中・権限不足（AV やバックアップソフト）を復元に巻き込まないよう、SQLite が
 * 破損だと言っているコードだけを見る。
 */
export function isDatabaseDamaged(err: unknown): boolean {
  if (err instanceof DatabaseCorruptError) return true
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return false
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB'
}
