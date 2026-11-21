// ブラウザが引き伸ばして表示した配信の絵を、逆算して配信の元の大きさへ戻す。
//
// **普通に縮めると元の絵に戻らない。** ブラウザは配信の絵を bilinear で引き伸ばして表示し、
// それをもう一度縮めると、画素を 2 回混ぜたことになって小さい文字や細い線がにじむ
// （2026-11-20、アニメ風の試験の絵を 4K・1440p 相当に引き伸ばして縮めると、15% の画素が
// 元の絵からはっきりずれた。縮め方を変えてもほぼ同じ）。引き伸ばしの計算は分かっているので、
// 「引き伸ばすとこの撮った絵になる元の絵」を最小二乗で解けば、ほぼ元どおりに戻る
// （Electron・Edge・Firefox の 3 つで、ずれた画素が 0〜0.2% になった）。
//
// **引き伸ばし方が想定と違えば戻らないので、毎回確かめる。** 解いた絵を同じ計算で引き伸ばし直し、
// 撮った絵との差（residual）が大きければ使わない。呼び出し側は今までの縮め方に戻す。
//
// 縦横は別々に解ける（bilinear は縦と横の掛け算に分かれる）。1 本の行・列の式は、
// 引き伸ばしの行列 U（撮った画素 m × 元の画素 n）の正規方程式 UᵀU x = Uᵀy で、
// U の各行は隣り合う 2 つの元の画素にしか重みを持たないので UᵀU は三重対角になり、
// 1 本あたり O(n) で解ける。

// 引き伸ばし直した絵と撮った絵の差（RMS、0〜255 の段階）がこれ以下なら戻せたとみなす。
// 想定どおりの引き伸ばしでは 0.2 前後、枠が 1 画素ずれると数倍以上になる（unscale.test.ts）。
export const UNSCALE_MAX_RESIDUAL = 1.0

const SMOOTH_WEIGHT = 1e-4

// 4K で全部を一度に解くと約 0.5 秒かかり、その間 main の他の処理（拡張との通信・画面への返事）が
// 止まる。この本数ごとに一度、ほかの処理へ順番を譲る。
const LINES_PER_YIELD = 64
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Axis = {
  idx0: Int32Array
  idx1: Int32Array
  w0: Float64Array
  w1: Float64Array
  // 三重対角の UᵀU を LU に分解したもの（Thomas 法）
  diagInv: Float64Array
  lower: Float64Array
  upper: Float64Array
}

// 撮った m 画素が、元の n 画素を長さ display に引き伸ばした絵の offset 番目から並んでいるとき、
// 各撮った画素がどの 2 つの元の画素をどの重みで混ぜたか。画素の中心を合わせ、端は複製する
// （Chromium・Firefox の映像の拡大がこの形で、試験の絵で 60dB 一致した）。
function buildAxis(m: number, n: number, display: number, offset: number): Axis | null {
  const idx0 = new Int32Array(m)
  const idx1 = new Int32Array(m)
  const w0 = new Float64Array(m)
  const w1 = new Float64Array(m)
  const diag = new Float64Array(n)
  const off = new Float64Array(Math.max(0, n - 1))
  for (let j = 0; j < m; j++) {
    const x = (j + offset + 0.5) * n / display - 0.5
    const i = Math.floor(x)
    const f = x - i
    const a = Math.min(Math.max(i, 0), n - 1)
    const b = Math.min(Math.max(i + 1, 0), n - 1)
    idx0[j] = a; idx1[j] = b; w0[j] = 1 - f; w1[j] = f
    if (a === b) {
      diag[a] += 1
    } else {
      diag[a] += (1 - f) * (1 - f)
      diag[b] += f * f
      off[a] += (1 - f) * f
    }
  }
  // 隣り合う元の画素の差にごく弱い重みを足す。窓で見ていて縁を削ると、削った縁にしか
  // 映っていない元の画素は撮った絵のどこにも触れず、そのままでは解けない。この重みで
  // 隣とほぼ同じ値に埋まる。撮った絵に触れる画素では、重みが小さすぎて答えは変わらない。
  for (let i = 0; i < n - 1; i++) {
    diag[i] += SMOOTH_WEIGHT
    diag[i + 1] += SMOOTH_WEIGHT
    off[i] -= SMOOTH_WEIGHT
  }
  // Thomas 法の前進消去を、右辺に依らない部分だけ先に済ませる。
  const diagInv = new Float64Array(n)
  const lower = new Float64Array(n)
  const upper = off
  let prev = 0
  for (let i = 0; i < n; i++) {
    const l = i > 0 ? off[i - 1] * prev : 0
    const d = diag[i] - (i > 0 ? l * off[i - 1] : 0)
    if (!(d > 1e-12)) return null
    lower[i] = l
    diagInv[i] = 1 / d
    prev = diagInv[i]
  }
  return { idx0, idx1, w0, w1, diagInv, lower, upper }
}

// y（撮った 1 本、長さ m）から x（元の 1 本、長さ n）を解く。rhs は作業用の長さ n の配列。
function solveLine(ax: Axis, y: Float64Array, x: Float64Array, rhs: Float64Array): void {
  const n = x.length
  rhs.fill(0)
  for (let j = 0; j < y.length; j++) {
    rhs[ax.idx0[j]] += ax.w0[j] * y[j]
    rhs[ax.idx1[j]] += ax.w1[j] * y[j]
  }
  for (let i = 1; i < n; i++) rhs[i] -= ax.lower[i] * rhs[i - 1]
  x[n - 1] = rhs[n - 1] * ax.diagInv[n - 1]
  for (let i = n - 2; i >= 0; i--) x[i] = (rhs[i] - ax.upper[i] * x[i + 1]) * ax.diagInv[i]
}

export type UnscaleResult = {
  // BGRA、width × height
  bitmap: Buffer
  residual: number
}

// src は撮った絵（BGRA、srcW × srcH）。元の大きさ outW × outH へ戻す。
// inset は切り出しで表示された動画の縁から削った画素数（上下左右とも同じ。全画面なら 0）。
// 戻せない形（縮める側の比率・解けない）なら null。戻せたかどうかは residual で呼び出し側が決める。
export async function unscaleBilinear(
  src: Buffer, srcW: number, srcH: number,
  outW: number, outH: number, inset: number
): Promise<UnscaleResult | null> {
  if (outW < 2 || outH < 2 || srcW < outW || srcH < outH) return null
  const ax = buildAxis(srcW, outW, srcW + 2 * inset, inset)
  const ay = buildAxis(srcH, outH, srcH + 2 * inset, inset)
  if (!ax || !ay) return null

  // 横に解く: 撮った各行（srcH 本）→ 長さ outW
  const tmp = new Float64Array(srcH * outW * 3)
  {
    const y = new Float64Array(srcW)
    const x = new Float64Array(outW)
    const rhs = new Float64Array(outW)
    for (let r = 0; r < srcH; r++) {
      if (r % LINES_PER_YIELD === LINES_PER_YIELD - 1) await yieldToEventLoop()
      for (let c = 0; c < 3; c++) {
        const base = r * srcW * 4 + c
        for (let j = 0; j < srcW; j++) y[j] = src[base + j * 4]
        solveLine(ax, y, x, rhs)
        const tb = r * outW * 3 + c
        for (let i = 0; i < outW; i++) tmp[tb + i * 3] = x[i]
      }
    }
  }
  // 縦に解く: 各列（outW 本）→ 長さ outH
  const out = Buffer.alloc(outW * outH * 4)
  {
    const y = new Float64Array(srcH)
    const x = new Float64Array(outH)
    const rhs = new Float64Array(outH)
    for (let col = 0; col < outW; col++) {
      if (col % LINES_PER_YIELD === LINES_PER_YIELD - 1) await yieldToEventLoop()
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < srcH; r++) y[r] = tmp[(r * outW + col) * 3 + c]
        solveLine(ay, y, x, rhs)
        for (let r = 0; r < outH; r++) {
          const v = Math.round(x[r])
          out[(r * outW + col) * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v
        }
      }
      for (let r = 0; r < outH; r++) out[(r * outW + col) * 4 + 3] = 255
    }
  }

  await yieldToEventLoop()
  return { bitmap: out, residual: await reupscaleResidual(out, outW, outH, src, srcW, srcH, ax, ay) }
}

// 解いた絵を同じ計算で引き伸ばし直し、撮った絵との差の RMS を返す。
async function reupscaleResidual(
  out: Buffer, outW: number, outH: number,
  src: Buffer, srcW: number, srcH: number,
  ax: Axis, ay: Axis
): Promise<number> {
  // 横に引き伸ばす: 元の各行（outH 本）→ 長さ srcW
  const wide = new Float64Array(outH * srcW * 3)
  for (let r = 0; r < outH; r++) {
    const ob = r * outW * 4
    const wb = r * srcW * 3
    for (let j = 0; j < srcW; j++) {
      const a = ob + ax.idx0[j] * 4
      const b = ob + ax.idx1[j] * 4
      const w0 = ax.w0[j], w1 = ax.w1[j]
      for (let c = 0; c < 3; c++) wide[wb + j * 3 + c] = w0 * out[a + c] + w1 * out[b + c]
    }
  }
  await yieldToEventLoop()
  let se = 0
  for (let r = 0; r < srcH; r++) {
    if (r % LINES_PER_YIELD === LINES_PER_YIELD - 1) await yieldToEventLoop()
    const a = ay.idx0[r] * srcW * 3
    const b = ay.idx1[r] * srcW * 3
    const w0 = ay.w0[r], w1 = ay.w1[r]
    const sb = r * srcW * 4
    for (let j = 0; j < srcW; j++) {
      for (let c = 0; c < 3; c++) {
        const d = w0 * wide[a + j * 3 + c] + w1 * wide[b + j * 3 + c] - src[sb + j * 4 + c]
        se += d * d
      }
    }
  }
  return Math.sqrt(se / (srcW * srcH * 3))
}
