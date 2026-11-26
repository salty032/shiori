import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import { sameRect, samplePoints } from './occlusion'

describe('samplePoints', () => {
  it('動画の真ん中と、四隅から 1 割内側の 5 点を調べる', () => {
    expect(samplePoints({ x: 100, y: 50, width: 1000, height: 500 })).toEqual([
      { x: 600, y: 300 },
      { x: 200, y: 100 }, { x: 1000, y: 100 }, { x: 200, y: 500 }, { x: 1000, y: 500 },
    ])
  })
})

describe('sameRect', () => {
  it('拡張の outerWidth と Windows の枠の数え方の差くらいなら同じウィンドウとみなす', () => {
    expect(sameRect({ x: -8, y: -8, width: 1936, height: 1048 }, { x: 0, y: 0, width: 1920, height: 1040 })).toBe(true)
  })
  it('位置か大きさが大きく違えば別のウィンドウ', () => {
    expect(sameRect({ x: 300, y: 200, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1040 })).toBe(false)
  })
})
