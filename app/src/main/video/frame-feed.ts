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
import { onExtensionMessage } from '../ws-server'

export interface SourceFrame {
  /** 素材自身のタイムライン上の時刻（秒）。素材のコマを一意に識別する */
  mediaTime: number
  /** そのコマが画面に出る時刻（epoch ミリ秒）。配信ページ側の時計 */
  displayAt: number
  /** main が通知を受け取った時刻（epoch ミリ秒）。遅延の測定に使う */
  receivedAt: number
}

// 60秒 × 60fps に、通知の重複や高フレームレート素材ぶんの余裕を持たせた上限。
// 際限なく溜めると、録画が異常終了して stop が呼ばれないままメモリを食い続ける。
const MAX_FRAMES = 8000

let collecting = false
let frames: SourceFrame[] = []
let unsubscribe: (() => void) | null = null

export function startFrameFeed(): void {
  stopFrameFeed()
  collecting = true
  frames = []
  unsubscribe = onExtensionMessage((msg) => {
    if (!collecting || msg.type !== 'frame') return
    if (frames.length >= MAX_FRAMES) return
    frames.push({ mediaTime: msg.mediaTime, displayAt: msg.displayAt, receivedAt: Date.now() })
  })
}

export function stopFrameFeed(): void {
  collecting = false
  unsubscribe?.()
  unsubscribe = null
}

export function getCollectedFrames(): SourceFrame[] {
  return frames
}

export interface FrameMatch {
  /** 素材のコマの時刻（秒）。動画時刻の表示とコマの同定に使う */
  mediaTime: number
  /** そのコマが写っている、録画ファイル内のフレーム番号（0 始まり） */
  frameIndex: number
  /**
   * そのコマの表示区間内に実際に画面を撮れていたか。
   *
   * false は「このコマ専用の絵が無く、直前のコマの絵を流用している」ことを意味する。
   * 画面キャプチャの供給（実測 35〜41枚/秒）が素材の 2 倍に届かないため、
   * 24fps 素材でも数 % のコマでこれが起きる。同じ絵が続く 2 コマ打ちの区間なら実害は
   * 無いが、絵が変わる境目に当たるとコマ打ちの数を誤る。黙って間違えるのが最悪なので
   * フラグとして残し、ユーザーに見せる。
   */
  captured: boolean
}

export interface MatchResult {
  matches: FrameMatch[]
  /** 自分の表示区間内に絵を撮れていたコマの割合。1.0 ならコマ送り1回で必ず絵が変わる */
  capturedRatio: number
  /** 採用した固定オフセット（ミリ秒）。キャプチャ経路の一定遅延ぶん */
  offsetMs: number
  sourceFrames: number
  drawnFrames: number
}

// 素材のコマと、録画ファイル内のフレームを対応付ける。
//
// 素材のコマは 41.7ms ごと、こちらの撮影は 16.7ms ごと（2.5倍のオーバーサンプリング）
// なので、素材の1コマにつき撮影フレームは2〜3枚ある。その中から1枚を選ぶ。
//
// 選び方は「そのコマが画面に出た時刻(displayAt)以降に撮られた最初のフレーム」。
// キャプチャ経路には一定の遅延があるため displayAt をそのまま使うと1コマ手前を掴むが、
// この遅延は一定なので、全体が最もきれいに1対1へ収まるオフセットを探して補正する
// （offsetMs）。一定のずれは全コマが等しくずれるだけでコマ打ちの数え方を壊さない。
export function matchFrames(source: SourceFrame[], drawnAt: number[]): MatchResult | null {
  if (source.length === 0 || drawnAt.length === 0) return null

  const pick = (offsetMs: number): FrameMatch[] => {
    const idx: number[] = []
    let i = 0
    for (const f of source) {
      const target = f.displayAt + offsetMs
      while (i + 1 < drawnAt.length && drawnAt[i] < target) i++
      idx.push(i)
    }
    // 「自分の表示区間内に撮れたか」は、次のコマが別のフレームを指したかで決まる。
    //
    // 選ばれるのは常に「その時刻以降の最初のフレーム」なので、次のコマが別のものを
    // 選んだということは、自分のフレームが次のコマの開始より前＝自分の区間内に
    // 撮られていたことを意味する。同じものを選んだなら、そのフレームは自分の区間より
    // 後ろにあり、自分専用の絵が無かったということになる。
    //
    // 時刻の大小で直接判定すると、撮影がちょうど区間の境目に乗ったときに浮動小数点の
    // 誤差で結果が揺れる。添字の比較なら厳密に決まる。
    const out = idx.map((frameIndex, k) => ({
      mediaTime: source[k].mediaTime,
      frameIndex,
      captured: k + 1 < idx.length ? idx[k + 1] !== frameIndex : frameIndex !== idx[k - 1]
    }))
    // 自分の区間に絵が無かったコマは、そのままだと「次のコマの絵」を指してしまう
    // （選び方が「その時刻以降の最初のフレーム」なので、区間を跨いだ先を掴む）。
    // 未来の絵を出すのは明確に誤りなので、直前の絵を引き継ぐ。素材が同じ絵を
    // 保持していた区間ならこれが正解になり、変わっていた場合も「変化を撮り逃した」
    // という素直な表現になる。
    for (let k = 1; k < out.length; k++) {
      if (!out[k].captured) out[k].frameIndex = out[k - 1].frameIndex
    }
    return out
  }

  let best: { offsetMs: number; matches: FrameMatch[]; score: number } | null = null
  // 探索幅はキャプチャ経路の遅延として現実的な範囲。1ms 刻みで十分（素材のコマは 41.7ms）。
  // 撮れたコマが最も多くなるオフセットを選ぶ。
  for (let offset = -100; offset <= 100; offset++) {
    const m = pick(offset)
    const score = m.reduce((n, x) => n + (x.captured ? 1 : 0), 0)
    if (!best || score > best.score) best = { offsetMs: offset, matches: m, score }
  }
  if (!best) return null

  return {
    matches: best.matches,
    capturedRatio: best.score / best.matches.length,
    offsetMs: best.offsetMs,
    sourceFrames: source.length,
    drawnFrames: drawnAt.length
  }
}

// 素材のコマ周期を最小二乗で推定する。
// mediaTime を 1ms 単位に丸めて返すサービスがあるため（YouTube で確認）、間隔の中央値を
// 周期とみなすと真の値（41.708ms に対し中央値 42ms）とずれ、コマ数を重ねるほど誤差が
// 積もる。仮周期で通し番号を振ってから直線に当てはめれば、丸めがあっても復元できる。
function fitGrid(mediaTimes: number[]): { periodMs: number; residualRmsMs: number; drops: number } | null {
  if (mediaTimes.length < 20) return null
  const diffs: number[] = []
  for (let i = 1; i < mediaTimes.length; i++) diffs.push(mediaTimes[i] - mediaTimes[i - 1])
  const median = [...diffs].sort((a, b) => a - b)[diffs.length >> 1]
  if (!(median > 0)) return null

  const n: number[] = [0]
  for (const d of diffs) n.push(n[n.length - 1] + Math.max(1, Math.round(d / median)))

  const N = mediaTimes.length
  let sn = 0, st = 0, snn = 0, snt = 0
  for (let i = 0; i < N; i++) { sn += n[i]; st += mediaTimes[i]; snn += n[i] * n[i]; snt += n[i] * mediaTimes[i] }
  const denom = N * snn - sn * sn
  if (denom === 0) return null
  const period = (N * snt - sn * st) / denom
  const base = (st - period * sn) / N

  let ss = 0
  for (let i = 0; i < N; i++) { const e = mediaTimes[i] - (period * n[i] + base); ss += e * e }
  return {
    periodMs: period * 1000,
    residualRmsMs: Math.sqrt(ss / N) * 1000,
    drops: n[n.length - 1] + 1 - N
  }
}

// トリムした新クリップ用にフレーム表を作り直す。
//
// フレーム表が持つのは「元ファイルの何枚目か」なので、切り出すとその番号は使えなくなる
// （先頭が削られて全体がずれ、再エンコードで枚数自体も変わりうる）。そこで一度
// 元ファイルの時刻へ戻し、切り出し範囲で絞ってから、新ファイルの時刻列へ対応付け直す。
//
// これをやらないとトリムした瞬間にコマ精度が失われる。切り出した箇所こそ細かく見たい
// はずなので、そこで精度が落ちるのは本末転倒になる。
export function sliceFrameTable(
  table: FrameMatch[],
  originalPts: number[],
  trimmedPts: number[],
  inSec: number
): FrameMatch[] {
  if (table.length === 0 || originalPts.length === 0 || trimmedPts.length === 0) return []
  // 境界ちょうどのコマを取りこぼさないための許容幅。1コマ（最短でも 1/120 秒）より
  // 十分小さく、浮動小数点の誤差より十分大きい値。
  const EPS = 0.001
  const lastPts = trimmedPts[trimmedPts.length - 1]

  const out: FrameMatch[] = []
  for (const f of table) {
    if (f.frameIndex < 0 || f.frameIndex >= originalPts.length) continue
    const shifted = originalPts[f.frameIndex] - inSec
    if (shifted < -EPS || shifted > lastPts + EPS) continue
    out.push({ mediaTime: f.mediaTime, frameIndex: nearestPtsIndex(trimmedPts, shifted), captured: f.captured })
  }
  return out
}

// pts の中で t に最も近い要素の添字。pts は昇順。
function nearestPtsIndex(pts: number[], t: number): number {
  let lo = 0, hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid] < t) lo = mid + 1
    else hi = mid
  }
  // lo は t 以上の最初の位置。1 つ手前の方が近ければそちらを選ぶ。
  if (lo > 0 && Math.abs(pts[lo - 1] - t) <= Math.abs(pts[lo] - t)) return lo - 1
  return lo
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

// 収集済みのコマ通知と撮影時刻から、保存用のフレーム表を作る。
export function buildFrameTable(drawnAt: number[]): MatchResult | null {
  return matchFrames(frames, drawnAt)
}

// 録画ごとに、素材のコマをどれだけ撮れたかを1行だけ残す。
//
// 画面キャプチャの供給は素材のコマ数の2倍に届かないため（実測 33〜41枚/秒）、
// 数%のコマは自分の表示区間内に絵が無い。絵の変わり目に当たるとコマ打ちの数を誤るので、
// どの録画でどれだけ落ちたかを後から追えるようにしておく。
//
// 出力は英語。dev.bat のコンソールは Shift-JIS のため日本語は文字化けする。
export function logMatchResult(result: MatchResult | null): void {
  if (!result) {
    console.log('[frame-match] no frame table (extension not connected / unsupported site)')
    return
  }
  const missing = result.matches.filter((m) => !m.captured).length
  console.log(
    `[frame-match] source ${result.sourceFrames} frames, captured ${(result.capturedRatio * 100).toFixed(1)}%` +
    ` (${missing} reuse the previous picture), capture offset ${result.offsetMs}ms`
  )
}
