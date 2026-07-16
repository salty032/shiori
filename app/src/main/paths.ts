import { app } from 'electron'
import { mkdir, realpath } from 'fs/promises'
import { realpathSync } from 'fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'

export function captureDir(): string {
  return join(app.getPath('userData'), 'captures')
}

// captureDir 直下に全ファイルをフラット格納すると、数万件規模で Explorer や
// バックアップ/同期ソフトのフォルダ列挙が重くなる。撮影日時（年月）でサブフォルダに
// 分散させる。ファイル名自体が cap_${timestamp}_${uuid} で全体一意なので、
// サムネ側（thumbPathFor の basename キー）には影響しない。
function captureSubDir(capturedAtMs: number): string {
  const d = new Date(capturedAtMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return join(captureDir(), `${y}-${m}`)
}

// 書き込み先の年月サブフォルダを作成して返す。新規キャプチャ/インポート/エクスポートの
// 保存はすべてこれを経由する。既存ファイルは移動しない（フラット直下に残ったままで
// 引き続き読める。resolveCapturePath は captureDir 配下を再帰的に許可している）。
export async function ensureCaptureSubDir(capturedAtMs: number): Promise<string> {
  const dir = captureSubDir(capturedAtMs)
  await mkdir(dir, { recursive: true })
  return dir
}

// 表示用の軽量サムネイルは原本（captureDir）と物理的に分離する。
// 再生成可能なキャッシュなので「サムネだけ全消し」「原本だけバックアップ」が安全にできる。
export function thumbnailDir(): string {
  return join(app.getPath('userData'), 'thumbnails')
}

// 原本パスから対応するサムネイルパス（thumbnailDir 配下）を導く。
// 原本のファイル名は captureDir 内で一意なので、basename をキーにすれば衝突しない。
export function thumbPathFor(originalPath: string, ext = '.jpg'): string {
  const stem = basename(originalPath).replace(/\.[^.]+$/, '')
  return join(thumbnailDir(), `${stem}_t${ext}`)
}

function isChildPath(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// 画像専用ビルド。動画(.webm/.mp4)は取り込みも表示も行わないため許可しない。
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

// 原本（captureDir）と表示用サムネ（thumbnailDir）の両方を許可ベースとする。
function allowedBases(): string[] {
  return [resolve(captureDir()), resolve(thumbnailDir())]
}

export function resolveCapturePath(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null

  const target = resolve(candidate)
  if (!allowedBases().some((base) => isChildPath(base, target))) return null
  if (!ALLOWED_EXTENSIONS.has(extname(target).toLowerCase())) return null
  return target
}

// captureDir/thumbnailDir は userData 配下の固定パスで実行中に変わらないため、
// realpath 解決結果をキャッシュする。サムネ読み込みのたびに同じ2回の realpath
// （ファイル本体の解決とは別）を引き直していたのを避ける。未作成ディレクトリは
// 失敗時にキャッシュせず、作成後の呼び出しで再解決できるようにする。
const realBaseCache = new Map<string, string>()

async function resolveRealBase(dir: string): Promise<string | null> {
  const cached = realBaseCache.get(dir)
  if (cached) return cached
  try {
    const real = resolve(await realpath(dir))
    realBaseCache.set(dir, real)
    return real
  } catch {
    return null
  }
}

function resolveRealBaseSync(dir: string): string | null {
  const cached = realBaseCache.get(dir)
  if (cached) return cached
  try {
    const real = resolve(realpathSync(dir))
    realBaseCache.set(dir, real)
    return real
  } catch {
    return null
  }
}

// resolveRealCapturePath の同期版。ドラッグ開始（webContents.startDrag）は dragstart の
// 同期的な流れの中で呼ばないと OS のドラッグループに入れず、await を1つでも挟むと
// ドラッグが始まらないため、その経路でだけ使う（ipc-drag.ts）。それ以外は非同期版を使うこと。
export function resolveRealCapturePathSync(candidate: unknown): string | null {
  const target = resolveCapturePath(candidate)
  if (!target) return null

  try {
    const realTarget = resolve(realpathSync(target))
    const bases = [captureDir(), thumbnailDir()].map(resolveRealBaseSync)
    if (!bases.some((b) => b !== null && isChildPath(b, realTarget))) return null
    if (!ALLOWED_EXTENSIONS.has(extname(realTarget).toLowerCase())) return null
    return realTarget
  } catch {
    return null
  }
}

export async function resolveRealCapturePath(candidate: unknown): Promise<string | null> {
  const target = resolveCapturePath(candidate)
  if (!target) return null

  try {
    const realTarget = resolve(await realpath(target))
    const bases = await Promise.all([captureDir(), thumbnailDir()].map(resolveRealBase))
    if (!bases.some((b) => b !== null && isChildPath(b, realTarget))) return null
    if (!ALLOWED_EXTENSIONS.has(extname(realTarget).toLowerCase())) return null
    return realTarget
  } catch {
    return null
  }
}
