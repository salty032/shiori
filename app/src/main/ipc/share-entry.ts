// 共有インポート（metadata.jsonl）の 1 行分の検証・正規化。DB/Electron の I/O を一切行わない
// 純関数として切り出し、ipc-share.ts のハンドラ内クロージャに埋め込まれていたテスト不能な
// バリデーションロジック（basename 等価チェック・拡張子・captured_at クランプ・タグ正規化）を
// 単体テスト可能にする（T-3）。ファイル存在チェック・コピー・DB登録は呼び出し元（ipc-share.ts）
// が担当する。
import { basename, extname } from 'path'
import { MAX_TAG_LENGTH, MAX_TEXT_LENGTH, normalizeTagName } from './ipc-validation'
import { MAX_MEMO_LENGTH } from '../../shared/constants'
import { IMAGE_EXTS, VIDEO_EXTS } from '../system/media-exts'
import type { ImageRow, LibraryImportMode } from '../../shared/types'


// 読み込み方は取り込む人が選ぶ（ImportMode）。
// 受け取った素材として取り込むときは、captured_at を取り込み時刻にそろえ、元の撮影時刻は
// original_captured_at として別に持つ（画面には出していない）。そろえないと、他人からもらった素材が
// 自分のキャプチャと日付順で混ざり、一覧のどこに何が増えたのか分からなくなる。
// 自分のライブラリとして戻すときは、書き出したときの日時と「撮った／取り込んだ」をそのまま戻す。
//
// 元の値は手編集・破損で異常値（負値・極端な未来値等）が入りうるので、妥当な epoch 範囲
// （0〜2100年）から外れたものは「元は不明」として捨てる。並び順に使う captured_at は
// もう metadata.jsonl 由来ではないため、壊れた値でフォルダ名や並びが壊れることは無い。
const MAX_REASONABLE_CAPTURED_AT = new Date(2100, 0, 1).getTime()
export function isValidCapturedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < MAX_REASONABLE_CAPTURED_AT
}

// metadata.jsonl の 1 行の形。**書く側（buildShareEntry）と読む側（parseShareEntry）はこの型 1 つを使う。**
// 別々に持つと、片方だけ項目を変えても verify が通ったまま取り込みで黙って落ちる。
export interface ShareEntry {
  version: 2
  file: string
  thumb?: string
  url: string | null
  current_time: number | null
  title: string | null
  tags: string[]
  memo: string | null
  captured_at: number
  // 書き出した人が自分で撮ったか、取り込んだか。無い行（古い版の書き出し）は撮ったものだけだった。
  origin?: 'capture' | 'import'
  // 取り込んだ素材の元の撮影時刻（書き出した人のライブラリの original_captured_at）。
  original_captured_at?: number
  width?: number
  height?: number
  media_type?: 'video'
  // 取り込み側は使わない（尺は実体から測り直す。手編集で 30 秒上限を抜けられないように）。
  duration?: number | null
  fps?: number | null
  frame_table_file?: string
  ambiguous_frames?: number | null
  // 取り込み側は使わない（抜けは受け取った表から数え直す。restoredFrameCounts）。
  unreported_frames?: number | null
  // 手で打ったタイムシート（timesheets の data と同じ形）。**コマの表を一緒に書き出せたときだけ持つ**——
  // 打った位置は表の何行目かで覚えているので、表が無いとどのコマに打ったのか分からない。
  timesheet?: string
}

// 読む側はどの項目も壊れている前提で受ける。frame_table は古い版がコマ表を行の中に入れていた頃の項目。
type RawShareEntry = { [K in keyof ShareEntry]?: unknown } & { frame_table?: unknown }

// 撮った素材も取り込んだ素材も書き出す。どちらだったか（origin）と元の撮影時刻を一緒に書き、
// 戻すときにライブラリをエクスポートしたときのままにできるようにする。
export function buildShareEntry(
  item: Pick<ImageRow,
    'url' | 'current_time' | 'title' | 'memo' | 'captured_at' | 'original_captured_at' | 'source' | 'width' | 'height' |
    'media_type' | 'duration' | 'fps' | 'ambiguous_frames' | 'unreported_frames'> & { manualTags: string[] },
  files: { file: string; thumb: string | null; frameTable: string | null; timesheet: string | null }
): ShareEntry {
  return {
    version: 2,
    file: files.file,
    ...(files.thumb ? { thumb: files.thumb } : {}),
    url: item.url,
    current_time: item.current_time,
    title: item.title,
    tags: item.manualTags,
    memo: item.memo,
    captured_at: item.captured_at,
    origin: item.source,
    ...(item.original_captured_at != null ? { original_captured_at: item.original_captured_at } : {}),
    ...(item.width != null ? { width: item.width } : {}),
    ...(item.height != null ? { height: item.height } : {}),
    ...(item.media_type === 'video' ? {
      media_type: 'video' as const,
      duration: item.duration,
      fps: item.fps,
      ...(files.frameTable ? { frame_table_file: files.frameTable } : {}),
      ambiguous_frames: item.ambiguous_frames ?? null,
      unreported_frames: item.unreported_frames ?? null,
      ...(files.frameTable && files.timesheet ? { timesheet: files.timesheet } : {}),
    } : {}),
  }
}

// fps は表示用の付随情報であり、duration のような著作権対策の判定には使わない。
// 手編集された値を弾く必要は薄いが、明らかにおかしい値（負・非有限・現実的でない高値）を
// そのまま表示に出さないよう緩く検証する。
const MAX_REASONABLE_FPS = 120
const MAX_REASONABLE_DIMENSION = 16_384
// 30秒 × 対応上限120fpsでも数千行。壊れた共有データから巨大なJSON文字列を
// 二重にparseしてメモリを圧迫しないよう、1クリップ単位でも上限を持つ。
export const MAX_SHARE_FRAME_TABLE_BYTES = 2 * 1024 * 1024
// タイムシートは 1 クリップ数百組。壊れた・手編集された巨大な文字列を読まないための上限。
export const MAX_SHARE_TIMESHEET_BYTES = 512 * 1024

function positiveIntegerUpTo(value: unknown, max: number): number | null {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= max
    ? value as number
    : null
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    ? value as number
    : null
}

export type ImportMode = LibraryImportMode

interface ParsedShareEntry {
  file: string
  ext: string
  thumbFile: string | null
  thumbExt: string | null
  // 一覧の並びに使う時刻。受け取るときは取り込み時刻、戻すときは書き出したときの値（壊れていれば取り込み時刻）。
  capturedAt: number
  // 元の撮影時刻。受け取るときは送り主側でいちばん元の時刻、戻すときは書き出したときの original_captured_at。
  // 壊れた値・そもそも無い行では null。
  originalCapturedAt: number | null
  // 登録するときの種類。受け取るときは常に取り込み、戻すときは書き出したときのまま。
  source: 'capture' | 'import'
  title: string | null
  currentTime: number | null
  url: string | null
  tags: string[]
  memo: string | null
  mediaType: 'image' | 'video'
  fps: number | null
  width: number | null
  height: number | null
  // DBの圧縮済みJSON文字列。構造検証はdecodeFramesを持つipc-share側で行う。
  frameTableData: string | null
  frameTableFile: string | null
  ambiguousFrames: number | null
  // timesheets の data と同じ形の文字列。中身の検証は decodeTimesheet（呼び出し側）が行う。
  timesheetData: string | null
}

// 戻り値: 成功時は ParsedShareEntry、検証エラー時は { error }、file フィールドが
// そもそも無い行（新形式にない古いバージョン等）は元の実装と同じくエラー報告なしで null。
export function parseShareEntry(line: string, now: number, mode: ImportMode = 'receive'): ParsedShareEntry | { error: string } | null {
  let entry: RawShareEntry
  try {
    const parsed: unknown = JSON.parse(line)
    // JSON.parse は "null" / "123" / "[]" のような非オブジェクトでも成功する。素通しすると
    // 直後の entry.file 参照が null で TypeError になる（取り込みループに catch が無かった頃は、
    // 1行の破損でインポート全体が止まった）。行ごとの理由として返す。
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
  const isVideo = VIDEO_EXTS.has(ext)
  if (!IMAGE_EXTS.has(ext) && !isVideo) return { error: `unsupported extension: ${safeFile}` }

  let thumbFile: string | null = null
  let thumbExt: string | null = null
  if (typeof entry.thumb === 'string' && entry.thumb) {
    const safeThumb = basename(entry.thumb)
    if (safeThumb && safeThumb === entry.thumb) {
      const candidateExt = extname(safeThumb).toLowerCase() || '.png'
      // サムネは常に画像（動画クリップのサムネも .png で保存される。video/ffmpeg.ts 参照）。
      if (IMAGE_EXTS.has(candidateExt)) {
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

  const sentCapturedAt = isValidCapturedAt(entry.captured_at) ? entry.captured_at : null
  const sentOriginal = isValidCapturedAt(entry.original_captured_at) ? entry.original_captured_at : null
  const restore = mode === 'restore'

  return {
    file: safeFile,
    ext,
    thumbFile,
    thumbExt,
    capturedAt: restore ? sentCapturedAt ?? now : now,
    originalCapturedAt: restore ? sentOriginal : sentOriginal ?? sentCapturedAt,
    source: restore ? (entry.origin === 'import' ? 'import' : 'capture') : 'import',
    title: typeof entry.title === 'string' ? entry.title.slice(0, MAX_TEXT_LENGTH) || null : null,
    currentTime: typeof entry.current_time === 'number' && Number.isFinite(entry.current_time) ? entry.current_time : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    tags,
    memo: typeof entry.memo === 'string' ? entry.memo.slice(0, MAX_MEMO_LENGTH) || null : null,
    mediaType: isVideo ? 'video' : 'image',
    fps: isVideo && typeof entry.fps === 'number' && Number.isFinite(entry.fps) && entry.fps > 0 && entry.fps <= MAX_REASONABLE_FPS
      ? entry.fps
      : null,
    width: positiveIntegerUpTo(entry.width, MAX_REASONABLE_DIMENSION),
    height: positiveIntegerUpTo(entry.height, MAX_REASONABLE_DIMENSION),
    frameTableData: isVideo && typeof entry.frame_table === 'string' && entry.frame_table.length <= MAX_SHARE_FRAME_TABLE_BYTES
      ? entry.frame_table
      : null,
    frameTableFile: isVideo && typeof entry.frame_table_file === 'string'
      && basename(entry.frame_table_file) === entry.frame_table_file
      && entry.frame_table_file.endsWith('.frames.json')
      ? entry.frame_table_file
      : null,
    ambiguousFrames: isVideo ? optionalNonNegativeInteger(entry.ambiguous_frames) : null,
    timesheetData: isVideo && typeof entry.timesheet === 'string' && entry.timesheet.length <= MAX_SHARE_TIMESHEET_BYTES
      ? entry.timesheet
      : null,
  }
}
