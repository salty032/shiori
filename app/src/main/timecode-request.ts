import type { ExtensionMessage } from './ws-server'

export type CaptureTimecode = { title: string; currentTime: number | null; url: string | null; diagJson?: string | null }

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
      const value = { title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null, diagJson: msg.diagJson ?? null }
      if (msg.focused) finish(value)
      else fallback ??= value
    })
  })
}
