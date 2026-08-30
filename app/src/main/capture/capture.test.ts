import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/userData') },
  screen: { getDisplayNearestPoint: vi.fn() },
  globalShortcut: { register: vi.fn(), unregister: vi.fn(), isRegistered: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() }
}))

import { computeVideoCrop, setBrowserWindowPos, setVideoRect, setBrowserFullscreen, resolveCaptureHeightLimit } from './capture'

type DisplayArg = Parameters<typeof computeVideoCrop>[2]

// computeVideoCrop は display.bounds の x/y/width しか読まないため、テストでは
// Electron.Display の他フィールドは省略して bounds だけ与える。
function display(bounds: { x: number; y: number; width: number; height: number }): DisplayArg {
  return { bounds } as unknown as DisplayArg
}

describe('computeVideoCrop', () => {
  // このテストだけは browserWindow/videoRect が一度も設定されていない初期状態に
  // 依存するため、他の it() より先に実行される必要がある（setBrowserWindowPos に
  // browserWindow を null へ戻す手段がないため）。
  it('browserWindow が未設定なら null', () => {
    expect(computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))).toBeNull()
  })

  it('videoRect が null なら null', () => {
    setBrowserWindowPos(100, 50, 1000, 700, 980, 650)
    setVideoRect(null)
    setBrowserFullscreen(false)
    expect(computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))).toBeNull()
  })

  it('DPR=1.0 の基本ケース', () => {
    setBrowserWindowPos(100, 50, 1000, 700, 980, 650)
    setVideoRect({ left: 50, top: 100, width: 800, height: 450 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 161, y: 191, w: 798, h: 448 })
  })

  it('DPR=1.25', () => {
    setBrowserWindowPos(100, 50, 1000, 700, 980, 650)
    setVideoRect({ left: 50, top: 100, width: 800, height: 450 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(2400, 1350, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 202, y: 240, w: 996, h: 559 })
  })

  it('DPR=1.5', () => {
    setBrowserWindowPos(100, 50, 1000, 700, 980, 650)
    setVideoRect({ left: 50, top: 100, width: 800, height: 450 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(2880, 1620, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 242, y: 287, w: 1196, h: 671 })
  })

  it('DPR=2.0', () => {
    setBrowserWindowPos(100, 50, 1000, 700, 980, 650)
    setVideoRect({ left: 50, top: 100, width: 800, height: 450 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(3840, 2160, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 322, y: 382, w: 1596, h: 896 })
  })

  it('縦タブブラウザ（左クロムが大きい）', () => {
    setBrowserWindowPos(100, 50, 1000, 700, 850, 650)
    setVideoRect({ left: 50, top: 100, width: 700, height: 450 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 293, y: 193, w: 698, h: 448 })
  })

  it('最大化時の DWM phantom 枠（ウィンドウ原点が画面外にはみ出す）', () => {
    setBrowserWindowPos(-8, -8, 1936, 1088, 1920, 1055)
    setVideoRect({ left: 100, top: 50, width: 1600, height: 900 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 101, y: 84, w: 1598, h: 898 })
  })

  it('フルスクリーンスナップ（動画がビューポートをほぼ埋めていて丸め誤差3px以内）', () => {
    setBrowserWindowPos(200, 100, 820, 462, 800, 450)
    setVideoRect({ left: 1, top: 1, width: 800, height: 449 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 200, y: 100, w: 800, h: 450 })
  })

  it('browserFullscreen フラグ明示時はクロム計算を無視する', () => {
    setBrowserWindowPos(0, 0, 1920, 1080, 1900, 1060)
    setVideoRect({ left: 10, top: 10, width: 1000, height: 600 })
    setBrowserFullscreen(true)
    const result = computeVideoCrop(1920, 1080, display({ x: 0, y: 0, width: 1920, height: 1080 }))
    expect(result).toEqual({ x: 10, y: 10, w: 1000, h: 600 })
  })

  it('クロップ領域が小さすぎる（幅10px以下）と null', () => {
    setBrowserWindowPos(0, 0, 800, 600, 800, 600)
    setVideoRect({ left: 0, top: 0, width: 5, height: 5 })
    setBrowserFullscreen(false)
    const result = computeVideoCrop(800, 600, display({ x: 0, y: 0, width: 800, height: 600 }))
    expect(result).toBeNull()
  })
})

// 静止画を保存するときの高さの上限。**「分からないときは縮めない」がこの関数の要**で、
// そこを崩すと、実寸を知らないまま本物の細かさを削る事故になる。
describe('resolveCaptureHeightLimit', () => {
  it("'screen' は実寸が分かっていても縮めない", () => {
    expect(resolveCaptureHeightLimit('screen', 1080)).toBeNull()
  })

  it("'source' は配信の実寸をそのまま上限にする（4K画面の1080p配信）", () => {
    expect(resolveCaptureHeightLimit('source', 1080)).toBe(1080)
  })

  it("'source' で配信が4Kなら 2160 のまま（削らない）", () => {
    expect(resolveCaptureHeightLimit('source', 2160)).toBe(2160)
  })

  it("'source' で実寸が分からなければ縮めない", () => {
    expect(resolveCaptureHeightLimit('source', null)).toBeNull()
    expect(resolveCaptureHeightLimit('source', 0)).toBeNull()
  })

  it("'fhd' は実寸が分からなくても 1080 で頭打ちにする（自分で選んだ上限なので効かせる）", () => {
    expect(resolveCaptureHeightLimit('fhd', null)).toBe(1080)
  })

  it("'fhd' でも配信が 720p なら 720（上限まで引き延ばして保存しない）", () => {
    expect(resolveCaptureHeightLimit('fhd', 720)).toBe(720)
  })

  it("'fhd' で配信が4Kなら 1080（ここだけは本物の細かさが落ちる）", () => {
    expect(resolveCaptureHeightLimit('fhd', 2160)).toBe(1080)
  })

  it("'hd' は 720 で頭打ち", () => {
    expect(resolveCaptureHeightLimit('hd', 2160)).toBe(720)
    expect(resolveCaptureHeightLimit('hd', null)).toBe(720)
  })
})
