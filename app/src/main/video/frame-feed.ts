// 配信ページから届く「素材の1コマ」通知の受け口。
//
// 録画クリップのコマ送りを素材の実コマと一致させるための土台。画面キャプチャ側の
// rVFC はコンポジタ駆動なので素材のコマとは無関係な枚数が出るが（実測: 23.976fps の
// 素材から 36.9fps 分のフレームが記録されていた）、配信ページの video の rVFC は
// 素材のコマごとにちょうど1回だけ発火する。その通知をここへ集約する。
//
// 通知は届くまでに数十〜数百ms 遅れることがあるため、リアルタイムでフレーム供給を
// 駆動するのではなく、録画後に時刻で突き合わせる。displayAt はコマが画面に出た瞬間に
// ページ側で刻まれるので、通知が遅れても値は正しいまま残る。
import { onExtensionMessage } from '../browser/ws-server'
import { medianInterval } from './frame-series'
import { fitGrid, matchFrames, summarizeReportDelay, type MatchResult, type ReportDelay } from './frame-match'

export interface SourceFrame {
  /** 素材自身のタイムライン上の時刻（秒）。素材のコマを一意に識別する */
  mediaTime: number
  /** そのコマが画面に出る時刻（epoch ミリ秒）。配信ページ側の時計 */
  displayAt: number
  /** main が通知を受け取った時刻（epoch ミリ秒）。遅延の測定に使う */
  receivedAt: number
  /**
   * 合成へ送られたコマの累積数（rVFC の presentedFrames）。返さない環境では null。
   *
   * **通知が飛んでも、この値は飛んだぶんだけ増えている。** 前後の差から 1 を引けば、
   * 通知が来なかったコマ数が実数で出る（frameGaps）。従来の「時刻の差 ÷ 間隔の中央値」は
   * **欠けた区間の刻みが残っている区間と同じ**という仮定に乗っており、欠けたコマからは
   * 検算できない。1 枚違うだけで、その下のコマ番号が全部ずれる。
   */
  presentedFrames?: number | null
  /** 合成へ回した時刻・コールバックの時刻（epoch ミリ秒。診断用。ws-server.ts の frame 参照） */
  presentedAt?: number | null
  calledAt?: number | null
  /** そのコマの絵（32x32 の白黒を base64 にしたもの）。読めなければ null（frame-thumbs.ts） */
  thumb?: string | null
}

// 録画の上限 30 秒 × 60fps に、通知の重複・高フレームレート素材・停止処理中に届くぶんの余裕を持たせた上限。
// 際限なく溜めると、録画が異常終了して stop が呼ばれないままメモリを食い続ける。
const MAX_FRAMES = 8000

let collecting = false
let frames: SourceFrame[] = []
let unsubscribe: (() => void) | null = null
// 上限に達したことを1録画につき1回だけ知らせるための印。
let capReported = false
// 録画中にコマ通知が途切れた回数（ページ側の rVFC ループが止まった回数）。
let reportGaps = 0

export function startFrameFeed(): void {
  stopFrameFeed()
  collecting = true
  frames = []
  capReported = false
  reportGaps = 0
  unsubscribe = onExtensionMessage((msg) => {
    if (!collecting) return
    if (msg.type === 'frame-gap') {
      reportGaps++
      return
    }
    if (msg.type !== 'frame') return
    if (frames.length >= MAX_FRAMES) {
      // 上限に達したら以降のコマは表に入らず、フレーム表が録画の途中で終わる。
      // 黙って捨てると「後半だけコマ送りが素材と合わない」という説明の付かない状態になるので、
      // 1回だけ知らせる（毎フレーム出すとログが埋まる）。
      if (!capReported) {
        capReported = true
        console.warn(
          `[frame-feed] source frame reports hit the cap (${MAX_FRAMES}).` +
          ' Later frames are dropped and the frame table will end before the recording does.'
        )
      }
      return
    }
    frames.push({
      mediaTime: msg.mediaTime, displayAt: msg.displayAt, receivedAt: Date.now(),
      presentedFrames: msg.presentedFrames, presentedAt: msg.presentedAt, calledAt: msg.calledAt,
      thumb: msg.thumb
    })
  })
}

export function stopFrameFeed(): void {
  collecting = false
  unsubscribe?.()
  unsubscribe = null
}

// 収集した素材のコマから、素材の実 fps を推定する。
// 中央値ではなく回帰で出す（1ms 丸めで返すサービスがあり、中央値だと真の値とずれる）。
export function getSourceFps(): number | null {
  const grid = fitGrid(frames.map((f) => f.mediaTime))
  if (!grid || !(grid.periodMs > 0)) return null
  const fps = 1000 / grid.periodMs
  if (!(fps >= 1 && fps <= 240)) return null
  // 小数第3位まで残す。23.976 と 23.98 は別物として扱いたいので 2 桁では足りない。
  return Math.round(fps * 1000) / 1000
}

// 録画開始の合図から実際に記録を始めるまで、コマ通知が落ち着くのを待つ。
//
// **画面キャプチャが立ち上がる瞬間、ページ側が素材のコマを描き落とす。** ブラウザは
// ハードウェアアクセラレーション OFF（＝CPU で描画）が前提なので、キャプチャの負荷が
// 乗った瞬間に一番重いページだけが落ちる。実測（2026-08-26・YouTube 1080p 23.976fps）:
// 開始から 1.2 秒で 30 コマが描かれず、その後 16.5 秒は 1 コマも落ちなかった。同じ動画を
// 480p にすると 185/185 で 1 コマも落ちない。DMM・Netflix では 18 本すべて 0 コマ。
// **描かれなかったコマは録画ファイルにも無い**ので、後からはどうにもならない。
// 荒れている区間を記録の外へ出すのが唯一の対処になる。
//
// 判定は「1 コマも落ちていないか」では**ない**。60fps 素材は供給（実測 51 枚/秒）が
// 足りず常時 1〜2 コマ落ちるので、完璧を待つと永久に始まらない。**立ち上がりの荒れ
// （まとまった飛び）が収まったか**だけを見る。
// 見る直近のコマ数。**手元の全クリップ 76 本に当てて決めた**（2026-08-26）。
//   窓 8 コマ … 60fps 0.12〜0.25 秒 / 30fps 0.53 秒 / 24fps YouTube 0.63〜1.04 秒
//   窓 12 コマ… 24fps YouTube が 1.2〜2.9 秒。**上限に張り付いて意味を失う。**
// 荒れの無いサービス（DMM・Netflix は 18 本すべて 0 コマ落ち）では窓が埋まった時点で
// 成立するので、24fps なら 0.33 秒。**落ちていないページを待たせない**のが要点。
const SETTLE_WINDOW = 8
// 「まとまった飛び」とみなすコマ数。1〜2 コマの欠けは 60fps 素材の常態（供給 51 枚/秒が
// 60 コマに足りない）なので許す。ここを 2 にすると 60fps が永久に始まらない。
const SETTLE_BIG_GAP = 3
const SETTLE_POLL_MS = 50

export interface SettleResult {
  /** 落ち着いたと判断できたか。false なら見切って始めた（保証できない） */
  settled: boolean
  waitedMs: number
  /** 待っている間に届いたコマ数。0 なら拡張が繋がっていない */
  reports: number
}

// 直近 SETTLE_WINDOW コマの間隔に、まとまった飛びが無いか。
// **DB を張らずに検証できるよう、判定は素材時刻の列だけを見る純粋関数にする**
// （frame-feed.test.ts が数値を固定している）。
export function isSteadySequence(mediaTimes: number[]): boolean {
  if (mediaTimes.length < SETTLE_WINDOW) return false
  const recent = mediaTimes.slice(-SETTLE_WINDOW)
  const diffs: number[] = []
  for (let i = 1; i < recent.length; i++) diffs.push(recent[i] - recent[i - 1])
  // 素材のコマ長は取得できないことがある（fps 不明・再生開始直後）ので、間隔の中央値で代用する。
  const period = medianInterval(recent)
  if (!(period > 0)) return false
  return diffs.every((d) => Math.round(d / period) < SETTLE_BIG_GAP)
}

function looksSteady(): boolean {
  return isSteadySequence(frames.map((f) => f.mediaTime))
}

export async function waitForSteadyFrames(timeoutMs: number): Promise<SettleResult> {
  const started = Date.now()
  for (;;) {
    if (looksSteady()) return { settled: true, waitedMs: Date.now() - started, reports: frames.length }
    if (Date.now() - started >= timeoutMs) {
      return { settled: false, waitedMs: Date.now() - started, reports: frames.length }
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
  }
}

// 収集済みのコマ通知と撮影時刻から、保存用のフレーム表を作る。
export function buildFrameTable(drawnAt: number[]): MatchResult | null {
  return matchFrames(frames, drawnAt)
}

// 収集済みのコマ通知の写し。録画直後の検査が、絵を取り出した後に表を作り直すのに使う。
// 次の録画で frames は作り直されるので、録画が終わった時点で写しを取る。
export function getSourceFrames(): SourceFrame[] {
  return frames.map((f) => ({ ...f }))
}

// 収集済みのコマ通知から、通知が届くまでの遅れを要約する（ReportDelay 参照）。
export function getReportDelay(): ReportDelay | null {
  return summarizeReportDelay(frames)
}

// 録画中にコマ通知が途切れていたら知らせる（1録画1行・途切れたときだけ）。
//
// **途切れた区間のコマは表に入らず、しかもどの数字にも現れない。** 撮り逃し（captured=false）は
// 「コマはあったが絵が無い」だが、こちらは通知そのものが来ていないのでコマの存在すら
// 分からず、`capturedRatio` は 100% のまま「表が録画の途中で終わっているクリップ」ができる。
// 黙って通すと、最も精度が良く見えるクリップの後半が対応していない、という最悪の形になる。
export function logReportInterruptions(): void {
  if (reportGaps === 0) return
  console.warn(
    `[frame-match] source frame reports were interrupted ${reportGaps} time(s) during the recording` +
    ' (the page\'s video element was swapped). Part of the clip has no frame table.'
  )
}

