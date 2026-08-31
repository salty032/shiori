// ビューアのコマ表示（番号と注記）を決める部分。**DOM は触らない。**
//
// **なぜ切り出すか。** ここはこのアプリの存在理由そのもの（docs/ANIME-FRAMES.md 0 章）で、
// かつ間違えても画面からは正しく見える。「同じコマなのにビューアとタイムシートで違う番号が
// 出る」「抜けの手前で番号と違う絵が映る」は、どちらも実際にここで起きた。
// VideoPlayer.tsx の中に置いたままだと、映像要素と React の描画を用意しないと 1 行も
// 確かめられない。判定だけをここへ出し、書き込み（el.textContent / style）は呼び出し側に残す。
//
// **表示の見え方は変えていない。** 文言・色・優先順位はすべて元のまま。
import { FRAME_QUALITY, type ClipFrames } from '../../shared/api.video'
import type { MessageKey, Translate } from './i18n'

/**
 * コマ表示が今どの土台で動いているか。**コマ送りの結果をどう読んでよいかが変わる**ので、
 * 内部で分岐するだけでなく画面にも出す（docs/ANIME-FRAMES.md 3章「保証できないときは
 * 保証できないと出す」）。
 *
 *   off       … コマ表示をしない（詳細パネル。表を取りに行かないので何も言えない）
 *   loading   … 表を取得中。**推定に落とさず、押されたコマ送りは保留する**
 *   source    … 素材の実コマ単位。1 コマ送り＝素材の 1 コマ
 *   file      … ファイルに記録されたフレーム単位（表が無い／対応が取れなかった）
 *   estimated … フレーム位置すら取れず、fps 換算の刻みで動いている
 */
export type ReadoutKind = 'off' | 'loading' | 'source' | 'file' | 'estimated'

// コマ表示の色。**映像に直接重なる層なので、テーマ変数ではなくオンビデオの固定色にする**
// （コントロールバーが半透明ホワイトに統一しているのと同じ判断。videoControls.tsx 参照）。
export const FRAME_COLOR = {
  /** 素材のコマ単位で送れている・確からしさに問題が無い */
  ok: 'rgba(255,255,255,0.92)',
  /** 補足情報（読み込み中・実害なしと確認済みの流用） */
  muted: 'rgba(255,255,255,0.62)',
  /** 黙って誤読させうる状態（未検証の流用・素材のコマ単位でない） */
  warn: '#ffcf70',
  /** 検証の結果、絵が変わっていて特定不能と分かったコマ */
  alert: '#ff9aa2',
}

// コマごとの確からしさに添える注記。null（撮れているコマ）のときは番号だけを出す——
// **問題が無いときに何も足さない**のが要点で、常に何か表示していると注記が背景になる。
export const FRAME_NOTE: Record<number, { label: MessageKey; hint: MessageKey; color: string } | null> = {
  [FRAME_QUALITY.captured]: null,
  [FRAME_QUALITY.reused]: { label: 'viewer.frameNeedsReview', hint: 'viewer.frameReusedHint', color: FRAME_COLOR.warn },
  // misaligned はここに入れない。**箇所を指さずクリップ全体を赤で通す**（frameReadout）。
  [FRAME_QUALITY.misaligned]: null,
}

// 実測行の後ろにある抜け。**通知欠落数（technicalMissing）と、録画画像から推定した
// アニメの抜けコマ数（missing）を混ぜない**（docs/FRAME-GAPS.md 0 章）。コマ送りと番号に
// 使うのは後者だけで、推定できなければ known:false のまま 0 にする。
export interface GapInfo {
  missing: number
  technicalMissing: number
  known: boolean
}

export interface GapIndex {
  /** 添字 i の行の「次」にある抜け */
  gaps: Map<number, GapInfo>
  /** 行 i より前に抜けが何コマあるか（積み上げ）。**画面に出すコマ番号はこれを足す** */
  gapBefore: number[]
  /** 抜けを含めたコマの総数（＝元の動画のコマ数）。番号の母数 */
  totalWithGaps: number
}

// コマ表から、番号とコマ送りに要る索引を一度で作る。
//
// 番号を出すたびに前から数え直すと、コマ送りを押しっぱなしにしたときに効いてくるので、
// 開いた時点で積んでおく。
export function buildGapIndex(frames: ClipFrames | null): GapIndex {
  const gaps = new Map<number, GapInfo>((frames?.gaps ?? []).map((g) => [g.afterIndex, {
    missing: g.animeMissing ?? 0,
    technicalMissing: g.missing,
    known: g.animeMissing != null,
  }]))
  const ptsLen = frames?.pts.length ?? 0
  const gapBefore = new Array<number>(ptsLen)
  let acc = 0
  for (let i = 0; i < ptsLen; i++) { gapBefore[i] = acc; acc += gaps.get(i)?.missing ?? 0 }
  return { gaps, gapBefore, totalWithGaps: ptsLen + acc }
}

// 画面に出すコマ番号（1 始まり）。
//
// 番号は 1 始まり。0 始まりだと先頭が「0 / 719」になり、何コマ目かを数える用途では
// 毎回読み替えが要る。
//
// **数えるのは元の動画のコマで、表の行ではない。** 抜けたコマも 1 コマとして数えるので、
// 番号 ÷ fps がそのまま秒になり、タイムシート・書き出しの番号とも一致する。表の行を
// そのまま 1・2・3… と数えると抜けたぶんだけ番号が詰まり、同じコマがビューアで 324、
// タイムシートで 327 になる（2026-08-31 の指摘）。
// トリマーの f{N} は**別の数え方のまま**——あちらが指しているのは録画ファイルをどこで
// 切るかで、抜けたコマはそもそも切る対象に無い。
export function sourceFrameNo(idx: number, gapBefore: number[], gap = 0): number {
  return idx + (gapBefore[idx] ?? 0) + gap + 1
}

// 実測行と、その間に推定した仮想コマを合わせて delta コマ歩く。
//
// 抜けの中には録画画像が無いので行を足せない。実測行の添字（idx）と、その後ろの抜けの
// 何コマ目に居るか（gap）の 2 つで位置を表し、ここだけが両者を動かす。
export function walkFrames(
  idx: number,
  gap: number,
  delta: number,
  total: number,
  missingAfter: (idx: number) => number
): { idx: number; gap: number } {
  let i = idx
  let g = gap
  for (let k = 0; k < Math.abs(delta); k++) {
    if (delta > 0) {
      if (g < missingAfter(i)) { g++; continue }
      if (i >= total - 1) { g = 0; break }
      i++
      g = 0
    } else {
      if (g > 0) { g--; continue }
      if (i <= 0) break
      i--
      g = missingAfter(i)
    }
  }
  return { idx: i, gap: g }
}

export interface FrameReadoutInput {
  kind: ReadoutKind
  /** 実測行の添字（範囲外でも clamp する） */
  idx: number
  /** その行の後ろの抜けの何コマ目か。0 は実測行そのもの */
  gap: number
  frames: ClipFrames | null
  index: GapIndex
  /** クリップ全体が当てにならないか（frameTable の isClipUnreliable） */
  unreliable: boolean
  /** 未取得の割合がクリップ単位で多いか */
  uncapturedSevere: boolean
  /** 取り込み動画か録画クリップか。file のときの読み方が変わる */
  clipSource?: string
  /** estimated のときに出す刻みの fps */
  estimatedFps: number
}

export interface FrameReadoutResult {
  /**
   * 確定した実測行の添字。**タイムシートへ知らせてよい位置**。
   * null は「コマ単位で何も言えない状態」（読み込み中・fps 換算）で、知らせない。
   */
  cur: number | null
  text: string
  title: string
  color: string
}

// コマ表示に出す文字・説明・色を決める。
//
// **番号だけでは足りない。** コマ送りで絵が変わらないこと自体が測定結果（コマ打ち）なので、
// 変わらなかった理由が「素材がその絵を保持していた」のか「こちらが撮り逃して直前の絵を
// 流用している」のかを、その場で区別できる必要がある。詳細パネルの合計枚数だけでは
// 「どこかに N コマ嘘がある」としか言えない。
//
// null を返したら**表示を書き換えない**（コマ表が無い＝前の表示のまま）。元の実装が
// 何もせず return していた分岐をそのまま保つ。
export function frameReadout(input: FrameReadoutInput, tr: Translate['t']): FrameReadoutResult | null {
  const { kind, gap, frames, index, unreliable, uncapturedSevere, clipSource, estimatedFps } = input

  if (kind === 'loading') {
    return {
      cur: null,
      text: tr('viewer.frameLoading'),
      title: tr('viewer.frameLoadingHint'),
      color: FRAME_COLOR.muted,
    }
  }
  if (kind === 'estimated') {
    return {
      cur: null,
      text: tr('viewer.frameEstimated', { fps: String(estimatedFps) }),
      title: tr('viewer.frameEstimatedHint'),
      color: FRAME_COLOR.warn,
    }
  }
  if (!frames || frames.pts.length === 0) return null

  const total = frames.pts.length
  const cur = Math.max(0, Math.min(input.idx, total - 1))
  const params = {
    cur: String(sourceFrameNo(cur, index.gapBefore, gap)),
    total: String(index.totalWithGaps || total),
  }

  if (kind === 'file') {
    // 表が無い＝ファイルに記録されたフレームをそのまま送っている。取り込み動画なら
    // それが素材のコマそのものだが、録画クリップのフレームは画面キャプチャの供給レートの
    // 産物で素材のコマとは対応しない。**後者は黙って通してはいけない。**
    const isImport = clipSource === 'import'
    return {
      cur,
      text: tr(isImport ? 'viewer.frameIndex' : 'viewer.frameIndexFile', params),
      title: tr(isImport ? 'viewer.frameFileHint' : 'viewer.frameFileCaptureHint'),
      color: isImport ? FRAME_COLOR.ok : FRAME_COLOR.warn,
    }
  }

  // このコマの次に抜けている枚数（小さい抜けのときだけ使う）。
  const gapNext = index.gaps.get(cur)

  // 推定した抜けの中。対応する録画画像は無いので、映像は手前の実測行のままにする。
  // 番号だけ進めることを黙らせず、精度の無い仮想位置だと常に表示する。
  if (gap > 0) {
    return {
      cur,
      text: `${tr('viewer.frameIndex', params)} · ${tr('viewer.frameInGapEstimated')}`,
      title: tr('viewer.frameInGapEstimatedHint', {
        cur: String(sourceFrameNo(cur, index.gapBefore)),
        count: String(gapNext?.missing ?? gap),
      }),
      color: FRAME_COLOR.warn,
    }
  }

  const note = FRAME_NOTE[frames.quality[cur] ?? FRAME_QUALITY.captured]
  const missingNext = gapNext?.missing ?? 0
  const unknownNext = gapNext != null && !gapNext.known
  // 注記は 3 段（詳細パネルの注記と同じ切り方）。
  //
  //   赤「要注意」   … ずれがある、または穴だらけ。どこを見ても数えられないので全体に出す。
  //                    **押さないと出ない場所ではなく番号の横**に置く（いちばん重いので）。
  //   黄「この先 N コマ抜け」… 抜けが少ないクリップ。壊れているのは**その穴をまたぐ境目
  //                    だけ**で、残りの境目は無傷。だから全体を赤くせず、その場所で出す。
  //   黄「未取得」   … 絵が無いコマ。コマ数は数えられる。従来どおりコマ単位。
  //
  // 重なったら重い方を採る。**並べない**——要注意が出ている時点で他を足しても判断は変わらず、
  // 抜けの手前では「またげない」ことが未取得より先に知りたい。
  const label = unreliable
    ? tr('viewer.frameUnreliable')
    : unknownNext
      ? tr('viewer.frameGapUnknown')
      : missingNext > 0
        ? tr('viewer.frameGapAfterEstimated', { count: String(missingNext) })
      : note ? tr(note.label) : null
  const title = unreliable
    ? tr('viewer.frameUnreliableHint')
    : unknownNext
      ? tr('viewer.frameGapUnknownHint', { count: String(gapNext.technicalMissing) })
      : missingNext > 0
        ? tr('viewer.frameGapAfterEstimatedHint', { count: String(missingNext) })
      : tr(note ? note.hint : 'viewer.frameSourceHint')
  // 未取得は、そのクリップで多いときだけ赤へ上げる（詳細パネルと同じ 5%）。
  const color = unreliable
    ? FRAME_COLOR.alert
    : unknownNext || missingNext > 0
      ? FRAME_COLOR.warn
      : note ? (uncapturedSevere ? FRAME_COLOR.alert : note.color) : FRAME_COLOR.ok

  return {
    cur,
    text: label ? `${tr('viewer.frameIndex', params)} · ${label}` : tr('viewer.frameIndex', params),
    title,
    color,
  }
}
