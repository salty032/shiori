import { app } from 'electron'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { captureDir, thumbnailDir } from './paths'
import { modelDir } from '../capture/tagger'

// 設定 > データ に出す「今どれだけ溜まっているか」。
//
// 以前はここが画面のどこにも無く、書き出し・読み込み・サムネ修復という分単位の作業ボタンだけが
// 並んでいた。何枚あるのか・何GBあるのかを知らないまま押すことになっていた。AIモデルも同じで、
// 数百MBの実体に「削除」ボタンだけがあり、押していいかを判断する材料が無かった。

// 数万ファイルを直列に stat すると体感で待たされる。かといって全件を同時に投げると
// fd が枯渇するので、この幅で区切って並列に取る。
const STAT_CONCURRENCY = 64

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    // 未作成・権限なし・走査中に消えた、のいずれも「0バイト」として扱ってよい。
    // ここで失敗しても画面には「そのぶん少ない合計」が出るだけで、操作は壊れない。
    return 0
  }
}

// ディレクトリ配下（再帰）のファイル合計サイズ。captures は年月サブフォルダに
// 分かれている（paths.ts の captureSubDir）ため、必ず再帰で数える。
async function dirBytes(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true })
  } catch {
    return 0 // フォルダ自体が未作成（1枚も撮っていない・モデル未取得）
  }

  const paths = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))

  let total = 0
  for (let i = 0; i < paths.length; i += STAT_CONCURRENCY) {
    const sizes = await Promise.all(paths.slice(i, i + STAT_CONCURRENCY).map(fileBytes))
    for (const size of sizes) total += size
  }
  return total
}

export type StorageUsage = {
  captureDir: string
  captureBytes: number
  thumbnailBytes: number
  dbBytes: number
  modelBytes: number
}

export async function collectStorageUsage(): Promise<StorageUsage> {
  const dbPath = join(app.getPath('userData'), 'Shiori.db')
  // WAL モードの SQLite は本体・-wal・-shm の3つで1つの実体。本体だけ見せると
  // 書き込みが多い時期に実際の占有量と食い違う。
  const [captureBytes, thumbnailBytes, modelBytes, db, wal, shm] = await Promise.all([
    dirBytes(captureDir()),
    dirBytes(thumbnailDir()),
    dirBytes(modelDir()),
    fileBytes(dbPath),
    fileBytes(`${dbPath}-wal`),
    fileBytes(`${dbPath}-shm`),
  ])

  return {
    captureDir: captureDir(),
    captureBytes,
    thumbnailBytes,
    dbBytes: db + wal + shm,
    modelBytes,
  }
}
