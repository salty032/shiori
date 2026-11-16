// <video> の「コマが 1 枚描かれた」知らせ（requestVideoFrameCallback）を受け取る口。
//
// ビューア（VideoPlayer）とトリミング画面（VideoTrimmer）が同じ書き方を 5 か所に持っていた。
// TypeScript の標準の型にこの API が無いので、毎回その場で型を付け直していた。
//
// **timeupdate で代用しない。** あちらは 1 秒に 4 回ほどしか来ないので、コマを追う用途では
// 現在位置のずれがそのまま誤読になる（トリミング画面では、終了位置を最大 250ms 過ぎてから戻る）。
export type VideoFrameMeta = { mediaTime: number }

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/** この環境で使えるか（Chromium 以外では無いことがある）。 */
export function supportsVideoFrameCallback(video: HTMLVideoElement): boolean {
  return typeof (video as FrameCallbackVideo).requestVideoFrameCallback === 'function'
}

/**
 * 次に描かれる 1 枚を、1 回だけ受け取る。
 * 使えない環境では何もせず false を返す（代わりにどうするかは呼び出し側が決める）。
 */
export function onNextVideoFrame(video: HTMLVideoElement, cb: (meta: VideoFrameMeta) => void): boolean {
  const v = video as FrameCallbackVideo
  if (typeof v.requestVideoFrameCallback !== 'function') return false
  v.requestVideoFrameCallback((_now, meta) => cb(meta))
  return true
}

/**
 * 止めるまで、描かれるたびに受け取る。戻り値を呼ぶと止まる。
 * 使えない環境では何もせず null を返す。
 */
export function watchVideoFrames(video: HTMLVideoElement, cb: (meta: VideoFrameMeta) => void): (() => void) | null {
  const v = video as FrameCallbackVideo
  if (typeof v.requestVideoFrameCallback !== 'function') return null
  let handle = 0
  let alive = true
  const tick = (_now: number, meta: VideoFrameMeta): void => {
    if (!alive) return
    cb(meta)
    handle = v.requestVideoFrameCallback!(tick)
  }
  handle = v.requestVideoFrameCallback(tick)
  return () => { alive = false; v.cancelVideoFrameCallback?.(handle) }
}
