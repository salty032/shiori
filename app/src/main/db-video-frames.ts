// 録画クリップのフレーム表（video_frames）。db.ts から切り出した。
// **触る前に docs/ANIME-FRAMES.md を読むこと。** 禁止事項が書いてある。
//
// 素材の1コマごとに「素材上の時刻」と「ファイル内の何枚目に写っているか」を持つ。
// これがあるとコマ送りを素材の実コマ単位で動かせる（無い場合はファイルのフレームを
// そのまま辿るため、素材のコマとは対応しない）。
//
// captured=false は「そのコマ専用の絵が無く、直前のコマの絵を流用している」印。
// 画面キャプチャの供給が素材のコマ数の2倍に届かないと発生する。24fps 素材では供給が足りる
// ようになった（recorder.ts の startCaptureTicker、実測 100%）が、30/60fps 素材や高負荷時は
// 依然足りない。絵の変わり目に当たるとコマ打ちの数を誤るため、黙って潰さず印として残す。
//
// verified は撮り逃したコマ（captured=false）を録画後に検証した結果（frame-verify.ts）。
//   'unknown' … 未検証（保存直後・検証失敗・従来の行）
//   'same'    … 前後のキャプチャで絵が変わっていない。流用は正しく、実害が無いと確定
//   'changed' … 前後で絵が変わっている。どのコマで変わったかは特定できない＝要確認
// captured=true のコマでは意味を持たない（常に 'unknown'）。
import { getDb, prepare } from './db-core'
import { setFrameCounts } from './db'
import { countReportDrops } from './video/frame-feed'

export type FrameVerify = 'unknown' | 'same' | 'changed'

export interface StoredFrame {
  mediaTime: number
  frameIndex: number
  captured: boolean
  verified?: FrameVerify
  /**
   * frameIndex が指すファイル内フレームが、この素材コマとは限らない。
   *
   * **表全体を捨てる代わりに、ずれた行にだけ立てる印。** 以前は途中で対応が崩れると表を
   * 丸ごと使わなくしていたが、崩れた位置より手前は正しいので、そこまで失うのは割に合わない
   * （docs/ANIME-FRAMES.md 0 章）。立っているコマだけ画面で赤く出す。
   */
  misaligned?: boolean
}

// 直列化時のコード。文字列をそのまま並べると1クリップ千数百要素ぶん嵩む。
const VERIFY_CODE: Record<FrameVerify, number> = { unknown: 0, same: 1, changed: 2 }
const VERIFY_NAME: FrameVerify[] = ['unknown', 'same', 'changed']

// 直列化は DB アクセスから切り離した純粋関数にする。better-sqlite3 は Electron の ABI で
// ビルドされ素の Node からは読めないため、実 DB を張るテストが書けない。壊れると
// コマ送りが静かに従来動作へ落ちる箇所なので、ここだけでも検証できる形にしておく。
//
// 配列の配列で持つ。1クリップで千数百要素になるため、キー名を繰り返さない。
// 4 要素目（検証結果）と 5 要素目（対応のずれ）は後から足したもの。3 要素しか無い古い行も
// 読めるようにしてあるため（decodeFrames の length チェックは >= 3 のまま）、既存のクリップは
// 未検証・ずれなしとして扱われる。
export function encodeFrames(frames: StoredFrame[]): string {
  return JSON.stringify(frames.map((f) => [
    f.mediaTime, f.frameIndex, f.captured ? 1 : 0, VERIFY_CODE[f.verified ?? 'unknown'], f.misaligned ? 1 : 0
  ]))
}

// 「検証の結果、使ってはいけないと決めた表」の印。**表そのものは中に丸ごと残す**
// （markVideoFramesUnusable のコメント参照。判定を直したときに遡って救うため）。
//
// 印の付いた行は decodeFrames が null を返す。配列でない形は元から null なので、
// 読み出し側は 1 行も変えずに「表が無い」と同じ扱いになる。**この性質に頼っているので、
// decodeFrames の入口で配列かどうかを見るのをやめてはいけない**（video-frames.test.ts が固定）。
interface UnusableRow {
  unusable: string
  frames: unknown
}

export function encodeUnusable(data: string, reason: string): string {
  const row: UnusableRow = { unusable: reason, frames: JSON.parse(data) }
  return JSON.stringify(row)
}

// 印の中に残してある表を取り出す。**救済専用の入口**——通常の読み出し（decodeFrames）は
// 印が付いていれば必ず null を返す必要があるので、そちらとは別にしてある。
export function readUnusableFrames(data: string): StoredFrame[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const frames = (parsed as { frames?: unknown }).frames
  return frames === undefined ? null : decodeFrames(JSON.stringify(frames))
}

// 見直しに使った判定の版。**判定を直したら上げる。** 上げると、前の版で印を付けたまま
// 救えなかったクリップが起動後にもう一度見直される（recheckUnusableClips）。
// 2: 表全体の採否をやめ、ずれた行にだけ印を立てる形へ（2026-08-26）。
//    版 1 で「救えない」と判定したクリップにも、使える行が残っていることがある。
// 3: 単発の印を無視するようにした（2026-08-26）。版 2 は撮影間隔の揺らぎで 1 コマだけ
//    立つ印を関係ない場所に散らしていた。
export const RECHECK_VERSION = 3

// 印付きの表のうち、まだこの版で見直していないものを列挙する。
export function listUnusableForRecheck(): RecheckTarget[] {
  const rows = prepare(
    'SELECT v.image_id AS imageId, v.data AS data, i.filepath AS filepath, i.captured_at AS capturedAt' +
    ' FROM video_frames v JOIN images i ON i.id = v.image_id'
  ).all() as { imageId: number; data: string; filepath: string; capturedAt: number | null }[]
  const out: RecheckTarget[] = []
  for (const row of rows) {
    if (!readUnusableReason(row.data)) continue
    if (readRecheckedWith(row.data) >= RECHECK_VERSION) continue
    const frames = readUnusableFrames(row.data)
    if (frames && row.filepath) {
      out.push({ imageId: row.imageId, filepath: row.filepath, frames, capturedAt: row.capturedAt })
    }
  }
  return out
}

export interface RecheckTarget {
  imageId: number
  filepath: string
  frames: StoredFrame[]
  /** ログに出す撮影時刻。**番号だけでは、どの録画のことか画面から探せない。** */
  capturedAt: number | null
}

function readRecheckedWith(data: string): number {
  try {
    const parsed = JSON.parse(data) as { recheckedWith?: unknown }
    return typeof parsed?.recheckedWith === 'number' ? parsed.recheckedWith : 0
  } catch {
    return 0
  }
}

// 見直したが救えなかった。**同じ版では二度と見直さない**（1 本ごとにフル デコードが要るため）。
export function markRechecked(id: number): void {
  const row = prepare('SELECT data FROM video_frames WHERE image_id = ?').get(id) as { data: string } | undefined
  if (!row) return
  try {
    const parsed = JSON.parse(row.data)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    parsed.recheckedWith = RECHECK_VERSION
    prepare('UPDATE video_frames SET data = ? WHERE image_id = ?').run(JSON.stringify(parsed), id)
  } catch {
    // 壊れた行は触らない（表が無いものとして扱われるだけで害が無い）
  }
}

// 印が付いていればその理由、付いていなければ null（＝通常の表・壊れた行）。
export function readUnusableReason(data: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const reason = (parsed as { unusable?: unknown }).unusable
  return typeof reason === 'string' && reason.length > 0 ? reason : null
}

// 壊れた行・想定外の形は null（＝表が無い）として扱い、従来のフレーム走査へ退避させる。
// 半端に解釈してコマ送りが不可解に狂うより、精度を諦めて動く方がよい。
export function decodeFrames(data: string): StoredFrame[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const out: StoredFrame[] = []
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length < 3) return null
    const [mediaTime, frameIndex, captured] = item
    if (typeof mediaTime !== 'number' || !Number.isFinite(mediaTime)) return null
    if (!Number.isInteger(frameIndex) || frameIndex < 0) return null
    // 検証結果は補助情報なので、見慣れないコードが入っていても表ごと捨てはしない
    // （コマ送りの土台である mediaTime/frameIndex まで巻き添えで失う方が損失が大きい）。
    // 未検証として扱えば、表示は「検証していない」に落ちるだけで嘘にはならない。
    const verified = item.length >= 4 ? VERIFY_NAME[item[3] as number] ?? 'unknown' : 'unknown'
    // 印が立っているときだけ持たせる（false を詰めない）。**大多数の行には無い情報**で、
    // 付けて回ると既存の比較・保存経路が「別物」として扱いはじめる。
    const misaligned = item.length >= 5 && item[4] === 1
    out.push({ mediaTime, frameIndex, captured: captured === 1, verified, ...(misaligned ? { misaligned } : {}) })
  }
  return out
}

export function saveVideoFrames(imageId: number, frames: StoredFrame[]): void {
  if (frames.length === 0) return
  prepare('INSERT OR REPLACE INTO video_frames (image_id, data) VALUES (?, ?)').run(imageId, encodeFrames(frames))
}

export function restoredFrameCounts(
  frames: StoredFrame[],
  counts: { ambiguous: number | null }
): { uncaptured: number; ambiguous: number | null; sourceFrames: number; unreported: number; misaligned: number } {
  return {
    uncaptured: frames.filter((frame) => !frame.captured).length,
    sourceFrames: frames.length,
    // null は「未検証」、数値がある場合は表を真値として再計算する。
    ambiguous: counts.ambiguous === null
      ? null
      // verifyFrameTable と同じ定義（changed + unknown）。same と確定できたものだけを除く。
      // unknown を落とすと「判定できなかったコマ」が問題なしに見えてしまう。
      : frames.filter((frame) => !frame.captured && frame.verified !== 'same').length,
    // **送り主が入れてきた数字は使わず、受け取った表から数え直す。**
    // 共有ファイルに入っているのは 1 コマずつの表だけで、合計は入っていない。以前は
    // 送られてきた値をそのまま入れており、入っていなければ空のままだった——結果、
    // 受け取った録画はコマ送りの表示だけが赤く、詳細パネルは黙る形になっていた。
    unreported: countReportDrops(frames.map((frame) => frame.mediaTime)),
    misaligned: frames.filter((frame) => frame.misaligned).length,
  }
}

// 共有データからフレーム表を復元する際、表と品質カウントを必ず同一トランザクションで戻す。
// 片方だけ成功すると、詳細表示の母数と実際にコマ送りが読む表が食い違うため。
export function restoreVideoFrames(
  imageId: number,
  frames: StoredFrame[],
  counts: { ambiguous: number | null }
): ReturnType<typeof restoredFrameCounts> | null {
  if (frames.length === 0) return null
  const restored = restoredFrameCounts(frames, counts)
  getDb().transaction(() => {
    prepare('INSERT OR REPLACE INTO video_frames (image_id, data) VALUES (?, ?)').run(imageId, encodeFrames(frames))
    prepare(`UPDATE images
      SET uncaptured_frames = ?, ambiguous_frames = ?, source_frames = ?, unreported_frames = ?, misaligned_frames = ?
      WHERE id = ?`)
      .run(restored.uncaptured, restored.ambiguous, restored.sourceFrames, restored.unreported, restored.misaligned, imageId)
  })()
  return restored
}

// フレーム表を「使ってはいけない」状態にする。
//
// 表の frameIndex がファイル内の実フレームと対応していないと分かったときに使う。
// 半端に残すとコマ送りが黙って別のコマの絵を出すため、精度を諦めて従来のフレーム走査へ
// 退避させる（decodeFrames が壊れた行を null で返すのと同じ判断）。
// 枚数（uncaptured_frames / ambiguous_frames）も一緒に無効化する — 表が信用できない以上、
// そこから数えた「N コマ要確認」も根拠を失っているため。
//
// **以前は行ごと DELETE していた。表そのものを残す形に変えた。**
// 判定（verify-clip.ts の findFrameDivergence）は、しきい値も窓の枚数も実測から決めた
// 経験則で、実機を踏むたびに調整が入る。消してしまうと、その調整で「あれは誤判定だった」と
// 分かっても遡って直せない。実際 2026-08-26 に誤判定で 231 コマ・撮り逃し 0 の表を 2 本
// 失っている（image 245 / 246）。しかも誤判定に気づけるのは、使う人が「なぜ黄色いのか」と
// 言い出したときだけで、こちらからは永久に見えない。
//
// **消すことで得ていた「疑わしい表は絶対に使われない」保証は、印を data の中へ埋めることで
// 保つ。** 列で持つと読み出し口が増えたときに見落とせるが、ここに埋めておけば decodeFrames が
// 必ず null を返すので、呼ぶ側からは行が無いのと区別が付かない。
export function markVideoFramesUnusable(id: number, reason: string): void {
  const row = prepare('SELECT data FROM video_frames WHERE image_id = ?').get(id) as { data: string } | undefined
  if (row) {
    // 既に印が付いていれば二重に包まない（最初に捨てた理由の方を残す）。
    if (readUnusableReason(row.data) === null) {
      prepare('UPDATE video_frames SET data = ? WHERE image_id = ?').run(encodeUnusable(row.data, reason), id)
    }
  }
  prepare(`UPDATE images
    SET uncaptured_frames = NULL, ambiguous_frames = NULL, source_frames = NULL,
        unreported_frames = NULL, misaligned_frames = NULL
    WHERE id = ?`).run(id)
}

// 詳細パネルに出す枚数を、保存済みのコマ表から数え直して書き戻す。
//
// **古い録画のために要る。** これらの数字は録画・トリミングの直後にしか書いておらず、
// 実測（2026-08-26）では手元 82 本のうち 25 本が空、5 本が表と食い違っていた。空だと
// 詳細パネルだけが黙り、コマ送りの表示と食い違う（コマ送りは開くたびに表から数え直す）。
//
// 数え直しはコマ表を読むだけで、動画のデコードは要らない（recheckUnusableClips とは別物）。
// ambiguous_frames には触らない —— あれは実ファイルとの照合が要るので、ここでは出せない。
//
// 戻り値は書き換えた本数（ログ用）。
export function backfillFrameCounts(): number {
  const rows = prepare(
    'SELECT v.image_id AS imageId, v.data AS data,' +
    ' i.uncaptured_frames AS uncaptured, i.source_frames AS total,' +
    ' i.unreported_frames AS unreported, i.misaligned_frames AS misaligned' +
    ' FROM video_frames v JOIN images i ON i.id = v.image_id'
  ).all() as {
    imageId: number; data: string
    uncaptured: number | null; total: number | null; unreported: number | null; misaligned: number | null
  }[]
  let fixed = 0
  for (const row of rows) {
    const frames = decodeFrames(row.data)
    if (!frames || frames.length === 0) continue
    const uncaptured = frames.filter((f) => !f.captured).length
    const misaligned = frames.filter((f) => f.misaligned).length
    const unreported = countReportDrops(frames.map((f) => f.mediaTime))
    if (row.uncaptured === uncaptured && row.total === frames.length &&
        row.unreported === unreported && row.misaligned === misaligned) continue
    setFrameCounts(row.imageId, uncaptured, frames.length, unreported, misaligned)
    fixed++
  }
  return fixed
}

export function getVideoFrames(imageId: number): StoredFrame[] | null {
  const row = prepare('SELECT data FROM video_frames WHERE image_id = ?').get(imageId) as { data: string } | undefined
  if (!row) return null
  const frames = decodeFrames(row.data)
  // 印が付いているのは「検証の結果、使わないと決めた」表。壊れた行と同じ扱い（従来の
  // フレーム走査へ退避）だが、原因が違うのでログを分ける — 前者は想定内、後者は不具合。
  if (!frames) {
    const reason = readUnusableReason(row.data)
    if (reason) console.log('[db] video_frames kept but marked unusable, falling back to raw frame order', { imageId, reason })
    else console.warn('[db] video_frames row is unusable, falling back to raw frame order', { imageId })
  }
  return frames
}
