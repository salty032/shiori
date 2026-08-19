// 共有インポート（metadata.jsonl）の 1 行分の検証・正規化。DB/Electron の I/O を一切行わない
// 純関数として切り出し、ipc-share.ts のハンドラ内クロージャに埋め込まれていたテスト不能な
// バリデーションロジック（basename 等価チェック・拡張子・captured_at クランプ・タグ正規化）を
// 単体テスト可能にする（T-3）。ファイル存在チェック・コピー・DB登録は呼び出し元（ipc-share.ts）
// が担当する。
import { basename, extname } from 'path'
import { MAX_TAG_LENGTH, MAX_TEXT_LENGTH, normalizeTagName } from './ipc-validation'
import { MAX_MEMO_LENGTH } from '../../shared/constants'

export const SHARE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
export const SHARE_VIDEO_EXTS = new Set(['.webm', '.mp4'])

// 取り込んだ素材の captured_at は取り込み時刻にそろえ、metadata.jsonl の値は
// original_captured_at として別に持つ（詳細パネルに「元の取得時間」として出す）。
// そろえないと、他人からもらった素材が自分のキャプチャと日付順で混ざり、一覧のどこに
// 何が増えたのか分からなくなる。
//
// 元の値は手編集・破損で異常値（負値・極端な未来値等）が入りうるので、妥当な epoch 範囲
// （0〜2100年）から外れたものは「元は不明」として捨てる。並び順に使う captured_at は
// もう metadata.jsonl 由来ではないため、壊れた値でフォルダ名や並びが壊れることは無い。
const MAX_REASONABLE_CAPTURED_AT = new Date(2100, 0, 1).getTime()
export function isValidCapturedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < MAX_REASONABLE_CAPTURED_AT
}

interface RawShareEntry {
  version?: number
  file?: unknown
  thumb?: unknown
  url?: unknown
  current_time?: unknown
  title?: unknown
  tags?: unknown
  memo?: unknown
  captured_at?: unknown
  media_type?: unknown
  duration?: unknown
  fps?: unknown
  width?: unknown
  height?: unknown
  frame_table?: unknown
  frame_table_file?: unknown
  ambiguous_frames?: unknown
  unreported_frames?: unknown
}

// fps は表示用の付随情報であり、duration のような著作権対策の判定には使わない。
// 手編集された値を弾く必要は薄いが、明らかにおかしい値（負・非有限・現実的でない高値）を
// そのまま表示に出さないよう緩く検証する。
const MAX_REASONABLE_FPS = 120
const MAX_REASONABLE_DIMENSION = 16_384
// 30秒 × 対応上限120fpsでも数千行。壊れた共有データから巨大なJSON文字列を
// 二重にparseしてメモリを圧迫しないよう、1クリップ単位でも上限を持つ。
export const MAX_SHARE_FRAME_TABLE_BYTES = 2 * 1024 * 1024

function optionalPositiveInteger(value: unknown, max: number): number | null {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= max
    ? value as number
    : null
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    ? value as number
    : null
}

interface ParsedShareEntry {
  file: string
  ext: string
  thumbFile: string | null
  thumbExt: string | null
  // 取り込み時刻。captured_at はこれにそろえる（他人の素材が自分のキャプチャと日付順で
  // 混ざらないように）。
  capturedAt: number
  // metadata.jsonl に入っていた送り主側の取得時間。壊れた値・そもそも無い行では null。
  originalCapturedAt: number | null
  title: string | null
  currentTime: number | null
  url: string | null
  tags: string[]
  memo: string | null
  mediaType: 'image' | 'video'
  duration: number | null
  fps: number | null
  width: number | null
  height: number | null
  // DBの圧縮済みJSON文字列。構造検証はdecodeFramesを持つipc-share側で行う。
  frameTableData: string | null
  frameTableFile: string | null
  ambiguousFrames: number | null
  unreportedFrames: number | null
}

// 戻り値: 成功時は ParsedShareEntry、検証エラー時は { error }、file フィールドが
// そもそも無い行（新形式にない古いバージョン等）は元の実装と同じくエラー報告なしで null。
export function parseShareEntry(line: string, now: number): ParsedShareEntry | { error: string } | null {
  let entry: RawShareEntry
  try {
    const parsed: unknown = JSON.parse(line)
    // JSON.parse は "null" / "123" / "[]" のような非オブジェクトでも成功する。素通しすると
    // 直後の entry.file 参照が null で TypeError になり、ipc-share の取り込みループには
    // catch が無いため（finally のみ）、1行の破損でインポート全体が reject される。
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: `invalid entry: ${line.slice(0, 50)}` }
    }
    entry = parsed as RawShareEntry
  } catch {
    return { error: `invalid JSON: ${line.slice(0, 50)}` }
  }

  if (typeof entry.file !== 'string' || !entry.file) return null
  const safeFile = basename(entry.file)
  if (!safeFile || safeFile !== entry.file) return { error: `unsafe filename: ${entry.file}` }

  const ext = extname(safeFile).toLowerCase()
  const isVideo = SHARE_VIDEO_EXTS.has(ext)
  if (!SHARE_IMAGE_EXTS.has(ext) && !isVideo) return { error: `unsupported extension: ${safeFile}` }

  let thumbFile: string | null = null
  let thumbExt: string | null = null
  if (typeof entry.thumb === 'string' && entry.thumb) {
    const safeThumb = basename(entry.thumb)
    if (safeThumb && safeThumb === entry.thumb) {
      const candidateExt = extname(safeThumb).toLowerCase() || '.png'
      // サムネは常に画像（動画クリップのサムネも .png で保存される。video/ffmpeg.ts 参照）。
      if (SHARE_IMAGE_EXTS.has(candidateExt)) {
        thumbFile = safeThumb
        thumbExt = candidateExt
      }
    }
  }

  // 手動タグ追加と同じ正規化（小文字化・空白→_）を通す。ここを素通しすると、
  // 自前編集された共有データから "Tag Name" のような表記ゆれタグが作られてしまう。
  const tags = Array.isArray(entry.tags)
    ? [...new Set((entry.tags as unknown[]).map((t) => normalizeTagName(t, MAX_TAG_LENGTH)).filter((t): t is string => t != null))]
    : []

  return {
    file: safeFile,
    ext,
    thumbFile,
    thumbExt,
    capturedAt: now,
    originalCapturedAt: isValidCapturedAt(entry.captured_at) ? entry.captured_at : null,
    title: typeof entry.title === 'string' ? entry.title.slice(0, MAX_TEXT_LENGTH) || null : null,
    currentTime: typeof entry.current_time === 'number' && Number.isFinite(entry.current_time) ? entry.current_time : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    tags,
    memo: typeof entry.memo === 'string' ? entry.memo.slice(0, MAX_MEMO_LENGTH) || null : null,
    mediaType: isVideo ? 'video' : 'image',
    duration: isVideo && typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0
      ? entry.duration
      : null,
    fps: isVideo && typeof entry.fps === 'number' && Number.isFinite(entry.fps) && entry.fps > 0 && entry.fps <= MAX_REASONABLE_FPS
      ? entry.fps
      : null,
    width: optionalPositiveInteger(entry.width, MAX_REASONABLE_DIMENSION),
    height: optionalPositiveInteger(entry.height, MAX_REASONABLE_DIMENSION),
    frameTableData: isVideo && typeof entry.frame_table === 'string' && entry.frame_table.length <= MAX_SHARE_FRAME_TABLE_BYTES
      ? entry.frame_table
      : null,
    frameTableFile: isVideo && typeof entry.frame_table_file === 'string'
      && basename(entry.frame_table_file) === entry.frame_table_file
      && entry.frame_table_file.endsWith('.frames.json')
      ? entry.frame_table_file
      : null,
    ambiguousFrames: isVideo ? optionalNonNegativeInteger(entry.ambiguous_frames) : null,
    unreportedFrames: isVideo ? optionalNonNegativeInteger(entry.unreported_frames) : null,
  }
}
