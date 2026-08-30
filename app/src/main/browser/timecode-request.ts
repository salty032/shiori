import type { ExtensionMessage } from './ws-server'

// videoSize は映像そのものの画素数。**撮る直前の返事に入っていた値だけ**を静止画の
// 大きさの上限に使うため、ここに載せて運ぶ（定期送信で流れてくる値を拾うと、画質が
// 切り替わった直後に古い値で縮めてしまう）。返事が間に合わなければ null＝縮めない。
export type CaptureTimecode = {
  title: string
  currentTime: number | null
  url: string | null
  videoSize: { width: number; height: number } | null
}

type Subscribe = (handler: (msg: ExtensionMessage) => void) => () => void

// 複数の拡張クライアントが応答した場合はフォーカス中のものを優先する。
// フォーカス応答が無い場合だけ、最初の非フォーカス応答をタイムアウト時に採用する。
export function waitForPreferredTimecode(
  requestId: string,
  timeoutMs: number,
  subscribe: Subscribe
): Promise<CaptureTimecode | null> {
  return new Promise((resolve) => {
    let fallback: CaptureTimecode | null = null
    let settled = false
    let off = (): void => {}
    const finish = (value: CaptureTimecode | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    off = subscribe((msg) => {
      if (msg.type !== 'timecode' || msg.requestId !== requestId) return
      const value = { title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null, videoSize: msg.videoSize }
      if (msg.focused) finish(value)
      else fallback ??= value
    })
  })
}
