import { describe, it, expect } from 'vitest'
import { unscaleBilinear, UNSCALE_MAX_RESIDUAL } from './unscale'

// 元の絵（BGRA）。乱数の点と 1 画素の線を混ぜて、にじめば分かる絵にする。
function makeSource(w: number, h: number, seed = 1): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  let s = seed
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const line = x % 7 === 0 || y % 5 === 0
    for (let c = 0; c < 3; c++) buf[i + c] = line ? 20 : Math.round(80 + rnd() * 150)
    buf[i + 3] = 255
  }
  return buf
}

// ブラウザの映像の拡大と同じ形（画素の中心を合わせた bilinear、端は複製）で、
// 元の w × h を displayW × displayH に引き伸ばし、縁を inset 画素ずつ削って返す。
// unscale.ts の計算とは別に、素直な式で書く。
function browserUpscale(src: Buffer, w: number, h: number, displayW: number, displayH: number, inset: number) {
  const outW = displayW - 2 * inset
  const outH = displayH - 2 * inset
  const out = Buffer.alloc(outW * outH * 4)
  const clamp = (v: number, n: number): number => Math.min(Math.max(v, 0), n - 1)
  for (let oy = 0; oy < outH; oy++) for (let ox = 0; ox < outW; ox++) {
    const fx = (ox + inset + 0.5) * w / displayW - 0.5
    const fy = (oy + inset + 0.5) * h / displayH - 0.5
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const ax = fx - x0, ay = fy - y0
    for (let c = 0; c < 3; c++) {
      const p = (x: number, y: number): number => src[(clamp(y, h) * w + clamp(x, w)) * 4 + c]
      const v = (1 - ay) * ((1 - ax) * p(x0, y0) + ax * p(x0 + 1, y0)) + ay * ((1 - ax) * p(x0, y0 + 1) + ax * p(x0 + 1, y0 + 1))
      out[(oy * outW + ox) * 4 + c] = Math.round(v)
    }
    out[(oy * outW + ox) * 4 + 3] = 255
  }
  return { buf: out, w: outW, h: outH }
}

function nearestUpscale(src: Buffer, w: number, h: number, outW: number, outH: number): Buffer {
  const out = Buffer.alloc(outW * outH * 4)
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const sx = Math.floor(x * w / outW), sy = Math.floor(y * h / outH)
    src.copy(out, (y * outW + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4)
  }
  return out
}

function maxDiff(a: Buffer, b: Buffer): number {
  let m = 0
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

describe('unscaleBilinear', () => {
  const W = 64, H = 36
  const src = makeSource(W, H)

  it('全画面で 2 倍に引き伸ばされた絵から、元の絵に戻す', async () => {
    const up = browserUpscale(src, W, H, W * 2, H * 2, 0)
    const r = await unscaleBilinear(up.buf, up.w, up.h, W, H, 0)
    expect(r).not.toBeNull()
    expect(r!.residual).toBeLessThan(UNSCALE_MAX_RESIDUAL)
    expect(maxDiff(r!.bitmap, src)).toBeLessThanOrEqual(2)
  })

  it('割り切れない倍率（1.5 倍）でも戻す', async () => {
    const up = browserUpscale(src, W, H, 96, 54, 0)
    const r = await unscaleBilinear(up.buf, up.w, up.h, W, H, 0)
    expect(r!.residual).toBeLessThan(UNSCALE_MAX_RESIDUAL)
    expect(maxDiff(r!.bitmap, src)).toBeLessThanOrEqual(2)
  })

  it('窓で見ていて縁を削った絵でも、削った幅が分かれば戻す', async () => {
    const up = browserUpscale(src, W, H, 128, 72, 2)
    const r = await unscaleBilinear(up.buf, up.w, up.h, W, H, 2)
    expect(r!.residual).toBeLessThan(UNSCALE_MAX_RESIDUAL)
    // 縁の 1 画素は削った側にしか映っていないことがあるので、内側だけ比べる
    let m = 0
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let c = 0; c < 3; c++) {
      const i = (y * W + x) * 4 + c
      m = Math.max(m, Math.abs(r!.bitmap[i] - src[i]))
    }
    expect(m).toBeLessThanOrEqual(2)
  })

  // 想定と合わないときに使わないための確かめ。ここが通らないと、にじんだ絵や
  // ずれた絵を「戻せた」として保存してしまう。
  it('削った幅を取り違えると、差が大きく出て使われない', async () => {
    const up = browserUpscale(src, W, H, W * 2, H * 2, 0)
    const r = await unscaleBilinear(up.buf, up.w, up.h, W, H, 1)
    expect(r === null || r.residual > UNSCALE_MAX_RESIDUAL).toBe(true)
  })

  it('ブラウザの引き伸ばし方が違う（最近傍）と、差が大きく出て使われない', async () => {
    const up = nearestUpscale(src, W, H, 96, 54)
    const r = await unscaleBilinear(up, 96, 54, W, H, 0)
    expect(r === null || r.residual > UNSCALE_MAX_RESIDUAL).toBe(true)
  })

  it('撮った絵が元より小さければ戻さない', async () => {
    expect(await unscaleBilinear(src, W, H, W * 2, H * 2, 0)).toBeNull()
  })
})
