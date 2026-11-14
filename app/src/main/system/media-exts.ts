// アプリが扱う画像・動画の拡張子。**一覧はここだけ**——表示してよいファイルの判定（paths.ts）・
// 片付けで消してよいファイルの判定（sweep-orphans.ts）・取り込み（ipc-import.ts）・共有の読み込み
// （share-entry.ts）が別々に持っていた頃は、取り込みにだけ形式を足すと「取り込めるのに表示されない」
// 素材が黙ってできた。
export const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
export const VIDEO_EXTS: ReadonlySet<string> = new Set(['.webm', '.mp4'])
export const MEDIA_EXTS: ReadonlySet<string> = new Set([...IMAGE_EXTS, ...VIDEO_EXTS])

// 取り込み（ipc-import.ts）・共有の読み込み（ipc-share.ts）で受け入れるファイル 1 つの上限。
// 別々に書くと、同じファイルが片方では入り、もう片方では「大きすぎる」で弾かれる。
export const MAX_MEDIA_FILE_BYTES = 500 * 1024 * 1024
