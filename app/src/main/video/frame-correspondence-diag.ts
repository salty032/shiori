// Experimental evidence collection only. No frame table, DB or UI mutations.
import { app } from 'electron'
import { mkdir, readdir, unlink, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { findFrameDivergence } from './frame-verify'
import { diagLogEnabled } from '../system/diag-log'
import type { StoredFrame } from '../db/db-video-frames'
import type { CaptureDiag } from '../../shared/capture-diag'

export const CORRESPONDENCE_DIAG_VERSION = 1
// Experimental bounds, not a measured guarantee of timestamp accuracy.
const TOLERANCE_MS = 10
const MIN_SIDE_FRAMES = 5

export interface CorrespondenceDiagnosis {
  version: number
  toleranceMs: number
  missing: number
  divergenceAt: number | null
  status: 'invalid' | 'not-short' | 'inconclusive' | 'candidate'
  // Inclusive bounds in the original supply sequence. All hypotheses delete
  // `missing` consecutive frames. Multiple separate losses are not modeled.
  candidateStart: number | null
  candidateEnd: number | null
  bestMaxResidualMs: number | null
}

/** Enumerate a single missing burst; never infer its size from average spacing. */
// toleranceMs is a parameter so recorded clocks can be re-scored offline
// (scripts/frame-test.cjs diag) before any bound is adopted.
export function diagnoseCorrespondence(
  drawnAt: readonly number[], pts: readonly number[], toleranceMs = TOLERANCE_MS
): CorrespondenceDiagnosis {
  const missing = drawnAt.length - pts.length
  const out: CorrespondenceDiagnosis = {
    version: CORRESPONDENCE_DIAG_VERSION, toleranceMs, missing,
    divergenceAt: null, status: 'inconclusive', candidateStart: null,
    candidateEnd: null, bestMaxResidualMs: null
  }
  const increasing = (values: readonly number[]): boolean => values.every((v, i) =>
    Number.isFinite(v) && (i === 0 || v > values[i - 1]))
  if (!drawnAt.length || !pts.length || !increasing(drawnAt) || !increasing(pts)) {
    return { ...out, status: 'invalid' }
  }
  const divergence = findFrameDivergence([...drawnAt], [...pts])
  out.divergenceAt = divergence < Math.min(drawnAt.length, pts.length) ? divergence : null
  if (missing <= 0) return { ...out, status: 'not-short' }
  if (pts.length < MIN_SIDE_FRAMES * 2) return out

  const residual = (fileIndex: number, supplyIndex: number): number =>
    drawnAt[supplyIndex] - drawnAt[0] - (pts[fileIndex] - pts[0]) * 1000
  const head = Array.from({ length: MIN_SIDE_FRAMES }, (_, i) => residual(i, i)).sort((a, b) => a - b)
  const origin = head[head.length >> 1]
  const prefixMax: number[] = []
  const suffixMax: number[] = []
  for (let i = 0; i < pts.length; i++) {
    prefixMax[i] = Math.max(i ? prefixMax[i - 1] : 0, Math.abs(residual(i, i) - origin))
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    suffixMax[i] = Math.max(i + 1 < pts.length ? suffixMax[i + 1] : 0, Math.abs(residual(i, i + missing) - origin))
  }
  // Both sides need evidence. Startup and end-of-file hypotheses remain
  // inconclusive; a small residual is not proof of the identity of the picture.
  let best = Infinity
  for (let start = MIN_SIDE_FRAMES; start <= pts.length - MIN_SIDE_FRAMES; start++) {
    const maxResidual = Math.max(prefixMax[start - 1], suffixMax[start])
    best = Math.min(best, maxResidual)
    if (maxResidual > toleranceMs) continue
    if (out.candidateStart === null) out.candidateStart = start
    out.candidateEnd = start
  }
  out.bestMaxResidualMs = Number.isFinite(best) ? best : null
  if (out.divergenceAt !== null && out.candidateStart !== null) out.status = 'candidate'
  return out
}

/**
 * 数えた枚数よりファイルが少ない録画で、**どこで何枚落ちたか**を供給とファイルの間隔から出す。
 * 証拠を集めるだけで、表は書き換えない。
 *
 * 上の diagnoseCorrespondence は先頭からの累積のずれ（段差）を見るので、欠落を伴わない
 * 時刻だけのずれと区別できず、落ちた場所が 1 か所でないと答えが出ない。こちらは**隣どうしの
 * 間隔の並び方**を突き合わせる。供給の間隔は毎回 13〜30ms と不規則に揺れ、ファイルの間隔は
 * それをそのまま写している（食い違いは 99% が 5.5ms 以内）。落ちたところではファイルの 1 間隔が
 * 供給の 2 間隔ぶんになり、その先はずれた並びでしか合わない。
 *
 * 2026-11-15 に診断ファイル 207 本で確かめたこと：
 * - 枚数の合う 178 本にわざと 1 枚の欠落を作ると、末尾 178/178、先頭 178/178、途中 1590/1602 が
 *   位置まで一致した。途中の外れ 12 件はすべて、時刻だけ 15ms 以上ずれる所がある録画。
 * - 実際に 33 枚足りなかった録画（image 538・正解を焼き込んだテスト動画）は「先頭で 33 枚」と出て、
 *   表を 33 枚ずらすと 0/272 → 251/272 行が正しい絵を指した。拡張が控えた絵でも 33 枚で一致した。
 * - **本物の途中欠落（image 464・465）は答え合わせができていない**（ファイルが残っていない・
 *   控えの絵が無い）。この結果で表を直すのは、それが済んでから。
 *
 * 供給が完全に等間隔だと、先頭・途中・末尾のどれでも同じ費用になり区別できない。そのときは
 * 末尾に寄せる（meanErrorMs と tailOnlyMeanErrorMs が同じ値になるので、読めば分かる）。
 */
export interface LostFrames {
  /** ファイルの 1 枚目より前に落ちた枚数 */
  head: number
  /** ファイルの最後の 1 枚より後ろに落ちた枚数 */
  tail: number
  /** 途中で落ちた場所。before はファイル側の添字で、その画像の直前に count 枚落ちている */
  interior: { before: number; count: number }[]
  /** 並べ直した後の、供給とファイルの間隔の食い違い（1 間隔あたりの平均・ミリ秒） */
  meanErrorMs: number
  /** 全部が末尾で落ちたと仮定した（先頭から 1 対 1 で並べた）ときの同じ値。比べるための物差し */
  tailOnlyMeanErrorMs: number
}

// これより多く足りない録画は調べない（費用が枚数の 2 乗で増える。実録画の最大は 33 枚）。
const MAX_LOCATED_LOSS = 150

export function locateLostFrames(drawnAt: readonly number[], pts: readonly number[]): LostFrames | null {
  const n = pts.length
  const missing = drawnAt.length - n
  if (missing <= 0 || missing > MAX_LOCATED_LOSS || n < 3) return null
  if (![...drawnAt, ...pts].every((v) => Number.isFinite(v))) return null

  // cost[k] = ファイルの j 枚目までを、それまでに k 枚落ちたとして並べたときの食い違いの合計。
  // 先頭で落ちたぶんは間隔からは見えないので、費用 0 で始める。
  let cost = new Float64Array(missing + 1)
  const from: Int16Array[] = []
  for (let j = 1; j < n; j++) {
    const fileGap = (pts[j] - pts[j - 1]) * 1000
    const next = new Float64Array(missing + 1).fill(Infinity)
    const back = new Int16Array(missing + 1)
    for (let k = 0; k <= missing; k++) {
      for (let k0 = 0; k0 <= k; k0++) {
        const c = cost[k0] + Math.abs(drawnAt[j + k] - drawnAt[j - 1 + k0] - fileGap)
        if (c < next[k]) { next[k] = c; back[k] = k0 }
      }
    }
    from.push(back)
    cost = next
  }
  // 同じ費用なら、落ちた枚数の少ない並び（＝残りは末尾）を採る。
  let lostBeforeEnd = 0
  for (let k = 1; k <= missing; k++) if (cost[k] < cost[lostBeforeEnd] - 1e-9) lostBeforeEnd = k

  const lostBefore = new Array<number>(n)
  let k = lostBeforeEnd
  for (let j = n - 1; j >= 1; j--) { lostBefore[j] = k; k = from[j - 1][k] }
  lostBefore[0] = k

  const interior: LostFrames['interior'] = []
  for (let j = 1; j < n; j++) {
    if (lostBefore[j] > lostBefore[j - 1]) interior.push({ before: j, count: lostBefore[j] - lostBefore[j - 1] })
  }
  let tailOnly = 0
  for (let j = 1; j < n; j++) tailOnly += Math.abs(drawnAt[j] - drawnAt[j - 1] - (pts[j] - pts[j - 1]) * 1000)
  return {
    head: lostBefore[0],
    tail: missing - lostBeforeEnd,
    interior,
    meanErrorMs: cost[lostBeforeEnd] / (n - 1),
    tailOnlyMeanErrorMs: tailOnly / (n - 1)
  }
}

/**
 * 録画したときの状況。診断ファイルに添える。
 *
 * **枚数の合わない録画が出ても、どの版・どの状況で撮ったかが残っていないと原因まで辿れない**
 * （2026-11-15：6 本の録画について、版は日付と git の履歴から推測するしかなかった）。
 */
export interface DiagContext {
  appVersion: string
  /** 拡張が名乗った版（届いていなければ null） */
  extensionVersion: string | null
  /** 「閉じたらメモリを空ける」設定。録画のたびにレコーダーウィンドウを作り直す */
  lowMemoryMode: boolean
  sessionId: number
  durationSec: number
  sourceFps: number | null
  captureFps: number | null
  displayHz: number | null
  /** 配信サービスのホスト名だけ（作品名・URL は入れない） */
  host: string | null
  /** レコーダーから届いた供給の実測と、記録の開始・停止の時刻 */
  capture: CaptureDiag | null
  /** 冒頭について保証できなかったこと（recording.ts の StartDoubts） */
  startDoubts: { notSettled: boolean; armingUnconfirmed: boolean }
}

// 記録の開始の各時刻より前に、何枚数えていたか。先頭の欠落がこのどれかと同じ枚数なら、
// 「記録がまだ動いていないうちに数えた」のが原因だと 1 本で分かる。
function countedBefore(drawnAt: readonly number[], capture: CaptureDiag | null): Record<string, number | null> {
  const before = (at: number | null | undefined): number | null =>
    typeof at === 'number' ? drawnAt.filter((t) => t < at).length : null
  return {
    recStartCalled: before(capture?.recStartCalledAt),
    sinkOpened: before(capture?.sinkOpenedAt),
    recStarted: before(capture?.recStartedAt),
    firstChunk: before(capture?.firstChunkAt)
  }
}

// 製品版で残す本数の上限。超えたら古い順に消す（1 本は控えの絵を含めて数百 KB）。
const MAX_KEPT_EVIDENCE = 40

// 書き出す先。開発（dev.bat）は全部の録画を frame-diag/ へ。製品版は、目印（diag-log.on）のある PC で、
// 枚数の合わなかった録画だけを userData/logs/frame-diag/ へ残す。**目印の無い PC には書かない**
// （diag-log.ts と同じ決まり）。
function evidenceDir(mismatched: boolean): { dir: string; prune: boolean } | null {
  const configured = process.env['SHIORI_FRAME_DIAGNOSTICS_DIR']
  if (configured) return { dir: resolve(configured), prune: false }
  if (!mismatched || !diagLogEnabled()) return null
  return { dir: join(app.getPath('userData'), 'logs', 'frame-diag'), prune: true }
}

async function pruneEvidence(dir: string): Promise<void> {
  const stamp = (name: string): number => Number(/^frame-\d+-(\d+)-/.exec(name)?.[1] ?? 0)
  const files = (await readdir(dir)).filter((f) => /^frame-\d+-\d+-.*\.json$/.test(f)).sort((a, b) => stamp(a) - stamp(b))
  for (const name of files.slice(0, Math.max(0, files.length - MAX_KEPT_EVIDENCE))) {
    await unlink(join(dir, name)).catch(() => {})
  }
}

/** Failures must not interrupt the existing verification. */
export async function writeCorrespondenceDiagnostic(
  imageId: number, drawnAt: readonly number[], pts: readonly number[], table: readonly StoredFrame[],
  // 各コマが画面に出た時刻。これがあれば、遅れを何 ms にしたら表がどうなったかを後から作り直せる
  // （正解を焼き込んだテスト動画と突き合わせ、正しくなる遅れの範囲を 1 本から出すため）。
  source: readonly {
    mediaTime: number; displayAt: number; presentedFrames?: number | null
    presentedAt?: number | null; calledAt?: number | null; thumb?: string | null
  }[] = [],
  // 録画ファイルの場所。テスト動画の正解を、ファイルが消される前に控えるのに使う（scripts/frame-test.cjs の serve）。
  videoPath: string | null = null,
  context: DiagContext | null = null
): Promise<void> {
  try {
    const mismatched = drawnAt.length !== pts.length
    const lost = locateLostFrames(drawnAt, pts)
    const counted = countedBefore(drawnAt, context?.capture ?? null)
    // 枚数が合わなかったら、書き出し先が無くても 1 行は残す（製品版は diag-log.ts がファイルへ写す）。
    // ASCII のみ（dev.bat のコンソールは Shift-JIS）。
    if (mismatched) {
      const where = lost
        ? `head ${lost.head}, interior ${lost.interior.reduce((sum, g) => sum + g.count, 0)}` +
          (lost.interior.length ? ` at [${lost.interior.slice(0, 12).map((g) => `${g.before}:${g.count}`).join(' ')}` +
            `${lost.interior.length > 12 ? ' ...' : ''}]` : '') +
          `, tail ${lost.tail}` +
          ` (interval error ${lost.meanErrorMs.toFixed(1)}ms, ${lost.tailOnlyMeanErrorMs.toFixed(1)}ms if all at the tail)`
        : 'not located'
      console.warn(
        `[frame-loss] image ${imageId}: supplied ${drawnAt.length}, file has ${pts.length}. lost: ${where}.` +
        ` counted before recorder start() ${counted.recStartCalled ?? 'n/a'}, start event ${counted.recStarted ?? 'n/a'},` +
        ` first data ${counted.firstChunk ?? 'n/a'}; prior recordings in this recorder window ${context?.capture?.priorPrepares ?? 'n/a'}`
      )
    }
    const target = evidenceDir(mismatched)
    if (!target) return
    const diagnosis = diagnoseCorrespondence(drawnAt, pts)
    await mkdir(target.dir, { recursive: true })
    const file = join(target.dir, `frame-${imageId}-${Date.now()}-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(), imageId,
      units: {
        drawnAt: 'epoch-ms', pts: 'seconds',
        source: 'mediaTime seconds, displayAt/presentedAt/calledAt epoch-ms',
        context: 'capture.rec*At / sinkOpenedAt / firstChunkAt / supplyStoppedAt are epoch-ms'
      },
      drawnAt, pts, table, diagnosis, lost, countedBefore: counted, context, videoPath, source
    }), { encoding: 'utf8', flag: 'wx' })
    console.log(`[frame-correspondence-diag] image ${imageId}: ${JSON.stringify(diagnosis)}; ${file}`)
    if (target.prune) await pruneEvidence(target.dir)
  } catch (err) {
    console.warn(`[frame-correspondence-diag] image ${imageId}: diagnostic failed`, err)
  }
}
