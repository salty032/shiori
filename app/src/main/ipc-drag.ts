// 画像を他アプリ（エクスプローラ・Discord・画像編集ソフト等）へドラッグ&ドロップで
// 渡すための webContents.startDrag ハンドラ。
//
// この経路が他の IPC と違う点が2つある。
//
// 1) invoke ではなく send（onTrusted）を使う。startDrag は renderer の dragstart から
//    途切れずに呼ばれて初めて OS のドラッグループに入る。invoke は Promise を挟むので、
//    応答を待つ間にドラッグのジェスチャが切れてしまい、何も起きない。
// 2) 全ての I/O が同期（*Sync）。同じ理由で await を1つでも挟むとドラッグが始まらない。
//    メインプロセスを数ms止めることになるが、対象は MAX_DRAG_FILES 枚までに絞っている。
import { app, nativeImage } from 'electron'
import { copyFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getImage } from './db'
import { resolveRealCapturePathSync } from './paths'
import { onTrusted, sendToRenderer } from './windows'
import {
  sanitizeFilename, formatDateForFilename, formatTimecodeForFilename, optionalPositiveInteger
} from './ipc-validation'
import { CH } from '../shared/api'

// ドラッグ開始は同期コピーでメインプロセスを止めるため、選択が数千枚でも
// 現実的な時間で返せる枚数に制限する。超過分は黙って切り捨てる（ドラッグの
// 最中にダイアログやトーストを出す術がないため）。
const MAX_DRAG_FILES = 50
// 枚数上限だけだと大きな画像が50枚集まると同期コピーがメインプロセスを長時間ブロックしうる
// （PERF-2）。累積バイト数でも打ち切る。最低1枚は必ずコピーする（空ドラッグにしない）。
const MAX_DRAG_BYTES = 100 * 1024 * 1024

// 原本（captureDir）のパスをそのまま startDrag に渡すと、エクスプローラの同一ドライブ内への
// ドロップが「移動」既定になり、ライブラリから実ファイルが消えて DB にゴースト行が残る。
// ユーザーから見れば「ドラッグしたら画像が壊れた」という復旧不能な事故なので、毎回 temp へ
// 複製を作り、その複製だけを OS に渡す。複製が移動されても原本は無傷。
function dragTempDir(): string {
  return join(app.getPath('temp'), 'shiori-drag')
}

// 前回のドラッグで作った複製を捨ててから作り直す。ドロップ先はドロップ時点でファイルを
// 読み切る（コピー/アップロード）ため、次のドラッグまで残っていれば十分。
function resetDragTempDir(): string {
  const dir = dragTempDir()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    // 消せなくても致命的ではない（下の uniqueName で衝突を避ける）
    console.warn('[drag] temp cleanup failed', err)
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

// このパスが「ドラッグのために自分で作った複製」かどうか。Shiori からドラッグした画像を
// Shiori 自身のウィンドウへ落とし返すと、取り込み（ipc-import.ts）から見れば
// ただの画像ファイルのドロップと区別が付かず、同じ画像が二重に増えてしまう。
// 複製は必ずこの temp 配下にしか置かないので、パスで判別できる。
export function isDragTempPath(candidate: string): boolean {
  const rel = relative(dragTempDir(), resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function cleanupDragTempDir(): void {
  try {
    rmSync(dragTempDir(), { recursive: true, force: true })
  } catch (err) {
    console.warn('[drag] temp cleanup on quit failed', err)
  }
}

function uniqueName(used: Set<string>, preferred: string): string {
  const ext = extname(preferred)
  const base = preferred.slice(0, preferred.length - ext.length)
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`
    const key = name.toLowerCase()
    if (!used.has(key)) {
      used.add(key)
      return name
    }
  }
}

// 他アプリに落ちたときのファイル名。エクスポート（images:export）と同じ規則にして、
// 「ドラッグで出した画像」と「エクスポートした画像」の名前が食い違わないようにする。
function dragFileName(
  image: { title: string | null; captured_at: number; current_time: number | null },
  srcPath: string,
): string {
  const baseTitle = sanitizeFilename(image.title || 'capture')
  const datePart = formatDateForFilename(image.captured_at)
  const timePart = formatTimecodeForFilename(image.current_time)
  const ext = extname(srcPath) || '.png'
  return `${baseTitle}_${datePart}${timePart ? `_t${timePart}` : ''}${ext}`
}

export function registerDragHandlers(): void {
  onTrusted(CH.imagesStartDrag, (event, ids: unknown) => {
    const uniqueIds = Array.isArray(ids)
      ? [...new Set(ids.map(optionalPositiveInteger).filter((id): id is number => id != null))]
      : []
    const imageIds = uniqueIds.slice(0, MAX_DRAG_FILES)
    if (imageIds.length === 0) return

    let dir: string
    try {
      dir = resetDragTempDir()
    } catch (err) {
      console.error('[drag] temp dir unavailable', err)
      return
    }

    const files: string[] = []
    const used = new Set<string>()
    // ドラッグ中のカーソルに出すアイコン。先頭画像のサムネを使う。
    let iconPath: string | null = null
    let totalBytes = 0

    for (const id of imageIds) {
      const image = getImage(id)
      if (!image) continue
      const src = resolveRealCapturePathSync(image.filepath)
      if (!src) continue
      try {
        const size = statSync(src).size
        // 1枚もまだ入っていなければ、それ単体で上限を超えていても諦めずコピーする
        // （空ドラッグより「1枚だけ渡る」方が実害が小さい）。
        if (files.length > 0 && totalBytes + size > MAX_DRAG_BYTES) break
        const dest = join(dir, uniqueName(used, dragFileName(image, src)))
        copyFileSync(src, dest)
        totalBytes += size
        files.push(dest)
        if (!iconPath) iconPath = resolveRealCapturePathSync(image.thumb_path) ?? src
      } catch (err) {
        console.warn(`[drag] copy failed id=${id} (skipped)`, err)
      }
    }
    if (files.length === 0) return

    // 枚数上限・バイト上限・個別コピー失敗のいずれかで一部が渡らなかった場合に知らせる（UX-6）。
    // OSドラッグ中はダイアログ/トーストを出せないため、ドロップ完了後にまとめて通知する。
    if (files.length < uniqueIds.length) {
      sendToRenderer(CH.imagesDragTruncated, { requested: uniqueIds.length, copied: files.length })
    }

    // Windows では空の NativeImage を渡すと startDrag が throw する。サムネ欠損・破損時の
    // フォールバックとしてアプリアイコンを使い、それも読めなければドラッグ自体を諦める
    // （アイコンなしで開始する手段がないため）。
    let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
    if (icon.isEmpty()) icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.ico'))
    if (icon.isEmpty()) {
      console.warn('[drag] no usable drag icon; aborted')
      return
    }
    // 実寸のサムネ（数百px）のままだとカーソルに対して大きすぎるので縮める。
    const dragIcon = icon.resize({ height: 96 })

    try {
      // 型定義上 file は必須だが、files があれば Electron 側はそちらを優先する。
      event.sender.startDrag({ file: files[0], files, icon: dragIcon.isEmpty() ? icon : dragIcon })
    } catch (err) {
      console.error('[drag] startDrag failed', err)
    }
  })
}
