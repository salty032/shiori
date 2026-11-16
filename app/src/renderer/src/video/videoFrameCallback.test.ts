import { describe, expect, it } from 'vitest'
import { onNextVideoFrame, supportsVideoFrameCallback, watchVideoFrames } from './videoFrameCallback'

// 描画の知らせを手で起こせる、にせの <video>。
function fakeVideo() {
  let next = 1
  const waiting = new Map<number, (now: number, meta: { mediaTime: number }) => void>()
  const video = {
    requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void): number {
      waiting.set(next, cb)
      return next++
    },
    cancelVideoFrameCallback(handle: number): void { waiting.delete(handle) },
  }
  // 待っている知らせを全部起こす（1 枚描かれた）。
  const paint = (mediaTime: number): void => {
    const due = [...waiting.values()]
    waiting.clear()
    for (const cb of due) cb(0, { mediaTime })
  }
  return { video: video as unknown as HTMLVideoElement, paint, waiting }
}

const unsupported = {} as HTMLVideoElement

describe('動画のコマが描かれた知らせ', () => {
  it('使えない環境では何もせず、使えなかったことを返す', () => {
    expect(supportsVideoFrameCallback(unsupported)).toBe(false)
    expect(onNextVideoFrame(unsupported, () => { throw new Error('呼ばれない') })).toBe(false)
    expect(watchVideoFrames(unsupported, () => { throw new Error('呼ばれない') })).toBeNull()
  })

  it('onNextVideoFrame は次の 1 枚だけを受け取る', () => {
    const { video, paint } = fakeVideo()
    const seen: number[] = []
    expect(onNextVideoFrame(video, (meta) => seen.push(meta.mediaTime))).toBe(true)
    paint(1.5)
    paint(2.5)
    expect(seen).toEqual([1.5])
  })

  it('watchVideoFrames は止めるまで毎回受け取る', () => {
    const { video, paint, waiting } = fakeVideo()
    const seen: number[] = []
    const stop = watchVideoFrames(video, (meta) => seen.push(meta.mediaTime))!
    paint(0.1)
    paint(0.2)
    stop()
    // 止めたら、待っていた知らせを取り消す。
    expect(waiting.size).toBe(0)
    paint(0.3)
    expect(seen).toEqual([0.1, 0.2])
  })

  // 取り消しが間に合わず、止めた後に知らせが 1 回届くことがある。そのときも受け取らない。
  it('止めた後に届いた知らせは受け取らず、次も頼まない', () => {
    const { video, waiting } = fakeVideo()
    const seen: number[] = []
    const stop = watchVideoFrames(video, (meta) => seen.push(meta.mediaTime))!
    const late = [...waiting.values()][0]
    stop()
    late(0, { mediaTime: 9 })
    expect(seen).toEqual([])
    expect(waiting.size).toBe(0)
  })
})
