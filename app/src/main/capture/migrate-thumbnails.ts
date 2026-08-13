import { rename, mkdir, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { app } from 'electron'
import { basename, dirname, join, resolve } from 'path'
import { captureDir, thumbnailDir } from '../system/paths'
import { listImagesWithThumb, setThumbPath } from '../db'

// 移行が一度完了したことを示すマーカー。これがあれば毎起動の全件スキャンを丸ごと省く。
// Settings（renderer 公開契約）を汚さないよう userData 直下の専用ファイルで持つ。
function migrationMarkerPath(): string {
  return join(app.getPath('userData'), '.thumbnails-migrated')
}

async function writeMigrationMarker(): Promise<void> {
  try {
    await writeFile(migrationMarkerPath(), new Date().toISOString(), 'utf-8')
  } catch (err) {
    console.warn('[migrate-thumb] failed to write marker', err)
  }
}

// 旧バージョンでは原本と表示用サムネ（*_t.jpg 等）を同じ captureDir に同居させていた。
// サムネ専用ディレクトリへ分離したため、captureDir 配下に残る既存サムネを起動時に移動し
// DB の thumb_path を書き換える。サムネは再生成可能なので失敗は非致命（スキップ）。
// thumb_path の dirname で判定するため、移行済みの行は thumbnailDir 配下になり再実行で no-op。
// 一度完了したらマーカーを書き、以降は全件スキャン（listImagesWithThumb）自体を回避する。
export async function migrateThumbnailsToOwnDir(): Promise<void> {
  if (existsSync(migrationMarkerPath())) return

  const capBase = resolve(captureDir())
  const thumbDir = thumbnailDir()

  const targets = listImagesWithThumb().filter(
    (r) => resolve(dirname(r.thumb_path)) === capBase
  )
  if (targets.length === 0) {
    await writeMigrationMarker()
    return
  }

  await mkdir(thumbDir, { recursive: true })

  let moved = 0
  for (const { id, thumb_path } of targets) {
    const dest = join(thumbDir, basename(thumb_path))
    try {
      // 移行が中断して dest が残っている場合に備え、衝突したら一旦消してから移動。
      try { await unlink(dest) } catch { /* dest 不在は正常 */ }
      await rename(thumb_path, dest)
      setThumbPath(id, dest)
      moved++
    } catch (err) {
      // 原本サムネが既に無い等は無視（サムネ一括生成で復元可能）。
      console.warn('[migrate-thumb] skip id=' + id, err)
    }
  }
  console.log(`[migrate-thumb] moved ${moved}/${targets.length} thumbnails to ${thumbDir}`)
  // 残った未移行（原本サムネ欠落など）は再生成で復元可能なので、完了マーカーを書いて打ち切る。
  await writeMigrationMarker()
}
