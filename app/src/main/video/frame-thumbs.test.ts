import { describe, expect, it } from 'vitest'
import { refineByThumbnails } from './frame-thumbs'
import type { FrameMatch } from './frame-feed'

// 絵 n は、乱数で塗った 32x32。録画の画像は同じ絵に明るさの幅の違いと乱れを足したもの。
function picture(n: number): Uint8Array {
  let seed = n * 7919 + 1
  return Uint8Array.from({ length: 1024 }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % 200 + 20
  })
}
function captured(n: number, noise = 2): Uint8Array {
  let seed = n * 31 + 5
  return Uint8Array.from(picture(n), (v) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return Math.round(16 + v * 0.85 + ((seed % (2 * noise + 1)) - noise))
  })
}
const b64 = (a: Uint8Array): string => Buffer.from(a).toString('base64')

// 素材のコマ k の絵 = drawing[k]。録画は 1 コマにつき 2 枚撮った（画像 2k, 2k+1 がコマ k）。
function scene(drawing: number[]): { signatures: Uint8Array[]; thumbs: Map<number, string>; truth: number[] } {
  const signatures = drawing.flatMap((d) => [captured(d), captured(d)])
  const thumbs = new Map(drawing.map((d, k) => [k / 24, b64(picture(d))]))
  return { signatures, thumbs, truth: drawing.map((_, k) => 2 * k) }
}
const rows = (picks: number[]): FrameMatch[] =>
  picks.map((frameIndex, k) => ({ mediaTime: k / 24, frameIndex, captured: true }))

describe('refineByThumbnails（控えの絵と録画の画像の照合）', () => {
  it('絵が切り替わる境目で隣のコマの画像を選んだ行を、そのコマの画像へ移す', () => {
    const s = scene([0, 1, 2, 3, 4, 5])
    // 3 行目と 5 行目が、1 つ前のコマの最後の画像を指している
    const picks = [0, 2, 3, 6, 7, 10]
    const r = refineByThumbnails(rows(picks), s.thumbs, s.signatures)
    for (const [k, m] of r.matches.entries()) {
      expect(Math.floor(m.frameIndex / 2)).toBe(k)
    }
  })

  it('同じ絵が続くコマ（コマ打ち）は動かさない', () => {
    const s = scene([0, 0, 1, 1, 2, 2])
    const picks = [0, 3, 4, 7, 8, 11]
    const r = refineByThumbnails(rows(picks), s.thumbs, s.signatures)
    expect(r.matches.map((m) => m.frameIndex)).toEqual(picks)
  })

  it('控えどうしの差が録画の乱れに埋もれるときは決めずに動かさない', () => {
    // 絵 1 と 2 の画像を、どちらにも見えるほど乱した録画
    const drawing = [0, 1, 2, 3]
    const signatures = drawing.flatMap((d) => [captured(d, 120), captured(d, 120)])
    const thumbs = new Map(drawing.map((d, k) => [k / 24, b64(picture(d))]))
    const picks = [0, 2, 4, 6]
    const r = refineByThumbnails(rows(picks), thumbs, signatures)
    expect(r.matches.map((m) => m.frameIndex)).toEqual(picks)
  })

  it('一度も写らなかったコマに、2 つ先のコマの画像を選ばない', () => {
    // コマ 2 の画像が録画に無い（撮る間隔がコマより長い 59.94fps で起きる）。候補にはコマ 1・3・4 の画像が入る。
    // テスト動画のように、絵の大半は共通で一部だけが違い、偶数のコマどうし・奇数のコマどうしがよく似ている。
    const base = picture(99)
    const alike = (n: number): Uint8Array => {
      const p = Uint8Array.from(base)
      const part = picture(1000 + (n % 2))
      const own = picture(n)
      for (let i = 0; i < 256; i++) p[i] = part[i]
      for (let i = 256; i < 320; i++) p[i] = own[i]
      return p
    }
    const shot = (n: number): Uint8Array => Uint8Array.from(alike(n), (v) => Math.round(16 + v * 0.85))
    // コマ 2・3 は一度も写らなかった。録画にはコマ 0・1・4・5 の画像だけがある
    const files = [0, 1, 4, 5]
    const signatures = files.map(shot)
    const thumbs = new Map([0, 1, 2, 3, 4, 5].map((n) => [n / 24, b64(alike(n))]))
    const r = refineByThumbnails(rows([0, 1, 1, 2, 2, 3]), thumbs, signatures)
    const shown = r.matches.map((m) => files[m.frameIndex])
    // コマ 2 にコマ 4 の絵を出さない
    expect(shown[2]).not.toBe(4)
  })

  it('控えの無いコマは時刻で選んだまま。並びは逆戻りさせない', () => {
    const s = scene([0, 1, 2, 3])
    s.thumbs.delete(2 / 24)
    const picks = [0, 1, 3, 6]
    const r = refineByThumbnails(rows(picks), s.thumbs, s.signatures)
    const idx = r.matches.map((m) => m.frameIndex)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    expect(Math.floor(idx[1] / 2)).toBe(1)
  })
})
