// 画面へ渡したコマ情報（ClipFrames）のキャッシュ。ipc-video.ts から分けた。
// 表を書き換える側（verify-clip.ts）が捨てに来るので、ipc-video と verify-clip が互いを読み込む輪を
// 作らないよう、どちらからも読めるここに置く。
import type { ClipFrames } from '../../shared/api.video'

// コマ情報のキャッシュ（V-13）。同じ動画のトリマーを開き直すたびに全フレームを
// デコードする getVideoFramePts が再実行されるのを避ける。imageId 単位でキーする——
// 画像テーブルは AUTOINCREMENT で id を再利用せず、ある imageId のファイル内容は不変
// （トリムは新しい id を作る）なので、id をキーにすれば誤ヒットしない。
// 上限付き LRU（Map は挿入順を保持するので、先頭が最も古いアクセス）。
const clipFramesCache = new Map<number, ClipFrames>()
const CLIP_FRAMES_CACHE_MAX = 24

export function getCachedClipFrames(id: number): ClipFrames | undefined {
  const hit = clipFramesCache.get(id)
  if (hit) {
    clipFramesCache.delete(id)   // アクセスしたものを末尾（最新）へ回す
    clipFramesCache.set(id, hit)
  }
  return hit
}

// 表を書き換えたら捨てる。**キャッシュは開いた時点のスナップショット**で、検証（verify-clip）
// や起動時の見直し（recheckMarkedClips）が裏で表を書き換えても自分では気づかない。
// 捨てないと、印が付いた／外れたクリップを開いたまま古い並びで送り続けることになる。
export function invalidateClipFrames(id: number): void {
  clipFramesCache.delete(id)
}

export function setCachedClipFrames(id: number, frames: ClipFrames): void {
  clipFramesCache.delete(id)
  clipFramesCache.set(id, frames)
  while (clipFramesCache.size > CLIP_FRAMES_CACHE_MAX) {
    const oldest = clipFramesCache.keys().next().value
    if (oldest === undefined) break
    clipFramesCache.delete(oldest)
  }
}
