import { app } from 'electron'
import { mkdir, realpath, stat } from 'fs/promises'
import { realpathSync } from 'fs'
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { loadSettings } from './settings'

// 既定の置き場所。**保存先を変えても、ここは常に「開いてよい場所」に残す**——
// 変える前に撮ったものはここにあり、記録しているのは絶対パスなので、外すと開けなくなる。
export function defaultCaptureDir(): string {
  return join(app.getPath('userData'), 'captures')
}

// これから撮るものを書く場所。設定で変えられる（設定 > データ > 保存場所）。
// 静止画も録画もここに入る。**既存のファイルは移動しない**——変更後も元の場所から
// そのまま読める（allowedBases が過去の保存先も許可している）。
export function captureDir(): string {
  return loadSettings().captureRoot ?? defaultCaptureDir()
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
// これから撮るものを書ける状態か。**撮る前に見る。**
//
// 保存先には外付けドライブも選べる。抜けている状態で撮ると保存の書き込みで失敗し、
// 画面には「キャプチャに失敗しました」としか出ない——原因が保存先だとは読めず、
// もう一度押しても同じことが起きる。録画に至っては、30 秒撮り終えた後にそれが分かる。
//
// 見るのはフォルダに届くかどうかだけ（stat 1 回）。**ホットキーの経路に入るので重くできない。**
// 書き込みの権限そのものは、保存先を選んだときに実際に 1 ファイル書いて確かめている
// （ipc-shell.ts）ので、ここで見たいのは「その後にドライブが抜けたか」の 1 点。
//
// 既定の場所（userData 配下）は、アプリが動いている以上そこにあるので見ない。
export async function captureRootReachable(): Promise<boolean> {
  const root = loadSettings().captureRoot
  if (!root) return true
  try {
    return (await stat(root)).isDirectory()
  } catch {
    return false
  }
}

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

// 保存先に選んでよいフォルダか。問題が無ければ null。
//
// **許可ベースを広げすぎないための判定。** 保存先の配下は「IPC から開いてよい場所」に
// なるので、ドライブ直下や userData の上位を選ばれると、その下の何もかもが対象になる。
// 選んだ人に悪意が無くても、境界としては意味を失う。
export function captureRootProblem(dir: string): 'not-absolute' | 'filesystem-root' | 'contains-app-data' | null {
  if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir)) return 'not-absolute'
  const target = resolve(dir)
  if (target === parse(target).root) return 'filesystem-root'
  if (isChildPath(target, resolve(app.getPath('userData')))) return 'contains-app-data'
  return null
}

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.webm', '.mp4'])

// 原本と表示用サムネの両方を許可ベースとする。
//
// **原本の側は 1 つではない。** 保存先は変えられるので、既定の場所・いま使っている場所・
// 過去に使った場所のどれにも既存のファイルが残っている。記録しているのは絶対パスなので、
// 使っている場所だけを許可すると、変えた瞬間にそれまでの素材が 1 枚も開けなくなる。
function captureBases(): string[] {
  const settings = loadSettings()
  const roots = [defaultCaptureDir(), ...(settings.captureRoot ? [settings.captureRoot] : []), ...settings.previousCaptureRoots]
  return [...new Set(roots.map((root) => resolve(root)))]
}

function allowedBases(): string[] {
  return [...captureBases(), resolve(thumbnailDir())]
}

export function resolveCapturePath(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null

  const target = resolve(candidate)
  if (!allowedBases().some((base) => isChildPath(base, target))) return null
  if (!ALLOWED_EXTENSIONS.has(extname(target).toLowerCase())) return null
  return target
}

// 許可ベースの realpath 解決結果をキャッシュする。サムネ読み込みのたびに同じ realpath
// （ファイル本体の解決とは別）を引き直していたのを避ける。**パス文字列をキーにする**ので、
// 保存先が実行中に変わっても取り違えない（変わるのは見るキーの方）。未作成ディレクトリは
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
    const bases = [...captureBases(), thumbnailDir()].map(resolveRealBaseSync)
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
    const bases = await Promise.all([...captureBases(), thumbnailDir()].map(resolveRealBase))
    if (!bases.some((b) => b !== null && isChildPath(b, realTarget))) return null
    if (!ALLOWED_EXTENSIONS.has(extname(realTarget).toLowerCase())) return null
    return realTarget
  } catch {
    return null
  }
}
