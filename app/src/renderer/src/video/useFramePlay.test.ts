// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipFrames } from '../../../shared/api.video'

// コマ再生の本体（useFramePlay）。先読みの部品は差し替え、絵ができる時期をテストから決める。
// 固定するのは .claude/rules/frames.md「ビューアのコマ送り」の決まり：重ねる絵の行は moveFrames と同じ
// 口（peekNextRow）で決め、飛ばし先は表の動画と同じ計算、間に合わなければ番号を進めずに待つ。

const { FakePrefetcher, created } = vi.hoisted(() => {
  type Pending = { resolve: (b: unknown) => void; promise: Promise<unknown> }
  const created: InstanceType<typeof FakePrefetcher>[] = []
  class FakePrefetcher {
    gets: number[] = []
    pending = new Map<number, Pending>()
    constructor(public src: string, public targetOf: (row: number) => number) { created.push(this) }
    want(): void {}
    get(row: number): Promise<unknown> {
      this.gets.push(row)
      let p = this.pending.get(row)
      if (!p) {
        let resolve!: (b: unknown) => void
        const promise = new Promise<unknown>((r) => { resolve = r })
        p = { resolve, promise }
        this.pending.set(row, p)
      }
      return p.promise
    }
    dispose(): void {}
  }
  return { FakePrefetcher, created }
})
vi.mock('./framePrefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./framePrefetch')>()),
  FramePrefetcher: FakePrefetcher,
}))

import { useFramePlay } from './useFramePlay'

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setup(opts: { frames: ClipFrames | null; start: number; peek?: (cur: number) => number; duration?: number; loop?: boolean }) {
  let cur = opts.start
  const video = document.createElement('video')
  Object.defineProperty(video, 'duration', { get: () => opts.duration ?? 10 })
  Object.defineProperty(video, 'seeking', { get: () => false })
  video.pause = () => {}
  const canvas = document.createElement('canvas')
  const moveFrames = vi.fn(() => { cur = (opts.peek ?? ((c: number) => c + 1))(cur) })
  const actions = {
    moveFrames,
    goToFrame: vi.fn((i: number) => { cur = i }),
    currentFrameIdx: () => cur,
    peekNextRow: () => (opts.peek ?? ((c: number) => c + 1))(cur),
    stepSec: 0.1,
  }
  const setFramePlay = vi.fn()
  renderHook(() => useFramePlay({
    videoRef: { current: video }, id: 1, framePlay: true, setFramePlay, speed: 0.1,
    loopRef: { current: opts.loop ?? false }, readoutRef: { current: 'source' },
    framesRef: { current: opts.frames }, overlayRef: { current: canvas }, actionsRef: { current: actions },
  }))
  return { canvas, moveFrames, setFramePlay, getCur: () => cur }
}

const frames4: ClipFrames = { pts: [0, 0.1, 0.2, 0.3], dur: [0.1, 0.1, 0.1, 0.1], sourceBased: true, quality: [0, 0, 0, 0] }
const bitmap = { width: 4, height: 4 }

beforeEach(() => {
  created.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useFramePlay（コマ再生の先読み）', () => {
  it('次に出す行は peekNextRow で決め、その行の絵ができるまで番号を進めない', async () => {
    const { moveFrames, canvas } = setup({ frames: frames4, start: 0 })
    await flush()
    const pre = created[0]
    expect(pre.gets).toEqual([1])
    expect(moveFrames).not.toHaveBeenCalled()
    expect(canvas.style.visibility).not.toBe('visible')
    pre.pending.get(1)!.resolve(bitmap)
    await flush()
    expect(moveFrames).toHaveBeenCalledTimes(1)
    expect(canvas.style.visibility).toBe('visible')
  })

  it('飛ばし先は表の動画と同じ計算（そのコマ自身の長さの中央）', async () => {
    setup({ frames: { ...frames4, dur: [0.1, 0.04, 0.1, 0.1] }, start: 0 })
    await flush()
    expect(created[0].targetOf(1)).toBeCloseTo(0.1 + 0.02, 9)
  })

  it('抜けの中へ進むとき（絵が変わらないとき）は、絵を頼まずに番号だけ進める', async () => {
    const { moveFrames } = setup({ frames: frames4, start: 0, peek: (c) => c })
    await flush()
    expect(created[0].gets).toEqual([])
    expect(moveFrames).toHaveBeenCalledTimes(1)
  })

  it('絵を作れなかった行は重ねず、下の動画で映す（別のコマの絵は出さない）', async () => {
    const { moveFrames, canvas } = setup({ frames: frames4, start: 0 })
    await flush()
    created[0].pending.get(1)!.resolve(null)
    await flush()
    expect(moveFrames).toHaveBeenCalledTimes(1)
    expect(canvas.style.visibility).not.toBe('visible')
  })

  it('最後の行まで来たら、ループしなければ止める', async () => {
    const { setFramePlay } = setup({ frames: frames4, start: 2 })
    await flush()
    created[0].pending.get(3)!.resolve(bitmap)
    await flush(150)
    expect(setFramePlay).toHaveBeenCalledWith(false)
  })

  it('コマの時刻が分からないときは、fps で数えたコマの真ん中の絵を作る', async () => {
    const video = setup({ frames: null, start: 0, duration: 1 })
    void video
    await flush()
    expect(created[0].targetOf(3)).toBeCloseTo(0.35, 9)
  })
})
