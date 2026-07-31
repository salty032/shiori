// 配信ページから届く「素材の1コマ」通知の受け口。
//
// 録画クリップのコマ送りを素材の実コマと一致させるための土台。画面キャプチャ側の
// rVFC はコンポジタ駆動なので素材のコマとは無関係な枚数が出るが（実測: 23.976fps の
// 素材から 36.9fps 分のフレームが記録されていた）、配信ページの video の rVFC は
// 素材のコマごとにちょうど1回だけ発火する。その通知をここへ集約する。
//
// 現段階では収集と統計の出力のみを行い、録画の挙動は変えていない。
// 「通知が届いてから画面を1枚取るまでの遅延のばらつき」がコマ間隔の半分
// （23.976fps なら 20.8ms）を超えると隣のコマを撮ってしまうため、駆動源を差し替える
// 前にここで実測して設計の前提を確認する。
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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[i]
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

// 段階②の実測用。駆動源を差し替える前に、設計の前提が成り立つかを数字で確認する。
//
// 出力は英語。dev.bat のコンソールは Shift-JIS のため、日本語を出すと文字化けして読めない。
export function logFeedStats(): void {
  const L = (s: string): void => console.log(`[frame-feed] ${s}`)
  if (frames.length === 0) {
    L('no frames received (extension not connected / unsupported site / tab hidden)')
    return
  }

  const delays = frames.map((f) => f.receivedAt - f.displayAt)
  const sorted = [...delays].sort((a, b) => a - b)
  const median = quantile(sorted, 0.5)
  // 中央 90% の幅。単発の外れ値に振られずに「普段どれだけ揺れるか」を見る。
  const spread90 = quantile(sorted, 0.95) - quantile(sorted, 0.05)

  const grid = fitGrid(frames.map((f) => f.mediaTime))

  L('---- source frame feed ----')
  L(`frames: ${frames.length}`)
  L(`delay: median ${median.toFixed(1)}ms, p5..p95 spread ${spread90.toFixed(1)}ms, full range ${sorted[0].toFixed(1)}..${sorted[sorted.length - 1].toFixed(1)}ms`)

  if (!grid) {
    L('too few frames to estimate the source grid')
    L('---------------------------')
    return
  }

  const fps = 1000 / grid.periodMs
  const margin = grid.periodMs / 2
  L(`source: ${fps.toFixed(4)}fps (frame ${grid.periodMs.toFixed(4)}ms), grid residual ${grid.residualRmsMs.toFixed(3)}ms, dropped by player ${grid.drops}`)

  // 本当に効く指標はここ。一定の遅れは全コマが等しくずれるだけでコマ打ちの数え方を
  // 壊さないので、判定は「中央値からどれだけ外れたか」で行う。半コマ（±margin）を
  // 超えた通知は、その瞬間だけ隣のコマを撮る危険がある。
  const risky: number[] = []
  delays.forEach((d, i) => { if (Math.abs(d - median) > margin) risky.push(i) })

  if (risky.length === 0) {
    L(`outliers beyond +-${margin.toFixed(1)}ms: none`)
  } else {
    // 立ち上がりに集中しているのか録画中に散らばっているのかで意味が正反対になる。
    // 前者なら最初の数コマを捨てれば済むが、後者はその箇所のコマ打ちが壊れる。
    const startupCount = risky.filter((i) => i < 24).length
    const pct = (risky.length / delays.length) * 100
    L(`outliers beyond +-${margin.toFixed(1)}ms: ${risky.length} (${pct.toFixed(1)}%), of which ${startupCount} within the first 24 frames`)
    L(`outlier positions: ${risky.slice(0, 40).join(',')}${risky.length > 40 ? ' ...' : ''}`)
    L(`worst deviations: ${risky.slice(0, 8).map((i) => `#${i}:${(delays[i] - median).toFixed(0)}ms`).join(' ')}`)
  }

  // 立ち上がり（最初の24コマ＝約1秒）を除いた定常状態での危険コマ数が実質の判定材料。
  const steadyRisky = risky.filter((i) => i >= 24).length
  const verdict = steadyRisky === 0
    ? 'OK - steady state is clean, outliers (if any) are startup only'
    : steadyRisky <= delays.length * 0.005
      ? 'MARGINAL - rare mid-recording outliers, needs frame-index correction'
      : 'FAIL - outliers scattered through the recording, switch to offline matching'
  L(`verdict: ${verdict}`)
  L('---------------------------')
}

// 段階③の検証用。素材のコマと撮れたフレームの対応付けが成立したかを数字で出す。
export function logMatchResult(drawnAt: number[]): void {
  const L = (s: string): void => console.log(`[frame-match] ${s}`)
  const result = matchFrames(frames, drawnAt)
  if (!result) {
    L(`cannot match (source frames: ${frames.length}, drawn frames: ${drawnAt.length})`)
    return
  }
  L('---- source/capture matching ----')
  L(`source frames: ${result.sourceFrames}, drawn frames: ${result.drawnFrames} (oversampling x${(result.drawnFrames / result.sourceFrames).toFixed(2)})`)
  L(`capture offset: ${result.offsetMs}ms`)
  const missing = result.matches.filter((m) => !m.captured).length
  // 1.00 なら素材の全コマに専用の絵がある＝コマ送り1回で必ず絵が変わる。
  // 下回るぶんは直前のコマの絵を流用しており、そこが絵の変わり目だとコマ打ちを誤る。
  L(`source frames with their own captured picture: ${(result.capturedRatio * 100).toFixed(1)}% (${missing} reuse the previous frame)`)
  L('---------------------------------')
}
