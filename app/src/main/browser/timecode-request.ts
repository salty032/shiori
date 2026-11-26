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

export type TimecodeReply = Extract<ExtensionMessage, { type: 'timecode' }>

type Subscribe = (handler: (msg: ExtensionMessage) => void) => () => void

// 前面でないタブの返事しか来ていないとき、前面のタブの返事をあと何 ms 待つか。
//
// **静止画と録画で同じ待ち方を使う。** 以前は静止画が前面の返事を時間切れ（900ms）まで待ち、録画は
// 最初の返事を待たずに使っていた。モニター 2 枚で別のアプリを触りながら撮ると前面の返事は来ないので、
// 静止画は毎回 0.9 秒待ってから撮り（流れている動画なら押した瞬間より後のコマになる）、録画は動画の
// タブが複数あると別のタブの位置・作品名を拾いえた。
// 前面のタブも前面でないタブも同じ要求に同じ手順で返すので、届く差は小さい（[timecode] のログで見る）。
export const UNFOCUSED_GRACE_MS = 100

// 前面のタブの返事はすぐ使う。前面でない返事しか来なければ、最初の返事から UNFOCUSED_GRACE_MS 待って
// それを使う。何も来なければ timeoutMs で null。
export function waitForPreferredReply(
  requestId: string,
  timeoutMs: number,
  subscribe: Subscribe,
  graceMs = UNFOCUSED_GRACE_MS,
): Promise<TimecodeReply | null> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let fallback: TimecodeReply | null = null
    let fallbackAt = 0
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    let off = (): void => {}
    const finish = (value: TimecodeReply | null, why: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      off()
      const firstUnfocused = fallback ? `, first unfocused at ${fallbackAt - startedAt}ms` : ''
      console.log(`[timecode] ${why} after ${Date.now() - startedAt}ms${firstUnfocused}`)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback, fallback ? 'unfocused reply (timeout)' : 'no reply'), timeoutMs)
    off = subscribe((msg) => {
      if (msg.type !== 'timecode' || msg.requestId !== requestId) return
      if (msg.focused) { finish(msg, 'focused reply'); return }
      if (fallback) return
      fallback = msg
      fallbackAt = Date.now()
      graceTimer = setTimeout(() => finish(fallback, 'unfocused reply'), graceMs)
    })
  })
}

// 静止画用。返事のうち撮影に使う項目だけを返す。
export async function waitForPreferredTimecode(
  requestId: string,
  timeoutMs: number,
  subscribe: Subscribe,
): Promise<CaptureTimecode | null> {
  const msg = await waitForPreferredReply(requestId, timeoutMs, subscribe)
  return msg ? { title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null, videoSize: msg.videoSize } : null
}
