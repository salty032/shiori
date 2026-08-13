import { readdir, stat, unlink } from 'fs/promises'
import { extname, join, resolve } from 'path'
import { captureDir, thumbnailDir } from '../system/paths'
import { countImages, listReferencedPaths } from '../db'

// 削除は「DB 行を消す → 実ファイルを消す」の順で行う（ipc-images.ts の設計）。
// 後半が失敗すると DB から参照されない実ファイルが captures/thumbnails に残る。
// これは一覧に出ないのでユーザーには見えず、自分で消す手段もない。放置すると
// ファイル削除が失敗するたびに増え続けるため、起動時にアプリ側で回収する。

// 実ファイルの書き込みは DB 行の INSERT より先に起きる（captured-media.ts / ipc-video.ts）。
// その隙間に掃除が走ると、取り込み中の正当なファイルを孤立と誤判定して消してしまう。
// 大きな動画のトリム・インポートが数分かかることを見込み、十分に余裕をとる。
// 孤立ファイルの回収は急ぐ処理ではないので、取りこぼしても次回起動で拾えばよい。
const MIN_AGE_MS = 60 * 60 * 1000

// resolveCapturePath と同じ許可拡張子。ユーザーが captures フォルダに置いた
// 無関係なファイル（メモ、zip 等）を巻き込まないよう、扱う形式だけを対象にする。
const SWEEPABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.webm', '.mp4'])

export interface SweepCandidate {
  path: string
  mtimeMs: number
  size: number
}

// Windows は大文字小文字を区別しないため、DB の記録と実際の列挙で綴りが揺れても
// 同一視できるように正規化して突き合わせる。
function pathKey(p: string): string {
  return resolve(p).toLowerCase()
}

export function selectOrphans(
  candidates: SweepCandidate[],
  referenced: Iterable<string>,
  nowMs: number
): SweepCandidate[] {
  const keys = new Set<string>()
  for (const r of referenced) if (r) keys.add(pathKey(r))

  return candidates.filter((c) => {
    if (!SWEEPABLE_EXTENSIONS.has(extname(c.path).toLowerCase())) return false
    if (nowMs - c.mtimeMs < MIN_AGE_MS) return false
    return !keys.has(pathKey(c.path))
  })
}

async function collectFiles(dir: string): Promise<SweepCandidate[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []  // 未作成（キャプチャ0件の新規環境）は正常
  }

  const out: SweepCandidate[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await collectFiles(path))
      continue
    }
    if (!entry.isFile()) continue
    try {
      const st = await stat(path)
      out.push({ path, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // 列挙と stat の間に消えた等。次回起動で拾えばよい。
    }
  }
  return out
}

export async function sweepOrphanFiles(): Promise<{ removed: number; bytes: number }> {
  // 安全弁。DB が作り直された／壊れて空になった状態で走らせると、実ファイル全部が
  // 「参照されていない」と判定されてライブラリを丸ごと消し飛ばす。0 件なら何もしない。
  if (countImages() === 0) return { removed: 0, bytes: 0 }

  const referenced: string[] = []
  for (const row of listReferencedPaths()) {
    referenced.push(row.filepath)
    if (row.thumb_path) referenced.push(row.thumb_path)
  }

  const candidates = [
    ...await collectFiles(captureDir()),
    ...await collectFiles(thumbnailDir())
  ]
  const orphans = selectOrphans(candidates, referenced, Date.now())

  let removed = 0
  let bytes = 0
  for (const o of orphans) {
    try {
      await unlink(o.path)
      removed++
      bytes += o.size
    } catch (err) {
      console.warn('[sweep] failed to remove orphan', o.path, err)
    }
  }
  if (removed > 0) {
    console.log(`[sweep] removed ${removed} orphan file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB reclaimed`)
  }
  return { removed, bytes }
}
