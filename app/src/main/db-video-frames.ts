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

export type FrameVerify = 'unknown' | 'same' | 'changed'

export interface StoredFrame {
  mediaTime: number
  frameIndex: number
  captured: boolean
  verified?: FrameVerify
}

// 直列化時のコード。文字列をそのまま並べると1クリップ千数百要素ぶん嵩む。
const VERIFY_CODE: Record<FrameVerify, number> = { unknown: 0, same: 1, changed: 2 }
const VERIFY_NAME: FrameVerify[] = ['unknown', 'same', 'changed']

// 直列化は DB アクセスから切り離した純粋関数にする。better-sqlite3 は Electron の ABI で
// ビルドされ素の Node からは読めないため、実 DB を張るテストが書けない。壊れると
// コマ送りが静かに従来動作へ落ちる箇所なので、ここだけでも検証できる形にしておく。
//
// 配列の配列で持つ。1クリップで千数百要素になるため、キー名を繰り返さない。
// 4 要素目（検証結果）は後から足したもの。3 要素しか無い古い行も読めるようにしてあるため
// （decodeFrames の length チェックは >= 3 のまま）、既存のクリップは未検証として扱われる。
export function encodeFrames(frames: StoredFrame[]): string {
  return JSON.stringify(frames.map((f) => [f.mediaTime, f.frameIndex, f.captured ? 1 : 0, VERIFY_CODE[f.verified ?? 'unknown']]))
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
    out.push({ mediaTime, frameIndex, captured: captured === 1, verified })
  }
  return out
}

export function saveVideoFrames(imageId: number, frames: StoredFrame[]): void {
  if (frames.length === 0) return
  prepare('INSERT OR REPLACE INTO video_frames (image_id, data) VALUES (?, ?)').run(imageId, encodeFrames(frames))
}

export function restoredFrameCounts(
  frames: StoredFrame[],
  counts: { ambiguous: number | null; unreported: number | null }
): { uncaptured: number; ambiguous: number | null; sourceFrames: number; unreported: number | null } {
  return {
    uncaptured: frames.filter((frame) => !frame.captured).length,
    sourceFrames: frames.length,
    // null は「未検証」、数値がある場合は表を真値として再計算する。
    ambiguous: counts.ambiguous === null
      ? null
      : frames.filter((frame) => !frame.captured && frame.verified === 'changed').length,
    unreported: counts.unreported,
  }
}

// 共有データからフレーム表を復元する際、表と品質カウントを必ず同一トランザクションで戻す。
// 片方だけ成功すると、詳細表示の母数と実際にコマ送りが読む表が食い違うため。
export function restoreVideoFrames(
  imageId: number,
  frames: StoredFrame[],
  counts: { ambiguous: number | null; unreported: number | null }
): void {
  if (frames.length === 0) return
  const restored = restoredFrameCounts(frames, counts)
  getDb().transaction(() => {
    prepare('INSERT OR REPLACE INTO video_frames (image_id, data) VALUES (?, ?)').run(imageId, encodeFrames(frames))
    prepare(`UPDATE images
      SET uncaptured_frames = ?, ambiguous_frames = ?, source_frames = ?, unreported_frames = ?
      WHERE id = ?`)
      .run(restored.uncaptured, restored.ambiguous, restored.sourceFrames, restored.unreported, imageId)
  })()
}

// フレーム表を破棄し、「コマ精度の情報が無い」状態（列は NULL）へ戻す。
//
// 表の frameIndex がファイル内の実フレームと対応していないと分かったときに使う。
// 半端に残すとコマ送りが黙って別のコマの絵を出すため、精度を諦めて従来のフレーム走査へ
// 退避させる方がよい（decodeFrames が壊れた行を null で返すのと同じ判断）。
// 枚数（uncaptured_frames / ambiguous_frames）も表と一緒に無効化する — 表が信用できない以上、
// そこから数えた「N コマ要確認」も根拠を失っているため。
export function dropVideoFrames(id: number): void {
  prepare('DELETE FROM video_frames WHERE image_id = ?').run(id)
  prepare('UPDATE images SET uncaptured_frames = NULL, ambiguous_frames = NULL, source_frames = NULL, unreported_frames = NULL WHERE id = ?').run(id)
}

export function getVideoFrames(imageId: number): StoredFrame[] | null {
  const row = prepare('SELECT data FROM video_frames WHERE image_id = ?').get(imageId) as { data: string } | undefined
  if (!row) return null
  const frames = decodeFrames(row.data)
  if (!frames) console.warn('[db] video_frames row is unusable, falling back to raw frame order', { imageId })
  return frames
}
