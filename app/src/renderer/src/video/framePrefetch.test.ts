// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FramePrefetcher, rowsAhead } from './framePrefetch'

// 偽の動画。currentTime を変えると少し後に seeked を出す（stuck のときは出さない）。
// createImageBitmap は、その瞬間の currentTime を覚えた偽の絵を返す。
type FakeBitmap = { at: number; close: () => void; closed: boolean }
let fake: HTMLVideoElement & { stuck: boolean }
const bitmaps: FakeBitmap[] = []

beforeEach(() => {
  bitmaps.length = 0
  const realCreate = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'video') return realCreate(tag)
    const el = realCreate('video') as HTMLVideoElement & { stuck: boolean }
    let t = 0
    el.stuck = false
    Object.defineProperty(el, 'duration', { get: () => 10 })
    Object.defineProperty(el, 'currentTime', {
      get: () => t,
      set: (v: number) => { t = v; if (!el.stuck) setTimeout(() => el.dispatchEvent(new Event('seeked')), 1) },
    })
    el.load = () => {}
    setTimeout(() => el.dispatchEvent(new Event('loadeddata')), 0)
    fake = el
    return el
  }) as typeof document.createElement)
  vi.stubGlobal('createImageBitmap', vi.fn(async (v: HTMLVideoElement) => {
    const b: FakeBitmap = { at: v.currentTime, closed: false, close() { this.closed = true } }
    bitmaps.push(b)
    return b
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const targetOf = (row: number): number => row * 0.1 + 0.05

describe('FramePrefetcher', () => {
  it('頼んだ行の時刻（targetOf）へ飛んでから、その絵を作る', async () => {
    const pre = new FramePrefetcher('clip.webm', targetOf)
    const b = await pre.get(3) as unknown as FakeBitmap
    expect(b.at).toBeCloseTo(0.35, 9)
    pre.dispose()
  })

  it('先読みした絵は、もう一度頼んでも作り直さない', async () => {
    const pre = new FramePrefetcher('clip.webm', targetOf)
    pre.want([1, 2, 3])
    const b2 = await pre.get(2)
    const again = await pre.get(2)
    expect(again).toBe(b2)
    await pre.get(3)
    expect(bitmaps.map((b) => Math.round(b.at * 100))).toEqual([15, 25, 35])
    pre.dispose()
  })

  it('範囲から外れた行の絵は捨てる（メモリを数コマぶんに保つ）', async () => {
    const pre = new FramePrefetcher('clip.webm', targetOf)
    pre.want([1, 2])
    await pre.get(2)
    const first = bitmaps.find((b) => Math.round(b.at * 100) === 15)!
    pre.want([2, 3])
    expect(first.closed).toBe(true)
    pre.dispose()
  })

  it('飛び終わりの知らせが来なければ、その行は諦めて null（呼ぶ側は別のコマの絵を出さない）', async () => {
    vi.useFakeTimers()
    const pre = new FramePrefetcher('clip.webm', targetOf)
    await vi.advanceTimersByTimeAsync(1)
    fake.stuck = true
    const pending = pre.get(4)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBeNull()
    pre.dispose()
  })

  it('片付けたら、待っている取り出しは null で返り、作った絵は捨てる', async () => {
    const pre = new FramePrefetcher('clip.webm', targetOf)
    const made = await pre.get(1) as unknown as FakeBitmap
    fake.stuck = true
    const pending = pre.get(5)
    pre.dispose()
    expect(await pending).toBeNull()
    expect(made.closed).toBe(true)
  })
})

describe('rowsAhead（これから絵が要る行の並び）', () => {
  it('次の行から ahead 行ぶん', () => {
    expect(rowsAhead(3, 10, 4, false)).toEqual([4, 5, 6, 7])
  })
  it('ループしないなら最後の行で打ち切る', () => {
    expect(rowsAhead(8, 10, 4, false)).toEqual([9])
  })
  it('ループするなら頭へ回る', () => {
    expect(rowsAhead(8, 10, 4, true)).toEqual([9, 0, 1, 2])
  })
})
